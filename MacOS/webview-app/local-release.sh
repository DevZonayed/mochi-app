#!/usr/bin/env bash
# local-release.sh — SAFE local preview / promote driver for the WebKit app.
#
#   preview   Build + install the PREVIEW channel bundle (Mochlet Preview.app)
#             next to production, WITHOUT ever touching production. Verifies with
#             CI-equivalent gates, smokes the exact packaged bundle, and refuses
#             to install if the source changed mid-verification.
#   promote   Take the ALREADY-INSTALLED, verified preview and ship the same
#             source as production (Mochlet.app) — but only after a fail-closed
#             active-job guard proves nothing is in flight in the production store.
#
# Design: every decision (semver ordering, the active-job guard, channel /
# fingerprint / version validation, the ordered plan) lives in the unit-tested
# local-release.mjs. This script only wires I/O. There is deliberately NO force /
# bypass flag. Use --plan to print the plan and execute nothing.
#
# Safety invariants:
#   * PREVIEW never quits, kills, replaces, or renames production. It captures the
#     production PID read-only and PROVES it is unchanged after launching preview.
#   * PROMOTE quits production only by its EXACT bundle id (never a generic
#     Mochlet/Node process name), backs up with a timestamp, and rolls back on a
#     failed replacement. It never re-increments the version.
#   * Never prints store contents, tokens, or source bytes.
#
# Bash 3.2 compatible (macOS /bin/bash). No apostrophes inside $(...) comments.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
HELPER="$ROOT/local-release.mjs"
SMOKE="$REPO_ROOT/MacOS/sidecar/src/smoke-test.mjs"

APPS_DIR="${MAESTRO_APPLICATIONS_DIR:-/Applications}"
PROD_APP_NAME="Mochlet"
PREVIEW_APP_NAME="Mochlet Preview"
PROD_BID="cloud.nexalance.maestro.webkit"
PREVIEW_BID="cloud.nexalance.maestro.webkit.preview"
PROD_EXEC_REL="Contents/MacOS/MaestroWebKit"

MODE=""
PLAN=0
# The current unique hidden staging bundle. A script-level EXIT trap removes it on
# ANY failure so a partial/validated-but-unused stage is never left behind; it is
# neutralized (set empty) immediately after a successful atomic move into place.
stage=""

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "> $*"; }
# EXIT-trap cleanup. Capture the PENDING exit status first and return it verbatim,
# so the trap never overrides the script status (under `set -e` a bare
# `[ -n "" ] && …` ending on a false test would clobber a successful exit 0 → 1).
# A neutralized (empty) stage is a no-op; a stage-removal failure only WARNs and
# must not mask the original error, so the captured status is always preserved.
cleanup_stage() {
  local rc=$?
  if [ -n "${stage:-}" ]; then
    rm -rf "$stage" 2>/dev/null || echo "WARN: could not remove staging bundle: $stage" >&2
  fi
  return "$rc"
}

usage() {
  cat >&2 <<'EOF'
usage: local-release.sh <preview|promote> [--plan] [--applications-dir DIR]
  preview   build + verify + install the preview bundle (never touches production)
  promote   ship the verified preview as production (guards in-flight jobs first)
  --plan               print the ordered plan and exit; execute nothing
  --applications-dir   install root (default: $MAESTRO_APPLICATIONS_DIR or /Applications)
EOF
  exit 2
}

# ── arg parsing (no force/bypass flag exists) ─────────────────────────────────
[ "$#" -ge 1 ] || usage
case "$1" in
  preview|promote) MODE="$1"; shift ;;
  -h|--help) usage ;;
  *) die "unknown mode '$1' (expected preview | promote)" ;;
esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1; shift ;;
    --applications-dir) [ "$#" -ge 2 ] || die "--applications-dir needs a path"; APPS_DIR="$2"; shift 2 ;;
    *) die "unknown option '$1'" ;;
  esac
done

# ── prerequisites (refuse a bad environment; fail closed) ─────────────────────
require_prereqs() {
  [ "$(uname -s)" = "Darwin" ] || die "local-release only runs on macOS"
  for f in "$HELPER" "$SMOKE" "$ROOT/package-app.sh" "$ROOT/resolve-next-version.sh" "$ROOT/source-fingerprint.sh" "$ROOT/resolve-channel.sh"; do
    [ -f "$f" ] || die "missing prerequisite script: $f"
  done
  for c in node pnpm git plutil codesign ditto osascript ps open mktemp date; do
    command -v "$c" >/dev/null 2>&1 || die "missing required tool: $c"
  done
}

