#!/bin/sh
# Migration reapply-with-data check.
#
# The migration runner (scripts/run-migrations.sh) has no ledger: it replays
# EVERY migration on EVERY boot. So a migration that unconditionally re-asserts
# a CHECK/constraint can silently conflict with a LATER migration that widened
# it, once real rows use the wider values. CI applying migrations once to a
# fresh, empty database never exercises this — the bug only appears on the
# second boot of a database that already holds data.
#
# This check encodes AGENTS.md's "reapply to a representative existing database"
# rule: apply migrations, seed a row at every boundary value a later migration
# introduced, then replay all migrations and require success.
#
# Extend SEED_SQL whenever a migration widens a constraint/enum to cover new
# values that real rows will hold.
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
MIGRATION_DIR="${MIGRATION_DIR:-packages/ingestion/db/migrations}"
RUNNER="$(dirname "$0")/run-migrations.sh"

echo "[reapply-check] first application (fresh DB path)"
MIGRATION_DIR="$MIGRATION_DIR" "$RUNNER" >/dev/null

# Seed one agent_sessions row per lifecycle status, including the values added
# by migration 021 (provisioned / key_ok / app_reporting). If any of these rows
# would violate a constraint re-added by an earlier migration on replay, the
# replay below fails — which is exactly what we want to catch in CI.
echo "[reapply-check] seeding representative rows at every lifecycle status"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO agent_sessions (id, repo_url, status, poll_token_hash, expires_at)
SELECT gen_random_uuid(), 'reapply-check/repo', s, 'reapply-check-hash', now() + interval '1 hour'
FROM unnest(ARRAY['pending','completed','expired','failed',
                  'provisioned','key_ok','app_reporting']) AS s;
SQL

echo "[reapply-check] replaying ALL migrations on the seeded database"
if ! MIGRATION_DIR="$MIGRATION_DIR" "$RUNNER" >/dev/null 2>/tmp/reapply-err.log; then
  echo "[reapply-check] FAIL — replaying migrations broke on a database with data:"
  sed 's/^/    /' /tmp/reapply-err.log
  echo "[reapply-check] A migration is re-asserting a constraint a later migration widened."
  psql "$DATABASE_URL" -c "DELETE FROM agent_sessions WHERE repo_url = 'reapply-check/repo';" >/dev/null 2>&1 || true
  exit 1
fi

echo "[reapply-check] cleaning up seeded rows"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "DELETE FROM agent_sessions WHERE repo_url = 'reapply-check/repo';" >/dev/null

echo "[reapply-check] PASS — migrations replay cleanly with data present"
