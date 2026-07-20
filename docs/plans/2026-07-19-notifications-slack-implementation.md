# Notifications Event Bus + Slack Destination — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a new issue (error group) is created, publish an `issue.created` event to a Postgres transactional outbox and deliver it to per-project Slack incoming webhooks, with an extensible destination/event-type model.

**Architecture:** Go ingestion publishes event + delivery rows inside the ingest transaction (`InsertErrorEventAndGroup` `is_new` branch). A dispatcher goroutine in ingestion claims deliveries with a lease + fencing token (mirroring `error_group_jobs`), formats Slack Block Kit, POSTs with retry classification, and reaps expired leases. Config lives in an encrypted `notification_destinations` table managed via new project-scoped API routes and a dashboard "Integrations" tab.

**Design doc (authoritative for all semantics):** `docs/plans/2026-07-19-notifications-event-bus-slack-design.md` — read it first. Where this plan and the design disagree, the design wins.

**Tech Stack:** Go 1.24 (chi, pgx, x/crypto/hkdf), Postgres, Vue 3 + TS dashboard, Vitest.

**Conventions you must follow:**
- Go DB tests use `testPool(t)` (`packages/ingestion/db/testhelper_test.go`) — they skip when Postgres isn't reachable. Handler integration tests skip when `DATABASE_URL` is unset (`error_event_test.go` `testDeps`). **A skipped test is not a passing test — always confirm the output says `PASS`, not `SKIP`.**
- Environment for every Go test run in this plan:
  ```bash
  docker compose up -d postgres
  export DATABASE_URL='postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable'
  ```
- **Applying migrations to the shared test DB**: `TestMigrations_*` run against *disposable* databases they create and drop — they do NOT migrate the shared DB. After creating migration 018, apply it to the shared DSN with `docker compose run --rm migrate` (the compose migrate service re-applies all migrations idempotently) before any Task-5+ test.
- Tests must clean up via org-scoped cleanup (see `queries_test.go` `seedGroup` + `cleanupTenant`). Never truncate shared tables. `cleanupTenant` is package-private to `db_test` — Tasks 5–9 update it and add per-package equivalents (called out in each task).
- Every commit step: `git add <files> && git commit -m "..."` — stage the exact files you touched, never `git add -A`.
- All new Go files in `packages/ingestion` are AGPL-3.0-only (no license header needed; repo-level).
- The repo has a **docs-drift gate** (`scripts/check-docs-drift.mjs`) that fails when registered routes are missing from `docs/reference/http-routes.md` — Task 10 updates it.
- Verification gate at the end: `go build ./... && go test ./...` in `packages/ingestion`, `pnpm -r build && pnpm test` at the root, then the live smoke.

---

### Task 1: Migration `018_notifications.sql`

**Files:**
- Create: `packages/ingestion/db/migrations/018_notifications.sql`

**Step 1: Write the migration** (idempotent — it is re-applied on every boot):

```sql
-- 018_notifications.sql
-- Notification event bus: destinations (encrypted config), outbox events,
-- and leased deliveries. See docs/plans/2026-07-19-notifications-event-bus-slack-design.md

CREATE TABLE IF NOT EXISTS notification_destinations (
  id UUID PRIMARY KEY,                         -- generated app-side (bound into encryption AAD)
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL DEFAULT 'slack' CHECK (type IN ('slack')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  config_encrypted BYTEA NOT NULL,
  config_fingerprint TEXT NOT NULL,
  event_types TEXT[] NOT NULL DEFAULT '{issue.created}'
    CHECK (cardinality(event_types) >= 1 AND event_types <@ ARRAY['issue.created']),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_destinations_project
  ON notification_destinations(project_id);

CREATE TABLE IF NOT EXISTS outbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('issue.created')),
  dedup_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, dedup_key)
);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES outbound_events(id) ON DELETE CASCADE,
  destination_id UUID NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, destination_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_claimable
  ON outbound_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_stale
  ON outbound_deliveries(lease_expires_at) WHERE status = 'delivering';
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_event
  ON outbound_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_destination_updated
  ON outbound_deliveries(destination_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_prune
  ON outbound_deliveries(updated_at) WHERE status <> 'pending';
```

**Step 2: Verify idempotency via the existing re-apply test**

Run: `cd packages/ingestion && go test ./db -run TestMigrations -v`
Expected: PASS (the test applies every migration file twice on a disposable DB; a non-idempotent 018 fails here).

**Step 3: Apply 018 to the shared test DB** (the migration tests do NOT do this):

Run: `docker compose run --rm migrate`
Then verify: `psql "$DATABASE_URL" -c '\d notification_destinations'` shows the table.

**Step 4: Update `cleanupTenant`** in `packages/ingestion/db/testhelper_test.go`: before the existing project-scoped deletes, add (in this order, respecting FKs):

```go
_, _ = pool.Exec(ctx, `DELETE FROM outbound_deliveries WHERE destination_id IN
    (SELECT id FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1))`, orgID)
_, _ = pool.Exec(ctx, `DELETE FROM outbound_events WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, orgID)
_, _ = pool.Exec(ctx, `DELETE FROM notification_destinations WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)`, orgID)
```

(Match the exact style/error handling of the existing deletes in that function.)

**Step 5: Commit** — `git add packages/ingestion/db/migrations/018_notifications.sql packages/ingestion/db/testhelper_test.go && git commit -m "feat(notifications): add outbox + destinations schema (migration 018)"`

---

### Task 2: Config crypto helper (`notify` package)

Seal/open destination config with AES-256-GCM. Key = HKDF-SHA256 over `JWT_SECRET`, info label `opslane/notification-destination-config/v1`. Blob = `nonce(12) || ciphertext`. AAD = `destinationID + "|" + projectID + "|" + type`.

**Files:**
- Create: `packages/ingestion/notify/crypto.go`
- Test: `packages/ingestion/notify/crypto_test.go`

**Step 1: Write the failing tests**

```go
package notify

