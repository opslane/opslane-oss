#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

WIPE_DB=false

for arg in "$@"; do
  case $arg in
    --wipe-db)
      WIPE_DB=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--wipe-db]"
      echo ""
      echo "  Default:    Restart services, preserving data."
      echo "  --wipe-db:  Destroy all data and recreate from scratch."
      echo ""
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg"
      echo "Run $0 --help for usage."
      exit 1
      ;;
  esac
done

echo "Stopping services..."
docker compose down

if [ "$WIPE_DB" = true ]; then
  echo ""
  echo "WARNING: Wiping all volumes (database, object store). This is destructive."
  echo ""
  docker compose down -v
fi

echo "Starting services..."
docker compose up -d --build

echo ""
echo "Waiting for services to be healthy..."
sleep 5

docker compose ps

echo ""
echo "Running migrations..."
docker compose run --rm migrate

echo ""
echo "Services ready."
if [ "$WIPE_DB" = true ]; then
  echo "  NOTE: All data was wiped. You will need to re-create orgs/projects/keys."
fi
