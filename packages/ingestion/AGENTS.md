# Ingestion guidance

The ingestion service is the Go API and owns grouping, persistence, migrations, and S3-compatible storage.

## Boundaries

- Keep HTTP handlers in `handler/` and database operations in `db/`.
- Scope every database helper to the required project or organization, and enforce that scope in its query.
- Treat `001_baseline.sql` as the consolidated baseline. Add schema changes as append-only migrations starting at `002`.
- Make migrations safe to reapply with guarded operations such as `IF NOT EXISTS`.

## Verification

- Run `go build ./...` and `go test ./...` from `packages/ingestion`.
- For focused database or handler work, run `go test ./db ./handler` while iterating.
- Apply migration SQL to a disposable clean database and a representative existing database, then reapply it to verify idempotency.
- Build the ingestion Compose image after Dockerfile changes.