import (
	"strings"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef" // >= 32 bytes

func TestSealOpenRoundTrip(t *testing.T) {
	c, err := NewConfigCipher([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	aad := ConfigAAD("dest-1", "proj-1", "slack")
	blob, err := c.Seal([]byte(`{"webhook_url":"https://hooks.slack.com/services/T/B/x"}`), aad)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Open(blob, aad)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "hooks.slack.com") {
		t.Fatalf("round trip mismatch: %s", got)
	}
}

func TestOpenRejectsTransplantedAAD(t *testing.T) {
	c, _ := NewConfigCipher([]byte(testSecret))
	blob, _ := c.Seal([]byte(`{"webhook_url":"u"}`), ConfigAAD("dest-1", "proj-1", "slack"))
	if _, err := c.Open(blob, ConfigAAD("dest-2", "proj-1", "slack")); err == nil {
		t.Fatal("expected AAD mismatch to fail")
	}
	if _, err := c.Open(blob, ConfigAAD("dest-1", "proj-OTHER", "slack")); err == nil {
		t.Fatal("expected cross-project transplant to fail")
	}
}

func TestNewConfigCipherRejectsShortSecret(t *testing.T) {
	if _, err := NewConfigCipher([]byte("short")); err == nil {
		t.Fatal("expected short secret rejection")
	}
}
```

**Step 2: Run to verify failure** — `go test ./notify -run 'Seal|Open|Cipher' -v` → FAIL (package missing).

**Step 3: Implement `crypto.go`**

```go
// Package notify implements the notification event bus: destination config
// crypto, Slack formatting, and the outbox delivery dispatcher.
package notify

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const configKeyInfo = "opslane/notification-destination-config/v1"

// ConfigCipher seals destination config JSON at rest. The webhook URL is a
// credential; it never touches the database in plaintext.
type ConfigCipher struct{ aead cipher.AEAD }

func NewConfigCipher(jwtSecret []byte) (*ConfigCipher, error) {
	if len(jwtSecret) < 32 {
		return nil, fmt.Errorf("jwt secret too short for key derivation")
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, jwtSecret, nil, []byte(configKeyInfo)), key); err != nil {
		return nil, fmt.Errorf("hkdf: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &ConfigCipher{aead: aead}, nil
}

// ConfigAAD binds a ciphertext to its row so it cannot be transplanted
// across destinations, projects, or types.
func ConfigAAD(destinationID, projectID, destType string) []byte {
	return []byte(destinationID + "|" + projectID + "|" + destType)
}

// Seal returns nonce(12) || GCM ciphertext.
func (c *ConfigCipher) Seal(plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return c.aead.Seal(nonce, nonce, plaintext, aad), nil
}

func (c *ConfigCipher) Open(blob, aad []byte) ([]byte, error) {
	ns := c.aead.NonceSize()
	if len(blob) < ns+1 {
		return nil, fmt.Errorf("ciphertext too short")
	}
	return c.aead.Open(nil, blob[:ns], blob[ns:], aad)
}
```

**Step 4: Run tests** → PASS.

**Step 5: Commit** — `git add packages/ingestion/notify/crypto.go packages/ingestion/notify/crypto_test.go && git commit -m "feat(notifications): AES-GCM config cipher with row-bound AAD"`

---

### Task 3: Webhook URL validation

**Files:**
- Create: `packages/ingestion/notify/validate.go`
- Test: `packages/ingestion/notify/validate_test.go`

**Step 1: Failing tests** — table-driven:

```go
package notify

import "testing"

func TestValidateSlackWebhookURL(t *testing.T) {
	cases := []struct {
		name, url string
		extra     []string // NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS entries
		ok        bool
	}{
		{"valid", "https://hooks.slack.com/services/T0/B0/xyz", nil, true},
		{"valid explicit port", "https://hooks.slack.com:443/services/T0/B0/xyz", nil, true},
		{"http scheme", "http://hooks.slack.com/services/T0/B0/x", nil, false},
		{"wrong host", "https://evil.example.com/services/x", nil, false},
		{"subdomain trick", "https://hooks.slack.com.evil.com/x", nil, false},
		{"userinfo", "https://a:b@hooks.slack.com/services/x", nil, false},
		{"odd port", "https://hooks.slack.com:8443/services/x", nil, false},
		{"empty path", "https://hooks.slack.com", nil, false},
		{"not a url", "::::", nil, false},
		{"extra host http allowed", "http://host.docker.internal:9999/hook", []string{"host.docker.internal:9999"}, true},
		{"extra host wrong port", "http://host.docker.internal:1/hook", []string{"host.docker.internal:9999"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateSlackWebhookURL(tc.url, tc.extra)
			if (err == nil) != tc.ok {
				t.Fatalf("url %q extra %v: got err=%v want ok=%v", tc.url, tc.extra, err, tc.ok)
			}
		})
	}
}

func TestFingerprintURL(t *testing.T) {
	got := FingerprintURL("https://hooks.slack.com/services/T0/B0/secretpart")
	want := "hooks.slack.com/…/****part"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
```

**Step 2: Verify FAIL.**

**Step 3: Implement `validate.go`**

```go
package notify

import (
	"fmt"
	"net/url"
)

const slackWebhookHost = "hooks.slack.com"

// ValidateSlackWebhookURL enforces the slack destination allowlist.
// extraHosts (from NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS, dev/test only) are
// exact "host[:port]" matches and may use plain http.
func ValidateSlackWebhookURL(raw string, extraHosts []string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL")
	}
	if u.User != nil {
		return fmt.Errorf("URL must not contain credentials")
	}
	if u.Path == "" || u.Path == "/" {
		return fmt.Errorf("missing webhook path")
	}
	for _, h := range extraHosts {
		if h != "" && u.Host == h && (u.Scheme == "http" || u.Scheme == "https") {
			return nil
		}
	}
	if u.Scheme != "https" {
		return fmt.Errorf("scheme must be https")
	}
	if u.Hostname() != slackWebhookHost {
		return fmt.Errorf("host must be %s", slackWebhookHost)
	}
	if p := u.Port(); p != "" && p != "443" {
		return fmt.Errorf("unexpected port")
	}
	return nil
}

// FingerprintURL is the masked display form stored in config_fingerprint.
// List endpoints render this; the real URL is write-only.
func FingerprintURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "invalid"
	}
	tail := raw
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return u.Host + "/…/****" + tail
}
```

**Step 4: PASS. Step 5: Commit** — `git add packages/ingestion/notify/validate.go packages/ingestion/notify/validate_test.go && git commit -m "feat(notifications): slack webhook URL validation + fingerprint"`

---

### Task 4: Slack Block Kit formatter

**Files:**
- Create: `packages/ingestion/notify/slack.go`
- Test: `packages/ingestion/notify/slack_test.go`

Payload type shared by publisher/formatter — define in `packages/ingestion/notify/event.go`:

```go
package notify

// EventPayload is the versioned, add-only issue.created payload (design doc
// "Payload"). It later becomes the public generic-webhook body.
type EventPayload struct {
	Version     int          `json:"version"`
	EventType   string       `json:"event_type"`
	Issue       IssueRef     `json:"issue"`
	Project     ProjectRef   `json:"project"`
	Environment string       `json:"environment"`
	DashboardURL string      `json:"dashboard_url,omitempty"`
}

type IssueRef struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	FirstSeen string `json:"first_seen"`
}

type ProjectRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
```

**Step 1: Failing tests** — assert masking (uses `masking.RedactBody`/`RedactURL`), Slack escaping (`& < >`), backtick stripping, truncation (header ≤150, section ≤2900), button omitted without URL. Include an injection title:

```go
package notify

import (
	"encoding/json"
	"strings"
	"testing"
)

func samplePayload(title, dashURL string) EventPayload {
	return EventPayload{
		Version: 1, EventType: "issue.created",
		Issue:   IssueRef{ID: "g1", Title: title, FirstSeen: "2026-07-19T00:00:00Z"},
		Project: ProjectRef{ID: "p1", Name: "storefront"},
		Environment: "production", DashboardURL: dashURL,
	}
}

func TestSlackFormatEscapesAndTruncates(t *testing.T) {
	body, ct, err := FormatSlack(samplePayload("<!channel> *bold* `tick` a&b <script>", "https://app.example.com/incidents/g1?project_id=p1"))
	if err != nil {
		t.Fatal(err)
	}
	if ct != "application/json" {
		t.Fatalf("content type %s", ct)
	}
	s := string(body)
	if strings.Contains(s, "<!channel>") {
		t.Fatal("mrkdwn injection not escaped")
	}
	if !strings.Contains(s, "&amp;") || !strings.Contains(s, "&lt;") {
		t.Fatal("missing slack escaping")
	}
	var blocks map[string]any
	if err := json.Unmarshal(body, &blocks); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if !strings.Contains(s, "View in Opslane") {
		t.Fatal("missing action button")
	}
}

func TestSlackFormatOmitsButtonWithoutURL(t *testing.T) {
	body, _, _ := FormatSlack(samplePayload("t", ""))
	if strings.Contains(string(body), "View in Opslane") {
		t.Fatal("button must be omitted without dashboard_url")
	}
}

func TestSlackFormatLongTitleTruncated(t *testing.T) {
	body, _, _ := FormatSlack(samplePayload(strings.Repeat("x", 5000), ""))
	var doc struct {
		Blocks []map[string]any `json:"blocks"`
	}
	_ = json.Unmarshal(body, &doc)
	// no field longer than Slack's 3000-char section limit
	if len(string(body)) == 0 || strings.Contains(string(body), strings.Repeat("x", 2950)) {
		t.Fatal("title not truncated")
	}
}
```

**Step 2: FAIL. Step 3: Implement `slack.go`** — masking first, then escape, then truncate:

```go
package notify

import (
	"encoding/json"
	"strings"

	"github.com/opslane/opslane/packages/ingestion/masking"
)

const (
	headerMax  = 150
	sectionMax = 2900
)

// slackEscape implements Slack's mandatory escaping for mrkdwn text.
func slackEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// truncate is rune-safe: slicing bytes can split a UTF-8 sequence and Slack
// rejects invalid UTF-8.
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

// FormatSlack renders the Block Kit body for one issue.created event.
// Titles are attacker-influenced: masked (same egress scrubbing as
// breadcrumbs at ingest), escaped, backticks stripped, truncated.
func FormatSlack(p EventPayload) (body []byte, contentType string, err error) {
	title := masking.RedactURL(masking.RedactBody(p.Issue.Title))
	title = strings.ReplaceAll(title, "`", "'")
	title = truncate(slackEscape(title), sectionMax)

	blocks := []map[string]any{
		{
			"type": "header",
			"text": map[string]any{"type": "plain_text", "text": truncate("New issue in "+p.Project.Name, headerMax), "emoji": true},
		},
		{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": "`" + title + "`"},
			"fields": []map[string]any{
				{"type": "mrkdwn", "text": "*Environment:*\n" + slackEscape(p.Environment)},
				{"type": "mrkdwn", "text": "*First seen:*\n" + slackEscape(p.Issue.FirstSeen)},
			},
		},
	}
	if p.DashboardURL != "" {
		blocks = append(blocks, map[string]any{
			"type": "actions",
			"elements": []map[string]any{{
				"type": "button",
				"text": map[string]any{"type": "plain_text", "text": "View in Opslane"},
				"url":  p.DashboardURL,
			}},
		})
	}
	body, err = json.Marshal(map[string]any{"blocks": blocks})
	return body, "application/json", err
}
```

**Step 4: Define the Formatter interface + registry** (the design's extensibility seam — the dispatcher and the handler test-endpoint both resolve formatters through it). Add to `packages/ingestion/notify/event.go`:

```go
// Formatter renders the outbound HTTP request body for one event.
type Formatter interface {
	Format(p EventPayload) (body []byte, contentType string, err error)
}

