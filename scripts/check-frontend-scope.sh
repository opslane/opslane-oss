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
else
  # CI checks this repo out shallow, so origin/main and the shared ancestor may
  # be absent. Fetch enough history to compute a real merge base before giving
  # up: refusing is correct, but only after trying.
  # An explicit refspec is required, not `git fetch origin main`. A shallow
  # `clone --branch X` configures a refspec covering only X, so a bare fetch
  # populates FETCH_HEAD without ever creating refs/remotes/origin/main.
  #
  # Do NOT add a FETCH_HEAD fallback here. In that same clone FETCH_HEAD
  # resolves to HEAD, making the merge base HEAD itself, the diff empty, and
  # this check pass while inspecting nothing.
  refspec='+refs/heads/main:refs/remotes/origin/main'
  if ! git rev-parse --verify --quiet origin/main >/dev/null; then
    git fetch --no-tags --quiet origin "$refspec" >/dev/null 2>&1 || true
  fi
  if [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "true" ]]; then
    git fetch --no-tags --quiet --unshallow origin "$refspec" >/dev/null 2>&1 \
      || git fetch --no-tags --quiet --deepen=500 origin "$refspec" >/dev/null 2>&1 || true
  fi

  if base=$(git merge-base origin/main HEAD 2>/dev/null) && [[ -n "$base" ]]; then
    :
  else
    # Refusing beats a silent pass: diffing HEAD against HEAD reports an empty
    # change set, so every committed change would sail through unchecked.
    echo "scope: cannot determine a trustworthy base (no origin/main, and fetch failed)." >&2
    echo "scope: fetch origin or set FRONTEND_SCOPE_BASE to an explicit commit." >&2
    exit 1
  fi
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