helper() { node "$HELPER" "$@"; }
plist_key() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }
source_fingerprint() { bash "$ROOT/source-fingerprint.sh" "$REPO_ROOT" | sed -n 's/^SOURCE_FINGERPRINT=//p'; }

# The EXACT on-disk executable path for a bundle (never a generic process name).
app_exec() { echo "$1/$PROD_EXEC_REL"; }

# Read-only: the PID of the first process whose executable path equals EXACTLY $1
# (empty when absent). Uses `ps -ww -axo pid=,comm=` (read-only, untruncated) and
# byte-for-byte string equality — NOT a substring/regex process match (which would
# confuse "Mochlet.app" with "Mochlet Preview.app" or match unrelated processes).
# The ps output is captured into a variable and iterated via a here-string, NOT a
# pipe: under `set -o pipefail` a `ps | while … | head` pipeline returns nonzero
# even after emitting a PID (last non-matching iteration / SIGPIPE from head),
# which would abort a `set -e` caller. `read` with two vars keeps a comm path that
# contains spaces intact in the second var. Returns 0 whether or not a match exists.
pid_of_exec() {
  local want="$1" out pid comm
  out="$(ps -ww -axo pid=,comm= 2>/dev/null || true)"
  while read -r pid comm; do
    if [ "$comm" = "$want" ]; then echo "$pid"; return 0; fi
  done <<< "$out"
  return 0
}

# Bounded wait until the exact executable is GONE. Returns 0 if it exited within
# the budget, 1 if it is still running (caller must abort). $2 = max 200ms ticks.
wait_exec_gone() {
  local exec_path="$1" max="$2" n=0
  while [ -n "$(pid_of_exec "$exec_path")" ]; do
    [ "$n" -ge "$max" ] && return 1
    sleep 0.2; n=$((n + 1))
  done
  return 0
}

# Bounded wait until the exact executable is UP; echoes its PID (empty on timeout).
wait_exec_up() {
  local exec_path="$1" max="$2" n=0 p
  while :; do
    p="$(pid_of_exec "$exec_path")"
    [ -n "$p" ] && { echo "$p"; return 0; }
    [ "$n" -ge "$max" ] && return 1
    sleep 0.2; n=$((n + 1))
  done
}

installed_version() { plist_key "$1" CFBundleShortVersionString; }
installed_channel() { plist_key "$1" MaestroChannel; }
installed_fingerprint() { plist_key "$1" MaestroSourceFingerprint; }

# Strict signature + provenance validation of a freshly packaged bundle. Low-level:
# RETURNS nonzero (printing a safe reason) instead of exiting the shell, so the
# top-level caller keeps control and can clean up its unique hidden stage first.
verify_bundle() {
  # $1 app path, $2 expected channel, $3 expected version, $4 expected fingerprint
  local app="$1" ch="$2" ver="$3" fp="$4"
  [ -d "$app" ] || { echo "verify: bundle not found" >&2; return 1; }
  codesign --verify --strict "$app" 2>/dev/null || { echo "verify: codesign --verify --strict failed" >&2; return 1; }
  helper validate-provenance \
    --channel "$(installed_channel "$app")" \
    --version "$(installed_version "$app")" \
    --fingerprint "$(installed_fingerprint "$app")" \
    --expected-channel "$ch" --expected-version "$ver" --expected-fingerprint "$fp" \
    || return 1
  return 0
}

# Smoke the EXACT packaged bundle (its embedded node + sidecar) in a throwaway
# userData so it can never touch a real store. Channel + mcp port isolate it. The
# smoke MCP port is always a NON-PRODUCTION test port (verification-only) so it can
# never bind the live production port 9235. Runs in a SUBSHELL with an EXIT trap so
# the cleanup can never leak into a later function return (a RETURN trap would).
smoke_app() {
  # $1 app path, $2 channel, $3 mcp port
  local app="$1" ch="$2" port="$3"
  (
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    MAESTRO_CHANNEL="$ch" MAESTRO_MCP_PORT="$port" MAESTRO_USER_DATA_DIR="$tmp/userdata" \
      node "$SMOKE" --app "$app"
  ) || die "packaged-app smoke failed for $app"
}