type formatterFunc func(EventPayload) ([]byte, string, error)

func (f formatterFunc) Format(p EventPayload) ([]byte, string, error) { return f(p) }

// Formatters maps destination type → formatter. New destination types
// register here.
var Formatters = map[string]Formatter{
	"slack": formatterFunc(FormatSlack),
}
```

Add a test asserting `Formatters["slack"]` exists and formats. Strengthen the earlier tests to actually assert lengths: unmarshal the body, assert the header text ≤150 runes and the section text ≤3000 runes, and assert the raw webhook-ish input string is absent.

**Step 5: All formatter tests PASS. Step 6: Commit** — `git add packages/ingestion/notify/slack.go packages/ingestion/notify/slack_test.go packages/ingestion/notify/event.go && git commit -m "feat(notifications): slack Block Kit formatter with masking + escaping"`

---

### Task 5: Destination CRUD queries (db layer)

**Files:**
- Create: `packages/ingestion/db/notifications.go`
- Test: `packages/ingestion/db/notifications_test.go`

All queries org-scoped (join projects → org) per `packages/ingestion/AGENTS.md`. Types:

```go
package db

import (
	"context"
	"fmt"
	"time"
)

type NotificationDestination struct {
	ID                string
	ProjectID         string
	Type              string
	Name              string
	ConfigEncrypted   []byte
	ConfigFingerprint string
	EventTypes        []string
	Enabled           bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
	// Delivery health (list only; zero-valued elsewhere)
	LastDeliveryStatus *string
	LastDeliveryAt     *time.Time
	LastDeliveryError  *string
	RecentFailures     int
}
```

Functions to implement (each `WHERE p.org_id = $orgID` via join, returning `pgx.ErrNoRows`-derived not-found):

- `CreateNotificationDestination(ctx, orgID, projectID string, d NotificationDestination) (*NotificationDestination, error)` — INSERT with app-provided `d.ID`.
- `ListNotificationDestinations(ctx, orgID, projectID string) ([]NotificationDestination, error)` — LEFT JOIN LATERAL for last delivery (uses `idx_outbound_deliveries_destination_updated`):

```sql
SELECT d.id, d.project_id, d.type, d.name, d.config_encrypted, d.config_fingerprint,
       d.event_types, d.enabled, d.created_at, d.updated_at,
       ld.status, ld.updated_at, ld.last_error,
       COALESCE(f.cnt, 0)
FROM notification_destinations d
JOIN projects p ON p.id = d.project_id AND p.org_id = $1
LEFT JOIN LATERAL (
  SELECT status, updated_at, last_error FROM outbound_deliveries
  WHERE destination_id = d.id ORDER BY updated_at DESC LIMIT 1
) ld ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS cnt FROM outbound_deliveries
  WHERE destination_id = d.id AND status = 'failed'
    AND updated_at > now() - interval '7 days'
) f ON true
WHERE d.project_id = $2
ORDER BY d.created_at
```

- `GetNotificationDestination(ctx, orgID, projectID, destID string) (*NotificationDestination, error)`
- `UpdateNotificationDestination(ctx, orgID, projectID, destID string, name *string, configEncrypted []byte, configFingerprint *string, enabled *bool) error` — COALESCE-style partial update; bumps `updated_at`.
- `DeleteNotificationDestination(ctx, orgID, projectID, destID string) error`

**Step 1: failing tests** using the `seedGroup`/`cleanupTenant` pattern from `queries_test.go`: create → list (empty health), get, update enabled, delete, and cross-org: create under org A, attempt get/update/delete with org B's ID → not-found error. Also empty `event_types` insert → CHECK violation error.

**Step 2: FAIL (functions missing). Step 3: implement. Step 4: PASS**

Run: `go test ./db -run NotificationDestination -v`

**Step 5: Commit** — `git add packages/ingestion/db/notifications.go packages/ingestion/db/notifications_test.go && git commit -m "feat(notifications): destination CRUD queries (org-scoped)"`

---

### Task 6: Publish in the ingest transaction

**Files:**
- Modify: `packages/ingestion/db/queries.go` — `isNew` branch of `InsertErrorEventAndGroup` (after the `status = 'queued'` update, still in `tx`)
- Test: `packages/ingestion/db/notifications_publish_test.go`

**Step 1: Failing tests:**

- New group + 1 enabled destination → exactly 1 `outbound_events` row (payload has `version:1`, correct names, no `status` field) + 1 `outbound_deliveries` row (`pending`).
- New group + 0 destinations → **zero** `outbound_events` rows.
- New group + disabled destination → zero rows.
- Second event, same fingerprint (increment path) → no new outbox rows.
- Two destinations → 1 event, 2 deliveries.
- Dedup: manually insert an `outbound_events` row with the same `(project_id, dedup_key)` first; ingest → no duplicate event, no orphan deliveries.
- Same dedup_key in a *different* project → publishes (tenant-scoped).

**Step 2: FAIL. Step 3: Implement.** In `queries.go`, inside `if isNew { ... }` after the queued update, add a call to an unexported helper:

```go
if err := publishIssueCreated(ctx, tx, q.DashboardURL, p.ProjectID, p.EnvironmentID, groupID, p.Title, eventTime); err != nil {
	return nil, fmt.Errorf("publish issue.created: %w", err)
}
```

**Config wiring (decided — do exactly this):** `Queries` (`packages/ingestion/db/queries.go:37`, constructed by `db.New(pool)`) gains one exported field:

```go
type Queries struct {
	pool *pgxpool.Pool
	// DashboardURL is the reader-facing dashboard base URL (env DASHBOARD_URL),
	// used for links in notification payloads. Empty disables links.
	DashboardURL string
}
```

`db.New` keeps its `(pool)` signature — no call sites change. `main.go` sets `queries.DashboardURL = os.Getenv("DASHBOARD_URL")` right after `db.New(pool)` (Task 10). Tests set the field directly. **No `os.Getenv` anywhere in the db package.**

Helper in `packages/ingestion/db/notifications.go`:

```go
// publishIssueCreated writes the transactional outbox rows for a brand-new
// error group. Runs inside the ingest transaction: any failure rolls back
// ingest (accepted trade-off — see design doc "Architecture").
// Ordered so projects with no destinations pay one indexed SELECT and stop.
func publishIssueCreated(ctx context.Context, tx pgx.Tx, dashboardURL, projectID, environmentID, groupID, title string, firstSeen time.Time) error {
	var hasDest bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM notification_destinations
		  WHERE project_id = $1 AND enabled AND 'issue.created' = ANY(event_types))`,
		projectID,
	).Scan(&hasDest); err != nil {
		return fmt.Errorf("check destinations: %w", err)
	}
	if !hasDest {
		return nil
	}

	var projectName, envName string
	if err := tx.QueryRow(ctx,
		`SELECT p.name, e.name FROM projects p, environments e
		  WHERE p.id = $1 AND e.id = $2`,
		projectID, environmentID,
	).Scan(&projectName, &envName); err != nil {
		return fmt.Errorf("lookup names: %w", err)
	}

	payload := notify.EventPayload{
		Version:   1,
		EventType: "issue.created",
		Issue:     notify.IssueRef{ID: groupID, Title: title, FirstSeen: firstSeen.UTC().Format(time.RFC3339)},
		Project:   notify.ProjectRef{ID: projectID, Name: projectName},
		Environment:  envName,
		DashboardURL: notify.BuildIncidentURL(dashboardURL, groupID, projectID),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err) // fails the tx: no silent notification loss
	}

	_, err = tx.Exec(ctx, `
		WITH dests AS (
		  SELECT id FROM notification_destinations
		  WHERE project_id = $1 AND enabled AND $2 = ANY(event_types)
		), ev AS (
		  INSERT INTO outbound_events (project_id, event_type, dedup_key, payload)
		  SELECT $1, $2, $3, $4::jsonb
		  WHERE EXISTS (SELECT 1 FROM dests)
		  ON CONFLICT (project_id, dedup_key) DO NOTHING
		  RETURNING id
		)
		INSERT INTO outbound_deliveries (event_id, destination_id)
		SELECT ev.id, dests.id FROM ev CROSS JOIN dests`,
		projectID, "issue.created", "issue.created:"+groupID, string(body),
	)
	if err != nil {
		return fmt.Errorf("insert outbox rows: %w", err)
	}
	return nil
}
```

