package db_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func newV2AgentSession(t *testing.T, q *db.Queries, repo string) (*db.AgentSession, string) {
	t.Helper()
	raw, hash, pub, err := auth.NewAgentPollToken()
	if err != nil {
		t.Fatal(err)
	}
	session, err := q.CreateAgentSession(context.Background(), db.CreateAgentSessionParams{
		RepoURL: repo, PollTokenHash: hash, AgentKeyPub: pub,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session, raw
}

func TestCreateAgentSession_V2FieldsRoundTrip(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	repo := "v2-owner/v2-" + uuid.NewString()

	params := db.CreateAgentSessionParams{
		RepoURL: repo, PollTokenHash: "hash-1", AgentKeyPub: "pub-1",
	}
	first, err := q.CreateAgentSession(ctx, params)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	second, err := q.CreateAgentSession(ctx, params)
	if err != nil {
		t.Fatalf("second pending create should be allowed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = ANY($1::uuid[])`, []string{first.ID, second.ID})
	})

	got, err := q.GetAgentSession(ctx, first.ID)
	if err != nil || got == nil {
		t.Fatalf("get: %v", err)
	}
	if got.PollTokenHash == nil || *got.PollTokenHash != "hash-1" ||
		got.AgentKeyPub == nil || *got.AgentKeyPub != "pub-1" {
		t.Errorf("v2 fields not persisted: %+v", got)
	}
}

func TestAgentSessionV2FailureAndClickAreIdempotent(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	session, _ := newV2AgentSession(t, q, "v2-owner/failure-"+uuid.NewString())
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })

	if err := q.MarkAgentSessionAuthClicked(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	first, err := q.GetAgentSession(ctx, session.ID)
	if err != nil || first.AuthClickedAt == nil {
		t.Fatalf("first click stamp: session=%+v err=%v", first, err)
	}
	if err := q.MarkAgentSessionAuthClicked(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	second, _ := q.GetAgentSession(ctx, session.ID)
	if second.AuthClickedAt == nil || !second.AuthClickedAt.Equal(*first.AuthClickedAt) {
		t.Fatalf("click timestamp changed: first=%v second=%v", first.AuthClickedAt, second.AuthClickedAt)
	}

	changed, err := q.MarkAgentSessionFailed(ctx, session.ID, "repo_not_granted")
	if err != nil || !changed {
		t.Fatalf("mark failed: changed=%v err=%v", changed, err)
	}
	changed, err = q.MarkAgentSessionFailed(ctx, session.ID, "installation_not_yours")
	if err != nil || changed {
		t.Fatalf("second mark: changed=%v err=%v", changed, err)
	}
	failed, _ := q.GetAgentSession(ctx, session.ID)
	if failed.Status != "failed" || failed.FailureReason == nil || *failed.FailureReason != "repo_not_granted" {
		t.Fatalf("failed session = %+v", failed)
	}
}

func TestAgentSessionV2DeliveryStampAndPurge(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	session, raw := newV2AgentSession(t, q, "v2-owner/delivery-"+uuid.NewString())
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID) })

	sealed, err := auth.SealAgentKey(*session.AgentKeyPub, session.ID, "def_delivery-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agent_sessions SET status = 'completed', api_key_sealed = $2 WHERE id = $1`,
		session.ID, sealed); err != nil {
		t.Fatal(err)
	}
	opened, err := auth.OpenAgentKey(raw, session.ID, sealed)
	if err != nil || opened != "def_delivery-test" {
		t.Fatalf("open: value=%q err=%v", opened, err)
	}
	if err := q.MarkAgentKeyDelivered(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	first, _ := q.GetAgentSession(ctx, session.ID)
	if first.KeyClaimedAt == nil {
		t.Fatal("missing key_claimed_at")
	}
	if err := q.MarkAgentKeyDelivered(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	second, _ := q.GetAgentSession(ctx, session.ID)
	if second.KeyClaimedAt == nil || !second.KeyClaimedAt.Equal(*first.KeyClaimedAt) {
		t.Fatalf("delivery timestamp changed: first=%v second=%v", first.KeyClaimedAt, second.KeyClaimedAt)
	}

	if _, err := pool.Exec(ctx,
		`UPDATE agent_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ExpireAgentSessions(ctx); err != nil {
		t.Fatal(err)
	}
	after, _ := q.GetAgentSession(ctx, session.ID)
	if after.APIKeySealed != nil {
		t.Fatal("expired completed-session ciphertext was not purged")
	}
}
