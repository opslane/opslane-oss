package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/db"
)

func TestInstallationLandedPersistsWithInstallation(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "landed-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })
	installationID := time.Now().UnixNano()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.PersistInstallation(ctx, tx, db.PersistInstallationParams{
		InstallationID: installationID,
		GitHubOrgName:  "landed-org",
		GitHubOrgID:    installationID + 1,
		OrgID:          org.ID,
		Repos: []db.InstallationRepo{{
			FullName: "Landed/Repo",
		}},
	}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	var richOrgID, legacyOrgID string
	var repos []string
	err = pool.QueryRow(ctx,
		`SELECT i.org_id, o.id, l.repos
		 FROM github_app_installations i
		 JOIN orgs o ON o.github_installation_id = i.installation_id
		 JOIN installation_landed l ON l.installation_id = i.installation_id
		 WHERE i.installation_id = $1`, installationID).Scan(&richOrgID, &legacyOrgID, &repos)
	if err != nil {
		t.Fatal(err)
	}
	if richOrgID != org.ID || legacyOrgID != org.ID || len(repos) != 1 || repos[0] != "Landed/Repo" {
		t.Fatalf("persisted rich=%s legacy=%s repos=%v", richOrgID, legacyOrgID, repos)
	}
}

func TestOAuthLoginStateActorAndReservationLifecycle(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	org, err := q.CreateOrg(ctx, "oauth-state-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	user, err := q.CreateUserGitHub(ctx, org.ID, "oauth-state-"+uuid.NewString()+"@example.com", "State User", time.Now().UnixNano(), "state-user", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupTenant(t, pool, org.ID) })

	stateHash := "reserved-" + uuid.NewString()
	if err := q.StoreOAuthLoginStateForOrg(ctx, stateHash, org.ID, user.ID, time.Now().Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	ordinaryHash := "ordinary-" + uuid.NewString()
	if err := q.StoreOAuthLoginState(ctx, ordinaryHash, time.Now().Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}

	ordinary, err := q.GetOAuthLoginStateDetails(ctx, ordinaryHash)
	if err != nil || ordinary == nil || ordinary.InitiatingUserID != nil {
		t.Fatalf("ordinary state=%+v err=%v, want actorless", ordinary, err)
	}
	reserved, err := q.ReserveOAuthLoginState(ctx, stateHash)
	if err != nil {
		t.Fatal(err)
	}
	if reserved == nil || reserved.TargetOrgID == nil || *reserved.TargetOrgID != org.ID ||
		reserved.InitiatingUserID == nil || *reserved.InitiatingUserID != user.ID || reserved.ReservationToken == "" {
		t.Fatalf("reservation=%+v", reserved)
	}
	if _, err := q.ReserveOAuthLoginState(ctx, stateHash); !errors.Is(err, db.ErrOAuthLoginStateInFlight) {
		t.Fatalf("second reserve error=%v, want in flight", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.FinalizeOAuthLoginState(ctx, tx, stateHash, uuid.NewString()); !errors.Is(err, db.ErrOAuthLoginStateReservation) {
		_ = tx.Rollback(ctx)
		t.Fatalf("wrong-token finalize error=%v", err)
	}
	_ = tx.Rollback(ctx)
	if err := q.ReleaseOAuthLoginState(ctx, stateHash, uuid.NewString()); !errors.Is(err, db.ErrOAuthLoginStateReservation) {
		t.Fatalf("wrong-token release error=%v", err)
	}
	if err := q.ReleaseOAuthLoginState(ctx, stateHash, reserved.ReservationToken); err != nil {
		t.Fatal(err)
	}

	second, err := q.ReserveOAuthLoginState(ctx, stateHash)
	if err != nil {
		t.Fatal(err)
	}
	if second.ReservationToken == reserved.ReservationToken {
		t.Fatal("new reservation reused its ownership token")
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.FinalizeOAuthLoginState(ctx, tx, stateHash, reserved.ReservationToken); !errors.Is(err, db.ErrOAuthLoginStateReservation) {
		_ = tx.Rollback(ctx)
		t.Fatalf("stale-token finalize error=%v", err)
	}
	_ = tx.Rollback(ctx)
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := q.FinalizeOAuthLoginState(ctx, tx, stateHash, second.ReservationToken); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if state, err := q.GetOAuthLoginStateDetails(ctx, stateHash); err != nil || state != nil {
		t.Fatalf("finalized state=%+v err=%v, want unavailable", state, err)
	}
}

func TestOAuthLoginStateExpiredLeaseIssuesNewToken(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	stateHash := "expired-lease-" + uuid.NewString()
	if _, err := pool.Exec(ctx,
		`INSERT INTO oauth_login_states
		 (state_hash, expires_at, reserved_at, reservation_token)
		 VALUES ($1, now() + interval '5 minutes', now() - interval '3 minutes', gen_random_uuid())`,
		stateHash); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_login_states WHERE state_hash = $1`, stateHash)
	})
	var oldToken string
	if err := pool.QueryRow(ctx, `SELECT reservation_token::text FROM oauth_login_states WHERE state_hash = $1`, stateHash).Scan(&oldToken); err != nil {
		t.Fatal(err)
	}
	state, err := q.ReserveOAuthLoginState(ctx, stateHash)
	if err != nil {
		t.Fatal(err)
	}
	if state == nil || state.ReservationToken == oldToken {
		t.Fatalf("reservation=%+v old=%s", state, oldToken)
	}
}

func TestPersistInstallationRejectsRichAndLegacyRehome(t *testing.T) {
	pool := testPool(t)
	q := db.New(pool)
	ctx := context.Background()
	orgA, _ := q.CreateOrg(ctx, "precedence-a-"+uuid.NewString())
	orgB, _ := q.CreateOrg(ctx, "precedence-b-"+uuid.NewString())
	t.Cleanup(func() {
		cleanupTenant(t, pool, orgA.ID)
		cleanupTenant(t, pool, orgB.ID)
	})

	persist := func(installationID int64, orgID string) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		err = q.PersistInstallation(ctx, tx, db.PersistInstallationParams{
			InstallationID: installationID, GitHubOrgName: "precedence",
			GitHubOrgID: installationID + 1, OrgID: orgID,
		})
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	richID := time.Now().UnixNano()
	if err := persist(richID, orgA.ID); err != nil {
		t.Fatal(err)
	}
	if err := persist(richID, orgB.ID); !errors.Is(err, db.ErrInstallationOrgConflict) {
		t.Fatalf("rich rehome error=%v", err)
	}

	legacyID := richID + 100
	if _, err := pool.Exec(ctx, `UPDATE orgs SET github_installation_id = $2 WHERE id = $1`, orgA.ID, legacyID); err != nil {
		t.Fatal(err)
	}
	if err := persist(legacyID, orgB.ID); !errors.Is(err, db.ErrInstallationOrgConflict) {
		t.Fatalf("legacy rehome error=%v", err)
	}
	if got, err := q.GetOrgGitHubInstallation(ctx, orgA.ID); err != nil || got != legacyID {
		t.Fatalf("legacy owner installation=%d err=%v", got, err)
	}
}