`notify.BuildIncidentURL` (in `packages/ingestion/notify/url.go`, with its own unit test mirroring `packages/worker/src/narrative.ts:204` — https/http only, loopback rejected, credentials rejected, path `/incidents/{id}?project_id={pid}`, returns `""` on any invalid input; never errors).

**Step 4: PASS** — `go test ./db -run Publish -v`

**Step 5: Commit** — `git add packages/ingestion/db/queries.go packages/ingestion/db/notifications.go packages/ingestion/db/notifications_publish_test.go packages/ingestion/notify/url.go packages/ingestion/notify/url_test.go && git commit -m "feat(notifications): transactional outbox publish for new issues"`

---

### Task 7: Dispatcher — claim, fenced completion, reaper

**Files:**
- Create: `packages/ingestion/notify/dispatcher.go`
- Test: `packages/ingestion/notify/dispatcher_db_test.go` (uses a `testPool` copy — add `packages/ingestion/notify/testhelper_test.go` cloning `db/testhelper_test.go`)
- Test: `packages/ingestion/notify/dispatcher_http_test.go`

Semantics (design doc "Dispatcher" — implement exactly):

- **`Sender` is the shared delivery primitive** — exported because the handler's `/test` endpoint (Task 9) reuses it:

```go
// Sender validates, formats, POSTs, and classifies one delivery attempt.
type Sender struct {
	Client     *http.Client // CheckRedirect returns http.ErrUseLastResponse; Timeout 10s
	ExtraHosts []string
}

type Outcome struct {
	Class      string // "delivered" | "retry" | "permanent"
	StatusCode int    // 0 on network error
	RetryAfter time.Duration // >0 only when a valid Retry-After was honored (capped 1h)
	Reason     string // sanitized, never contains the URL; ≤500 chars
}

// Send re-validates url (defense in depth on decrypted config), formats via
// Formatters[destType], POSTs, and classifies per the design's retry table.
func (s *Sender) Send(ctx context.Context, destType, url string, p EventPayload) Outcome
```

- **Error sanitization is mandatory**: `*url.Error.Error()` embeds the request URL (the credential). Never store or log `err.Error()` from the HTTP call — classify the error (`timeout`, `connection refused`, …) via `errors.Is`/`os.IsTimeout` and store a fixed reason string. Add a test asserting the webhook path never appears in `last_error` after a network failure.
- `New(pool *pgxpool.Pool, cipher *ConfigCipher, opts Options) *Dispatcher`; `Options{PollInterval, BatchSize, HTTPTimeout, LeaseDuration, ExtraHosts}`. **`New` fills zero values with defaults** (5s / 10 / 10s / 90s) so `Options{ExtraHosts: hosts}` from main.go is correct; test this.
- `Run(ctx context.Context)` — loop: reap, claim, deliver concurrently (each via `Sender.Send`), sleep.
- Claim SQL (verbatim from design; RETURNING includes `max_attempts`, `lease_generation`).
- Every completion update fenced: `WHERE id = $1 AND status = 'delivering' AND lease_generation = $2`.
- Retry classification table (2xx delivered; 429 Retry-After delta-seconds AND HTTP-date, cap 1h; 408/5xx/network retry with backoff `[30s, 2m, 10m, 30m, 1h]`; other 4xx and any redirect permanent; response body read capped 4KB, `last_error` = status + first 500 chars).
- Per-delivery goroutine wraps in `defer func(){ if r := recover(); ... }` → recovered panic = retryable failure.
- Disabled destination at delivery time → `failed` with `destination_disabled`.
- HTTP client: `CheckRedirect: func(...) error { return http.ErrUseLastResponse }` — then treat any 3xx status as permanent failure.
- Test-DB cleanup: this package cannot see `db_test.cleanupTenant`. Its `testhelper_test.go` gets its own `cleanupTenant(t, pool, orgID)` doing the notification-table deletes (Task 1 Step 4 order) + the org/project deletes the seeds created.
- Reaper SQL:

