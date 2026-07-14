#!/bin/sh
set -eu

MIGRATION_DIR="${MIGRATION_DIR:-/app/db/migrations}"

if [ ! -d "$MIGRATION_DIR" ]; then
  echo "No migrations directory found at $MIGRATION_DIR"
  exit 0
fi

for f in "$MIGRATION_DIR"/*.sql; do
  [ -e "$f" ] || continue
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f" -v ON_ERROR_STOP=1
done

echo "All migrations applied."
