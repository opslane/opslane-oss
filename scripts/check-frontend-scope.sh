#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ -n "${FRONTEND_SCOPE_BASE:-}" ]]; then
  # Resolve to a real commit before it reaches any git argument list. Passing the
  # raw value through would let a `-`-prefixed string (e.g. `--output=FILE`) be
  # parsed by git as an option instead of a revision.
  if ! base=$(git rev-parse --verify --quiet "${FRONTEND_SCOPE_BASE}^{commit}"); then
    echo "scope: FRONTEND_SCOPE_BASE is not a valid commit: ${FRONTEND_SCOPE_BASE}" >&2
    exit 1
  fi
elif git rev-parse --verify origin/main >/dev/null 2>&1; then
  base=$(git merge-base origin/main HEAD)
else
  # Refusing beats a silent pass: diffing HEAD against HEAD reports an empty
  # change set, so every committed change would sail through unchecked.
  echo "scope: origin/main unavailable; cannot determine a trustworthy base." >&2
  echo "scope: fetch origin or set FRONTEND_SCOPE_BASE to an explicit commit." >&2
  exit 1
fi

changed_file=$(mktemp "${TMPDIR:-/tmp}/opslane-frontend-scope.XXXXXX")
trap 'rm -f "$changed_file"' EXIT

{
  # `--` terminates option parsing so no revision can be read as a flag.
  git diff --name-only "$base"...HEAD --
  git diff --name-only --
  git diff --cached --name-only --
  git ls-files --others --exclude-standard
} | LC_ALL=C sort -u > "$changed_file"

is_denied() {
  case "$1" in
    packages/dashboard/src/api.ts|packages/dashboard/src/types/api.ts) return 0 ;;
    packages/dashboard/Dockerfile*|packages/dashboard/nginx*) return 0 ;;
    packages/dashboard/*deploy*|packages/dashboard/*runtime*) return 0 ;;
    packages/ingestion/*|packages/worker/*|shared/*) return 0 ;;
    .github/*|test-fixtures/wire/*) return 0 ;;
    docker-compose*|compose*.yml|compose*.yaml|Dockerfile*) return 0 ;;
    */migrations/*|*/migration/*) return 0 ;;
  esac
  return 1
}

is_allowed() {
  case "$1" in
    packages/dashboard/*) return 0 ;;
    test-e2e/dashboard-*.test.ts|test-e2e/dashboard-mock-harness.ts) return 0 ;;
    docs/design/dashboard-v1/*) return 0 ;;
    # NOTE: this script is allowed to change itself, so the check is a lint, not
    # an enforcement boundary — a single change can widen the allowlist and pass
    # the widened version. Closing that requires CI to run the base-branch copy
    # (`git show origin/main:scripts/check-frontend-scope.sh`) rather than the
    # branch copy. That is a workflow change, out of scope for a frontend-only
    # branch, so it is recorded here instead of silently assumed.
    pnpm-lock.yaml|scripts/check-frontend-scope.sh) return 0 ;;
  esac
  return 1
}

count=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  count=$((count + 1))
  if is_denied "$path"; then
    echo "scope: denied path: $path" >&2
    exit 1
  fi
  if ! is_allowed "$path"; then
    echo "scope: path is outside the frontend-only allowlist: $path" >&2
    exit 1
  fi
done < "$changed_file"

echo "scope: ok ($count changed path(s), base $base)"