```sql
UPDATE outbound_deliveries SET
  status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
  last_error = CASE WHEN attempts >= max_attempts THEN 'lease expired on final attempt' ELSE last_error END,
  next_attempt_at = now() + (CASE attempts WHEN 1 THEN interval '30 seconds' WHEN 2 THEN interval '2 minutes' WHEN 3 THEN interval '10 minutes' WHEN 4 THEN interval '30 minutes' ELSE interval '1 hour' END),
  lease_expires_at = NULL,
  updated_at = now()
WHERE status = 'delivering' AND lease_expires_at < now()
```

- Metrics: add `notify.RecordDelivery(destType, outcome string)` backed by the atomic-counter pattern in `handler/metrics.go`; expose via a small exported accessor the handler metrics endpoint calls (add `opslane_notification_deliveries_total{type,outcome}` lines to the `/metrics` output in `handler/metrics.go`).

**Step 1 (DB tests, failing):** seed destination + event + delivery rows directly with SQL, then:
- claim marks `delivering`, bumps `attempts` and `lease_generation`, sets lease; second claim call returns nothing (row not `pending`).
- claim skips `attempts >= max_attempts`.
- fenced completion with stale generation → 0 rows affected; row untouched.
- reaper: expired `delivering` → `pending` (backoff future); exhausted → `failed` with reason.

**Step 2 (HTTP tests, failing):** `httptest.Server` returning scripted 200 / 400 / 404 / 429 (+`Retry-After: 2` and an HTTP-date variant) / 500 / hang-past-timeout / 302; use `NOTIFY` extra hosts pointing at the test server; assert terminal statuses and `next_attempt_at` movement; a formatter that panics (inject a payload the formatter chokes on via a test seam — e.g., make `deliverOne` take the format function) → retryable, process alive.

**Step 3: Implement dispatcher. Step 4: All PASS** — `go test ./notify -v`

**Step 5: Commit** — `git add packages/ingestion/notify/dispatcher.go packages/ingestion/notify/dispatcher_db_test.go packages/ingestion/notify/dispatcher_http_test.go packages/ingestion/notify/testhelper_test.go packages/ingestion/handler/metrics.go && git commit -m "feat(notifications): leased dispatcher with fencing, retry classification, reaper"`

---

### Task 8: Housekeeping (pruning)

**Files:**
- Modify: `packages/ingestion/notify/dispatcher.go` (hourly tick inside `Run`)
- Test: `packages/ingestion/notify/prune_test.go`

CTE-batched deletes (Postgres has no `DELETE ... LIMIT`), max 5 batches of 1000 per tick; then orphan `outbound_events` cleanup with the same shape. Test: insert 3 old delivered rows + 1 fresh pending; prune with batch size 2 → old gone (2 batches), pending intact, orphan event removed.

Commit — `git add packages/ingestion/notify/dispatcher.go packages/ingestion/notify/prune_test.go && git commit -m "feat(notifications): bounded 30-day pruning"`

---

### Task 9: API handlers + authorization

**Files:**
- Create: `packages/ingestion/handler/notifications.go`
- Modify: `packages/ingestion/handler/routes.go` (register routes), `packages/ingestion/handler/auth.go` — the `Dependencies` struct lives at `auth.go:67` (there is **no** `dependencies.go`); add fields `ConfigCipher *notify.ConfigCipher`, `NotifyExtraHosts []string`, `NotifySender *notify.Sender`
- Test: `packages/ingestion/handler/notifications_test.go`

**Authorization middleware** (in `notifications.go`). Note: in cloud mode `AuthenticateUserSession` **already loads membership + role into context** (see the comment at `auth.go:185`) — do not chain `RequireMembership` again:

