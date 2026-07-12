#!/usr/bin/env bash
# Resolve the NEXT release version for CI, from the highest semver already in play.
#
# Candidate sources (all NON-SECRET):
#   - the repo version (resolve-version.sh; honors MAESTRO_VERSION for tests/CI),
#   - the installed /Applications/Mochlet.app and "/Applications/Mochlet Preview.app"
#     (override the search root with MAESTRO_APPLICATIONS_DIR — used by tests),
#   - each extra `.app` bundle passed as a positional arg,
#   - each explicit X.Y.Z in MAESTRO_EXTRA_VERSIONS (comma/space separated).
#
# Non-X.Y.Z / malformed candidates (leading zeros, extra components, prefixes) are
# ignored safely. Prints the next PATCH after the HIGHEST NUMERIC semver — never a
# value <= any candidate. Exits nonzero only if NO valid candidate exists at all.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
APPS_DIR="${MAESTRO_APPLICATIONS_DIR:-/Applications}"

# Strict semver (no leading zeros → arithmetic is always base-10 safe).
is_semver() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; }

app_version() { # $1 = /path/to/App.app ; echoes CFBundleShortVersionString or nothing
  local plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 0
  command -v plutil >/dev/null 2>&1 || return 0
  plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null || true
}

candidates=()
candidates+=("$(bash "$ROOT/resolve-version.sh" "$REPO_ROOT" 2>/dev/null || true)")
candidates+=("$(app_version "$APPS_DIR/Mochlet.app")")
candidates+=("$(app_version "$APPS_DIR/Mochlet Preview.app")")
for a in "$@"; do candidates+=("$(app_version "$a")"); done
if [ -n "${MAESTRO_EXTRA_VERSIONS:-}" ]; then
  # split on commas and whitespace (normal shell word-splitting; no sed/awk)
  IFS=', ' read -r -a extra <<<"$MAESTRO_EXTRA_VERSIONS"
  candidates+=("${extra[@]}")
fi

bmaj=-1; bmin=-1; bpat=-1; found=0
for c in "${candidates[@]}"; do
  is_semver "$c" || continue
  IFS='.' read -r maj min pat <<<"$c"
  if (( maj > bmaj )) \
     || (( maj == bmaj && min > bmin )) \
     || (( maj == bmaj && min == bmin && pat > bpat )); then
    bmaj=$maj; bmin=$min; bpat=$pat
  fi
  found=1
done

if [ "$found" -eq 0 ]; then
  echo "ERROR: no valid X.Y.Z semver candidate (repo / installed apps / explicit)" >&2
  exit 1
fi

printf '%s.%s.%s\n' "$bmaj" "$bmin" "$((bpat + 1))"