# ── PREVIEW ───────────────────────────────────────────────────────────────────
do_preview() {
  local dest src cand fp_before fp_after ts backup
  local prev_exec prod_exec prod_pid_before prod_pid_after prev_pid
  dest="$APPS_DIR/$PREVIEW_APP_NAME.app"
  src="$ROOT/dist/$PREVIEW_APP_NAME.app"
  prev_exec="$(app_exec "$dest")"
  prod_exec="$(app_exec "$APPS_DIR/$PROD_APP_NAME.app")"

  fp_before="$(source_fingerprint)"
  cand="$(bash "$ROOT/resolve-next-version.sh")"
  [ -n "$cand" ] || die "could not resolve a candidate version"
  note "preview candidate: $cand (source ${fp_before:0:12})"

  # Local release uses the already-resolved lockfile and local pnpm store.
  # It must fail clearly if the local package cache is incomplete instead of
  # opening registry sockets that can keep pnpm alive after "Done".
  note "gate: frozen install (offline)"; ( cd "$REPO_ROOT" && pnpm install --frozen-lockfile --offline )
  note "gate: test";           ( cd "$REPO_ROOT" && pnpm test )
  note "gate: typecheck";      ( cd "$REPO_ROOT" && pnpm typecheck )
  note "gate: build";          ( cd "$REPO_ROOT" && pnpm build )

  note "package preview $cand"
  MAESTRO_CHANNEL=preview MAESTRO_VERSION="$cand" bash "$ROOT/package-app.sh" release

  note "smoke exact preview bundle"
  smoke_app "$src" preview 9236

  fp_after="$(source_fingerprint)"
  [ "$fp_after" = "$fp_before" ] || die "source changed during verification (${fp_before:0:12} -> ${fp_after:0:12}); refusing install"

  verify_bundle "$src" preview "$cand" "$fp_after" || die "packaged preview failed validation"

  # STAGE the copied app to a unique same-filesystem hidden path and VALIDATE it
  # BEFORE touching the installed preview, so a bad copy can never replace a good
  # install. The stage sits in APPS_DIR so the later move is an atomic rename. The
  # script-level EXIT trap removes $stage on ANY failure below (no stale stage).
  ts="$(date +%Y%m%d-%H%M%S)"
  stage="$APPS_DIR/.mochlet-preview-stage-$$-$ts.app"
  rm -rf "$stage"
  ditto "$src" "$stage" || die "failed to stage preview bundle"
  verify_bundle "$stage" preview "$cand" "$fp_after" || die "staged preview failed validation"

  # Observe production read-only BEFORE we change anything, to prove non-disturbance.
  prod_pid_before="$(pid_of_exec "$prod_exec")"

  # Stop ONLY the preview (its exact bundle id), bounded wait, ABORT if the exact
  # installed preview executable is still running — never force-replace a live app.
  osascript -e "tell application id \"$PREVIEW_BID\" to quit" >/dev/null 2>&1 || true
  if ! wait_exec_gone "$prev_exec" 50; then
    die "existing preview did not exit; refusing to replace a running preview"
  fi

  # Backup the existing preview, then atomically move the staged app into place.
  backup=""
  if [ -e "$dest" ]; then
    backup="$dest.bak-$ts"
    mv "$dest" "$backup" || die "failed to back up existing preview app"
  fi
  if ! mv "$stage" "$dest"; then
    [ -n "$backup" ] && mv "$backup" "$dest"
    die "preview install failed; rolled back"
  fi
  stage=""   # moved into place — neutralize the EXIT-trap cleanup
  note "installed preview at $dest (backup: ${backup:-none})"

  # Launch and wait (bounded) for the EXACT destination executable; require a PID,
  # then revalidate the launched bundle version/channel.
  open "$dest"
  prev_pid="$(wait_exec_up "$prev_exec" 100 || true)"
  [ -n "$prev_pid" ] || die "preview did not come up after launch"
  verify_bundle "$dest" preview "$cand" "$fp_after" || die "launched preview failed revalidation"

  # Prove production was untouched. Fail loudly if its exact PID changed.
  prod_pid_after="$(pid_of_exec "$prod_exec")"
  if [ "$prod_pid_before" != "$prod_pid_after" ]; then
    die "production PID changed during preview (before='$prod_pid_before' after='$prod_pid_after') — aborting"
  fi
  note "production undisturbed (pid ${prod_pid_before:-none} unchanged); preview up (pid $prev_pid)"
}