```go
// requireIntegrationAdmin gates destination mutations. RequireRole 404s when
// cloud auth is off (handler/auth.go:250), so OSS embedded-auth installs — which
// have no role model — accept any authenticated org user instead. In cloud
// mode, AuthenticateUserSession has already populated the role context.
func (d *Dependencies) requireIntegrationAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d.cloudAuthEnabled() && !auth.RoleSatisfies(RoleFromCtx(r.Context()), "admin") {
			writeJSONError(w, http.StatusForbidden, "insufficient organization role")
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

(Verify `RoleFromCtx` is what `RequireRole` reads at `auth.go:250-260`; mirror it exactly.)

**Endpoints** (all behind `AuthenticateUserSession`, all starting with `verifyProjectAccess` like `github_settings.go`; mutations additionally wrapped in `requireIntegrationAdmin` at route registration):

- `ListNotificationDestinations` — GET; response `{ can_manage: bool, destinations: [{id, type, name, config_fingerprint, event_types, enabled, created_at, last_delivery: {status, at, error} | null, recent_failures}] }`. `can_manage` = `!cloudAuthEnabled() || RoleSatisfies(role, "admin")` computed server-side; **never** decrypts config.
- `CreateNotificationDestination` — POST `{name, webhook_url, event_types?}`; validates name, `event_types ⊆ {"issue.created"}` (defaults to it), `notify.ValidateSlackWebhookURL`; generates UUID app-side; seals `{"webhook_url": ...}` with `ConfigAAD(id, projectID, "slack")`; stores fingerprint.
- `UpdateNotificationDestination` — PATCH `{name?, webhook_url?, enabled?}`; a new URL re-validates + re-seals with the same AAD.
- `DeleteNotificationDestination` — DELETE.
- `TestNotificationDestination` — POST; decrypts URL, builds a sample `EventPayload` (title "Test notification from Opslane"), calls `d.NotifySender.Send(ctx, "slack", url, payload)` synchronously, returns `{ok: outcome.Class == "delivered", classification: outcome.Class, status_code: outcome.StatusCode}`.

**Route registration** in `routes.go` next to the github settings block:

```go
r.With(deps.AuthenticateUserSession).Get("/projects/{projectID}/notification-destinations", deps.ListNotificationDestinationsEndpoint)
r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Post("/projects/{projectID}/notification-destinations", deps.CreateNotificationDestinationEndpoint)
r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Patch("/projects/{projectID}/notification-destinations/{destID}", deps.UpdateNotificationDestinationEndpoint)
r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Delete("/projects/{projectID}/notification-destinations/{destID}", deps.DeleteNotificationDestinationEndpoint)
r.With(deps.AuthenticateUserSession, deps.requireIntegrationAdmin).Post("/projects/{projectID}/notification-destinations/{destID}/test", deps.TestNotificationDestinationEndpoint)
```

**Step 1: failing handler tests** (follow `error_event_test.go` integration-test setup — real pool via `testDeps`, which **skips without `DATABASE_URL`** — export it per Conventions and confirm the output says PASS, not SKIP). This package also needs its own tenant-cleanup helper (Conventions). Cases:
- CRUD happy path; list returns fingerprint only (assert webhook secret substring absent from response body).
- OSS mode (no WorkOS provider): plain session user can create/update/delete; `can_manage: true`.
- Cloud mode: member role gets 403 on POST/PATCH/DELETE/test; admin passes; member `can_manage: false`.
- Cross-org project ID → 403 (matches `verifyProjectAccess`).
- Invalid URLs → 400 (matrix mirrors Task 3).
- Test endpoint against `httptest` sink (via `NotifyExtraHosts`) → `{ok: true}`.

**Steps 2–4: FAIL → implement → PASS** — `DATABASE_URL=... go test ./handler -run Notification -v` (confirm PASS lines, no SKIP)

**Step 5: Commit** — `git add packages/ingestion/handler/notifications.go packages/ingestion/handler/notifications_test.go packages/ingestion/handler/routes.go packages/ingestion/handler/auth.go && git commit -m "feat(notifications): destination CRUD + test API with dual-mode authorization"`

---

### Task 10: Wire into main.go + env docs

**Files:**
- Modify: `packages/ingestion/main.go`
- Modify: `docs/reference/environment-variables.md`, `.env.example`, `docker-compose.yml` (ingestion service env)
- Modify: `docs/reference/http-routes.md` — **required**: the docs-drift gate (`scripts/check-docs-drift.mjs:93`) fails the root `pnpm test` when registered routes are missing here. Add all five notification-destination routes in the file's existing format.

Steps:
1. Read `DASHBOARD_URL` and `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS` (comma-split, trimmed). If extra hosts non-empty: `slog.Warn("NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS set — webhook host allowlist extended (dev/test only)", "hosts", hosts)`.
2. `queries.DashboardURL = os.Getenv("DASHBOARD_URL")` right after `queries := db.New(pool)` (Task 6 contract).
3. Build `notify.NewConfigCipher([]byte(jwtSecret))` (fatal on error — same fail-fast as the JWT length check). Build one `notify.Sender` with the redirect-refusing client. Set `deps.ConfigCipher`, `deps.NotifyExtraHosts`, `deps.NotifySender`.
4. Start dispatcher after router construction, alongside the existing token-cleanup goroutine:

```go
dispatcher := notify.New(pool, cipher, notify.Options{ExtraHosts: notifyExtraHosts})
go dispatcher.Run(ctx)
```

(`ctx` is `context.Background()` here — main.go has no graceful shutdown; the design accepts crash-stop, the lease reaper covers it.)
5. Docs: add `DASHBOARD_URL` (ingestion section — note it mirrors the worker's variable and that `DASHBOARD_ORIGIN` is not a fallback), `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS` (dev/test only), and the `JWT_SECRET` rotation caveat (rotating it invalidates stored webhook configs; users re-enter URLs). Update `http-routes.md` per above.

Verify: `go build ./... && go test ./...` (all green), `docker compose config --quiet`, and `pnpm test` at the root (docs-drift gate green).

Commit — `git add packages/ingestion/main.go docs/reference/environment-variables.md docs/reference/http-routes.md .env.example docker-compose.yml && git commit -m "feat(notifications): start dispatcher; env + route docs"`

---

### Task 11: Dashboard API client + types

**Files:**
- Modify: `packages/dashboard/src/types/api.ts` — add:

```ts
export interface NotificationDestination {
  id: string;
  type: 'slack';
  name: string;
  config_fingerprint: string;
  event_types: string[];
  enabled: boolean;
  created_at: string;
  last_delivery: { status: string; at: string; error: string | null } | null;
  recent_failures: number;
}

export interface NotificationDestinationList {
  can_manage: boolean;
  destinations: NotificationDestination[];
}

