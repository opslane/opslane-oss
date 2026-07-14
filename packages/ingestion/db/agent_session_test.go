package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestClaimAgentSessionKey_IntegrationReturnsKey(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	// Create real org + project (FK constraints require valid UUIDs)
	org, err := q.CreateOrg(ctx, "claim-key-test-org")
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	project, err := q.CreateProject(ctx, org.ID, "claim-key-test-project", ptrStr("test-owner/test-repo"))
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	// Create a session
	session, err := q.CreateAgentSession(ctx, "test-owner/test-repo", ptrStr("test-agent"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID)
	})

	// Complete the session with a known API key
	testKey := "def_test-integration-key-12345"
	completed, err := q.CompleteAgentSession(ctx, session.ID, org.ID, project.ID, testKey, 99999)
	if err != nil {
		t.Fatalf("complete session: %v", err)
	}
	if !completed {
		t.Fatal("expected session to be completed")
	}

	// Claim the key — this is the CTE under test
	claimed, err := q.ClaimAgentSessionKey(ctx, session.ID)
	if err != nil {
		t.Fatalf("claim key: %v", err)
	}
	if claimed == nil {
		t.Fatal("expected non-nil key from first claim, got nil")
	}
	if *claimed != testKey {
		t.Errorf("expected key %q, got %q", testKey, *claimed)
	}

	// Second claim should return nil (key already consumed)
	claimed2, err := q.ClaimAgentSessionKey(ctx, session.ID)
	if err != nil {
		t.Fatalf("second claim error: %v", err)
	}
	if claimed2 != nil {
		t.Errorf("expected nil from second claim, got %q", *claimed2)
	}
}

func TestClaimAgentSessionKey_IntegrationPendingSessionReturnsNil(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	// Create a session but don't complete it — no key to claim
	session, err := q.CreateAgentSession(ctx, "test-owner/pending-repo", nil)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID)
	})

	claimed, err := q.ClaimAgentSessionKey(ctx, session.ID)
	if err != nil {
		t.Fatalf("claim key on pending: %v", err)
	}
	if claimed != nil {
		t.Errorf("expected nil for pending session, got %q", *claimed)
	}
}

func TestExpireAgentSessions_IntegrationExpiresOld(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	// Create a session, then manually set its expiry to the past
	session, err := q.CreateAgentSession(ctx, "test-owner/expire-repo", nil)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM agent_sessions WHERE id = $1`, session.ID)
	})

	// Backdate expiry
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`, session.ID)
	if err != nil {
		t.Fatalf("backdate expiry: %v", err)
	}

	expired, err := q.ExpireAgentSessions(ctx)
	if err != nil {
		t.Fatalf("expire sessions: %v", err)
	}
	if expired < 1 {
		t.Error("expected at least 1 session expired")
	}

	// Verify it's now expired
	s, err := q.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if s == nil {
		t.Fatal("session should still exist")
	}
	if s.Status != "expired" {
		t.Errorf("expected status 'expired', got %q", s.Status)
	}
}