# ── PROMOTE (production-mutating helpers live only here) ───────────────────────
production_backup() {
  # $1 dest, $2 timestamp -> echoes backup path (empty if nothing to back up)
  local dest="$1" ts="$2"
  if [ -e "$dest" ]; then
    local b="$dest.bak-$ts"
    mv "$dest" "$b" || die "failed to back up production app"
    echo "$b"
  fi
}
production_quit() {
  # Quit by EXACT bundle id only — never by a generic process name. ABORT (die) if
  # the exact production executable is still running after the bounded wait; we must
  # never replace a live production bundle out from under a running process. The
  # script-level EXIT trap removes the staged bundle on this abort.
  local exec_path
  exec_path="$(app_exec "$APPS_DIR/$PROD_APP_NAME.app")"
  osascript -e "tell application id \"$PROD_BID\" to quit" >/dev/null 2>&1 || true
  if ! wait_exec_gone "$exec_path" 75; then
    die "production did not exit after quit-by-bundle-id; aborting (exact executable still running)"
  fi
}
production_replace() {
  # Atomic rename of the pre-validated STAGE into the destination, with rollback to
  # the timestamped backup on failure. $1 stage, $2 dest, $3 backup. (The EXIT trap
  # removes a stage left behind by a failed move.)
  local stage="$1" dest="$2" backup="$3"
  if ! mv "$stage" "$dest"; then
    [ -n "$backup" ] && mv "$backup" "$dest"
    die "production install failed; rolled back to previous bundle"
  fi
}
production_launch() { open "$1"; }
production_rollback() {
  # Launch/readiness FAILED. Best-effort restore of the PREVIOUS production bundle.
  # If the failed NEW bundle refuses to exit, do NOT delete a running bundle — abort
  # loudly, leaving BOTH the new bundle and the backup intact for manual recovery.
  # When we do restore, relaunch the backup and PROVE it comes up. $1 = backup path.
  local backup="$1" dest exec_path rpid
  dest="$APPS_DIR/$PROD_APP_NAME.app"
  exec_path="$(app_exec "$dest")"
  [ -n "$backup" ] || die "production launch failed and there is no backup to restore — manual intervention required"
  osascript -e "tell application id \"$PROD_BID\" to quit" >/dev/null 2>&1 || true
  if ! wait_exec_gone "$exec_path" 75; then
    die "failed production did not exit; NOT removing a running bundle. New bundle at '$dest' and backup at '$backup' left intact — manual intervention required"
  fi
  rm -rf "$dest"
  mv "$backup" "$dest"
  open "$dest"
  rpid="$(wait_exec_up "$exec_path" 100 || true)"
  [ -n "$rpid" ] || die "restored previous production bundle did not come up — production may be down, manual intervention required"
  note "rolled back to previous production bundle (pid $rpid)"
}

# Locate the production store (channel userData). Overridable for isolation.
production_store_file() {
  if [ -n "${MAESTRO_PROD_STORE_FILE:-}" ]; then echo "$MAESTRO_PROD_STORE_FILE"; return; fi
  echo "$HOME/Library/Application Support/@maestro/desktop/maestro-store.json"
}

guard_active_jobs() {
  # Fail closed unless the production store parses and has ZERO active jobs. Low-level:
  # RETURNS nonzero (helper prints only a reason + count, never store contents) so the
  # top-level caller owns cleanup and the exit.
  local store="$1"
  helper guard-jobs "$store" || return 1
  return 0
}