export interface NotificationTestResult {
  ok: boolean;
  classification: string;
  status_code: number;
}
```

- Modify: `packages/dashboard/src/api.ts` — five functions using the existing `fetchWithAuth` helper: `listNotificationDestinations(projectId)`, `createNotificationDestination(projectId, {name, webhook_url})`, `updateNotificationDestination(projectId, destId, patch)`, `deleteNotificationDestination(projectId, destId)`, `testNotificationDestination(projectId, destId)`.
- Test: `packages/dashboard/src/api-notifications.test.ts` — clone the mocking style of `api-project-settings.test.ts`: assert URL, method, body shape, and that responses parse.

TDD: failing test → implement → `pnpm --filter @opslane/dashboard test` (confirm the package name with `pnpm -r ls --depth -1` if the filter doesn't match) → `git add packages/dashboard/src/types/api.ts packages/dashboard/src/api.ts packages/dashboard/src/api-notifications.test.ts && git commit -m "feat(dashboard): notification destinations API client"`.

---

### Task 12: Settings.vue Integrations tab

**Files:**
- Modify: `packages/dashboard/src/views/Settings.vue`

Steps:
1. Extend `SettingsTab` union with `'integrations'`; add the fifth pill button (copy the existing pill markup/classes at `Settings.vue:395-417`).
2. State: `const destinations = ref<NotificationDestination[]>([]); const canManage = ref(false); const destinationsProjectId = ref('')`. Load in `switchTab('integrations')` **and** re-fetch whenever the current project id differs from `destinationsProjectId` (this is the project-switch invalidation the design requires — do not copy the existing cache-forever pattern of the environments tab).
3. UI per design: list rows (name, type badge, masked URL, enabled toggle → PATCH, last-delivery status chip with error tooltip, recent-failures count, Test + Delete buttons); add-form (name + webhook URL + link to https://api.slack.com/messaging/webhooks); everything mutation-shaped hidden/disabled when `!canManage`. Test button renders inline result. Reuse existing Tailwind form classes from the api-keys tab for visual consistency.
4. Component test for the refetch contract (the API-client tests can't cover this): create `packages/dashboard/src/views/__tests__/settings-integrations.test.ts` using the repo's Vitest setup — mock the api module, mount Settings (or extract the integrations tab into `components/IntegrationsSettings.vue` with `projectId` as a prop if mounting Settings whole is impractical — prefer the extraction, it's more testable), assert: fetch fires with project A's id; changing the project id prop refires with project B's id; `can_manage: false` renders no mutation controls.
5. Check: `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test` (workspace package name is `@opslane/dashboard`, per the `@opslane/` scope convention — confirm with `pnpm -r ls --depth -1` if the filter doesn't match).

Commit — `git add packages/dashboard/src && git commit -m "feat(dashboard): integrations settings tab"`

---

### Task 13: Full verification gate + live smoke

**Steps (all must pass before claiming done):**

1. `cd packages/ingestion && go build ./... && go test ./...`
2. `pnpm -r build && pnpm test`
3. `docker compose config --quiet`
4. **Live smoke** (pipeline change ⇒ required by AGENTS.md). Exact sequence — destination CRUD is **session-auth only** (an SDK API key cannot create destinations), so the flow signs up a user first:

   ```bash
   # 1. Env BEFORE starting compose so ingestion picks it up
   export NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS=host.docker.internal:9999
   # (add NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS to the ingestion service `environment:`
   #  in docker-compose.yml as `${NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS:-}` — part of Task 10.
   #  On Linux also add: extra_hosts: ["host.docker.internal:host-gateway"].)
   docker compose up -d --build postgres minio ingestion worker
   docker compose logs ingestion | grep NOTIFY_UNSAFE   # WARN line must appear

   # 2. Seed projects/keys
   psql postgres://opslane:opslane_dev@localhost:5434/opslane -f scripts/seed-e2e.sql

   # 3. POST-capable sink on the host (prints bodies, returns 200)
   python3 - <<'EOF' &
   from http.server import BaseHTTPRequestHandler, HTTPServer
   class H(BaseHTTPRequestHandler):
       def do_POST(self):
           print(self.rfile.read(int(self.headers.get('Content-Length', 0))).decode(), flush=True)
           self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
   HTTPServer(('0.0.0.0', 9999), H).serve_forever()
   EOF

   # 4. Session: log in as the SEEDED user (same org as the seeded project —
   #    a fresh signup would create a new org and get 403 on the seeded project)
   curl -s -c /tmp/opslane-cookies -X POST http://localhost:8082/auth/password \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@e2e.test","password":"testpassword123"}'

   # 5. The seeded project id is fixed by scripts/seed-e2e.sql
   PROJECT_ID=00000000-0000-0000-0000-000000000010
   curl -s -b /tmp/opslane-cookies -X POST \
     "http://localhost:8082/api/v1/projects/$PROJECT_ID/notification-destinations" \
     -H 'Content-Type: application/json' \
     -d '{"name":"smoke sink","webhook_url":"http://host.docker.internal:9999/hook"}'

   # 6. Send an event with the seeded SDK key. Ingestion authenticates SDK
   #    calls via the X-API-Key header (handler/auth.go:147), NOT a Bearer token.
   curl -s -X POST http://localhost:8082/api/v1/events \
     -H 'Content-Type: application/json' -H 'X-API-Key: e2e-test-key-plaintext' \
     -d '{"error":{"type":"SmokeError","message":"notify smoke"},"stack_trace":"at smoke.js:1:1"}'
   # (Match the wire shape in docs/contracts/events.md / test-fixtures/wire/.)
   ```

   Assert, with real output shown:
   - `SELECT status, attempts, last_error FROM outbound_deliveries` → one row, `delivered`.
   - The sink printed Block Kit JSON containing "New issue in".
   - `docker compose logs ingestion | grep -i hooks` and the delivery row contain **no webhook URL**.
   - Same event again → `occurrence_count` increments, no new outbound rows.
   - Delete the destination, send a fresh-fingerprint event → zero new outbound rows.
5. Show real command output for each claim (per repo verification rules). If any auth/wire detail above doesn't match the code (signup shape, seed key), read the referenced file and adapt — the *assertions* are the contract, the exact curl shapes are best-effort scaffolding.

---

### Task 14 (follow-ups, do NOT implement — record only)

Record the follow-up list below using the repo's issue workflow (`docs/agents/issue-tracker.md`) if the tracker is available in your session; otherwise append it to the PR description under "Follow-ups". Do not create external side effects beyond that.

- Generic webhook destination (payload freeze + HMAC signing + arbitrary-host SSRF policy)
- Worker-emitted event types (`issue.needs_human`, `issue.pr_created`) with their own dedup keys + shared publish helper
- Org-level subscriptions; environment filters; manual retry UI
