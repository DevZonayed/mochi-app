#!/usr/bin/env bash
# Resolve the Mochlet release version for packaging (used by package-app.sh).
#
# Precedence — the point is that a NORMAL `./package-app.sh release` (no env)
# never bakes a stale hardcoded version into the bundle:
#   1. An explicit, non-empty MAESTRO_VERSION always wins.
#   2. Otherwise derive from the nearest reachable git tag matching `mochlet-v*`
#      and strip the `mochlet-v` prefix (git describe finds the nearest reachable
#      ancestor tag, so a checkout at/after a release resolves to that release).
#   3. Otherwise — no git metadata, no matching tag, or a source archive — fall
#      back to `0.0.0-dev`. NEVER a stale, previously-released version number.
#
# Prints the resolved version to stdout. Usage: resolve-version.sh [repo_dir]
set -euo pipefail

repo_dir="${1:-.}"

# (1) Explicit override. An empty string is treated as "not set" so it can't
# silently blank the version.
if [ -n "${MAESTRO_VERSION:-}" ]; then
  printf '%s\n' "$MAESTRO_VERSION"
  exit 0
fi

# (2) Nearest reachable mochlet-v* tag. `|| true` keeps `set -e` from aborting
# when there is no repo / no matching tag; stderr is discarded on purpose.
tag="$(git -C "$repo_dir" describe --tags --match 'mochlet-v*' --abbrev=0 2>/dev/null || true)"
if [ -n "$tag" ]; then
  printf '%s\n' "${tag#mochlet-v}"
  exit 0
fi

# (3) Dev / archive fallback — explicitly not a released number.
printf '%s\n' "0.0.0-dev"
