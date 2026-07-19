package db_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestExpireAgentSessions_IntegrationExpiresOld(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()

	// Create a session, then manually set its expiry to the past
	session, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{
		RepoURL: "test-owner/expire-repo", PollTokenHash: "expire-hash", AgentKeyPub: "expire-pub",
	})
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
