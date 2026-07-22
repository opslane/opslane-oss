package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var ErrInstallationOrgConflict = errors.New("installation is already mapped to another organization")

// PersistInstallationParams is the complete database representation of a
// verified GitHub App installation. Repos are canonical owner/name strings.
type PersistInstallationParams struct {
	InstallationID int64
	GitHubOrgName  string
	GitHubOrgID    int64
	OrgID          string
	Repos          []string
}

// PersistInstallation writes the rich installation mapping, the legacy org
// column, and the landed audit row in the caller's transaction.
func (q *Queries) PersistInstallation(ctx context.Context, tx pgx.Tx, params PersistInstallationParams) error {
	if tx == nil {
		return fmt.Errorf("persist installation: transaction is required")
	}
	if params.InstallationID <= 0 || params.OrgID == "" {
		return fmt.Errorf("persist installation: installation and organization are required")
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('github_installation:' || ($1::bigint)::text, 0))`,
		params.InstallationID); err != nil {
		return fmt.Errorf("lock installation: %w", err)
	}

	existingOrgID, err := installationOrgID(ctx, tx, params.InstallationID)
	if err != nil {
		return err
	}
	if existingOrgID != "" && existingOrgID != params.OrgID {
		return ErrInstallationOrgConflict
	}

	repos := params.Repos
	if repos == nil {
		repos = []string{}
	}
	reposJSON, err := json.Marshal(repos)
	if err != nil {
		return fmt.Errorf("encode installation repos: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO github_app_installations
		 (installation_id, github_org_name, github_org_id, org_id, repos)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (installation_id) DO UPDATE
		 SET github_org_name = EXCLUDED.github_org_name,
		     github_org_id = EXCLUDED.github_org_id,
		     repos = EXCLUDED.repos,
		     updated_at = now()`,
		params.InstallationID, params.GitHubOrgName, params.GitHubOrgID,
		params.OrgID, reposJSON); err != nil {
		return fmt.Errorf("upsert GitHub App installation: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE orgs SET github_installation_id = $2 WHERE id = $1`,
		params.OrgID, params.InstallationID); err != nil {
		return fmt.Errorf("set org GitHub installation: %w", err)
	}
	return q.InsertInstallationLanded(ctx, tx, params.InstallationID, params.OrgID, repos)
}

// InsertInstallationLanded appends an audit row in the caller's transaction.
func (q *Queries) InsertInstallationLanded(ctx context.Context, tx pgx.Tx, installationID int64, orgID string, repos []string) error {
	if repos == nil {
		repos = []string{}
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO installation_landed (installation_id, org_id, repos)
		 VALUES ($1, NULLIF($2, '')::uuid, $3)`, installationID, orgID, repos)
	if err != nil {
		return fmt.Errorf("insert installation landed: %w", err)
	}
	return nil
}

func installationOrgID(ctx context.Context, tx pgx.Tx, installationID int64) (string, error) {
	var orgID string
	err := tx.QueryRow(ctx,
		`SELECT org_id FROM github_app_installations WHERE installation_id = $1`,
		installationID).Scan(&orgID)
	if err != nil && err != pgx.ErrNoRows {
		return "", fmt.Errorf("look up installation organization: %w", err)
	}
	if orgID != "" {
		return orgID, nil
	}
	err = tx.QueryRow(ctx,
		`SELECT id FROM orgs WHERE github_installation_id = $1
		 ORDER BY created_at ASC LIMIT 1`, installationID).Scan(&orgID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("look up legacy installation organization: %w", err)
	}
	return orgID, nil
}

// FindRecentInstallationLandedByRepo returns the most recent audit row for a
// canonical repository. Audit evidence is diagnostic only and never mutates a
// pending agent session.
func (q *Queries) FindRecentInstallationLandedByRepo(ctx context.Context, repo string) (int64, *string, error) {
	var installationID int64
	var orgID *string
	err := q.pool.QueryRow(ctx,
		`SELECT installation_id, org_id
		 FROM installation_landed
		 WHERE EXISTS (SELECT 1 FROM unnest(repos) AS landed_repo WHERE lower(landed_repo) = lower($1))
		   AND landed_at > now() - interval '24 hours'
		 ORDER BY landed_at DESC
		 LIMIT 1`, repo).Scan(&installationID, &orgID)
	if err == pgx.ErrNoRows {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, fmt.Errorf("find recent landed installation: %w", err)
	}
	return installationID, orgID, nil
}
