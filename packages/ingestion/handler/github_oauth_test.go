package handler

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestValidOAuthState(t *testing.T) {
	if validOAuthState("", "x") {
		t.Error("empty cookie must fail")
	}
	if validOAuthState("a", "b") {
		t.Error("mismatch must fail")
	}
	if !validOAuthState("same", "same") {
		t.Error("match must pass")
	}
}

func githubOAuthTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://opslane:opslane_dev@localhost:5434/opslane?sslmode=disable"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cleanupGitHubOAuthOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	for _, query := range []string{
		`DELETE FROM org_invitations WHERE org_id = $1 OR invited_by IN (SELECT id FROM users WHERE org_id = $1)`,
		`DELETE FROM users WHERE org_id = $1`,
		`DELETE FROM orgs WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, query, orgID); err != nil {
			t.Logf("cleanup warning: %v", err)
		}
	}
}

func TestGitHubProvisioningResolvesIdentityFirstAndWritesFreshIdentity(t *testing.T) {
	pool := githubOAuthTestPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "github-identity-first")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, org.ID) })
	userA, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-a-%d@example.com", time.Now().UnixNano()), "A", time.Now().UnixNano(), "a", "")
	if err != nil {
		t.Fatal(err)
	}
	legacyID := time.Now().UnixNano()
	if _, err := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("github-b-%d@example.com", time.Now().UnixNano()), "B", legacyID, "b", ""); err != nil {
		t.Fatal(err)
	}
	subject := strconv.FormatInt(legacyID, 10)
	if err := q.UpsertIdentity(ctx, userA.ID, "github", subject); err != nil {
		t.Fatal(err)
	}
	deps := &Dependencies{Queries: q}
	request := httptest.NewRequest("GET", "/auth/callback", nil)
	resolved, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: subject, Email: userA.Email,
		EmailVerified: true, Name: "A", Username: "identity-first",
	})
	if err != nil || resolved.ID != userA.ID {
		t.Fatalf("resolved user=%+v err=%v, want %s", resolved, err, userA.ID)
	}

	freshID := time.Now().UnixNano()
	freshEmail := fmt.Sprintf("github-fresh-%d@example.com", freshID)
	fresh, err := deps.provisionGitHubIdentity(request, auth.Identity{
		Provider: "github", ProviderSubject: strconv.FormatInt(freshID, 10), Email: freshEmail,
		EmailVerified: true, Name: "Fresh", Username: "fresh",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupGitHubOAuthOrg(t, pool, fresh.OrgID) })
	gotUserID, err := q.GetUserIDByIdentity(ctx, "github", strconv.FormatInt(freshID, 10))
	if err != nil || gotUserID != fresh.ID {
		t.Fatalf("fresh identity user=%q err=%v, want %s", gotUserID, err, fresh.ID)
	}
}