do_promote() {
  local prev cand fp_prev ch_prev prod_app prod_exec prod_ver src fp_now store
  local ts backup prod_pid new_pid got_ver got_ch
  prev="$APPS_DIR/$PREVIEW_APP_NAME.app"
  prod_app="$APPS_DIR/$PROD_APP_NAME.app"
  prod_exec="$(app_exec "$prod_app")"
  src="$ROOT/dist/$PROD_APP_NAME.app"

  [ -d "$prev" ] || die "no installed preview at $prev — run 'local-release.sh preview' first"
  cand="$(installed_version "$prev")"
  fp_prev="$(installed_fingerprint "$prev")"
  ch_prev="$(installed_channel "$prev")"
  prod_ver="$(installed_version "$prod_app")"   # empty if production not installed yet
  fp_now="$(source_fingerprint)"

  note "promote preview $cand (channel $ch_prev) over production ${prod_ver:-none}"
  helper check-promotion \
    --preview-channel "$ch_prev" --preview-version "$cand" --preview-fingerprint "$fp_prev" \
    --prod-version "$prod_ver" --source-fingerprint "$fp_now" \
    || die "promotion refused (channel / version ordering / fingerprint drift)"

  note "package production $cand (same source)"
  MAESTRO_CHANNEL=production MAESTRO_VERSION="$cand" bash "$ROOT/package-app.sh" release

  # Verification-only smoke on a NON-PRODUCTION test port — never the live 9235.
  note "smoke exact production bundle (test port 9238)"
  smoke_app "$src" production 9238

  verify_bundle "$src" production "$cand" "$fp_now" || die "packaged production failed validation"
  # The freshly packaged production fingerprint/version MUST equal the preview we verified.
  [ "$(installed_fingerprint "$src")" = "$fp_prev" ] || die "production package fingerprint != preview fingerprint"
  [ "$(installed_version "$src")" = "$cand" ] || die "production package version != preview version"

  # STAGE + verify the exact bundle on the same filesystem BEFORE the job guard or
  # any quit, so nothing is ever torn down for a bundle that fails validation. The
  # script-level EXIT trap removes $stage on ANY failure below (no stale stage).
  ts="$(date +%Y%m%d-%H%M%S)"
  stage="$APPS_DIR/.mochlet-production-stage-$$-$ts.app"
  rm -rf "$stage"
  ditto "$src" "$stage" || die "failed to stage production bundle"
  verify_bundle "$stage" production "$cand" "$fp_now" || die "staged production failed validation"

  # Active-job guard. If production is not installed yet there is nothing in flight
  # to protect (a clean first install). Otherwise the store guard is mandatory and
  # is re-checked immediately before the quit (a job may have started meanwhile).
  store="$(production_store_file)"
  if [ -d "$prod_app" ]; then
    guard_active_jobs "$store" || die "active-job guard blocked promotion"
    guard_active_jobs "$store" || die "active-job guard blocked promotion (recheck)"
  else
    note "no production app installed yet — first install, no in-flight jobs to guard"
  fi

  prod_pid="$(pid_of_exec "$prod_exec")"
  production_quit
  backup="$(production_backup "$prod_app" "$ts")"
  production_replace "$stage" "$prod_app" "$backup"
  stage=""   # moved into place — neutralize the EXIT-trap cleanup
  note "installed production at $prod_app (backup: ${backup:-none})"
  production_launch "$prod_app"

  # Readiness: wait (bounded) for the EXACT target executable, require a PID, and
  # require the correct version + channel. On failure, roll back to the backup so
  # production is never left absent.
  new_pid="$(wait_exec_up "$prod_exec" 100 || true)"
  got_ver="$(installed_version "$prod_app")"
  got_ch="$(installed_channel "$prod_app")"
  if [ -z "$new_pid" ] || [ "$got_ver" != "$cand" ] || [ "$got_ch" != "production" ]; then
    production_rollback "$backup"
    die "production launch/readiness failed (pid='$new_pid' ver='$got_ver' ch='$got_ch'); rolled back to previous bundle"
  fi
  note "production now $got_ver (pid $new_pid; prev pid ${prod_pid:-none})"
}

# ── main ──────────────────────────────────────────────────────────────────────
if [ "$PLAN" -eq 1 ]; then
  # Dry run: print the ordered plan and execute NOTHING.
  helper plan "$MODE" --applications-dir "$APPS_DIR"
  exit 0
fi

# Guarantee the unique hidden stage is removed on ANY exit path (validation, guard,
# quit abort, or die). Registered only for a real run — never for --plan above.
trap cleanup_stage EXIT

require_prereqs
case "$MODE" in
  preview) do_preview ;;
  promote) do_promote ;;
  *) usage ;;
esac
