#!/usr/bin/env bash
# Resolve the release CHANNEL configuration for packaging (used by package-app.sh).
#
# MAESTRO_CHANNEL selects the channel; `production` is the default and an unknown
# channel is REJECTED (exit 1) so a typo can never silently ship a mislabelled or
# non-isolated bundle. Prints one KEY=VALUE per line (values may contain spaces —
# read them with sed, do NOT `eval`):
#   CHANNEL, APP_NAME, BUNDLE_ID, USER_DATA_DIR (subdir under @maestro/), MCP_PORT
#
# The bundle id / userData subdir / MCP port are the isolation boundary — they MUST
# stay in lockstep with the runtime channel map (sidecar/src/electron-shim.ts
# channelSubdir + brain/mcp/external-mcp.ts preferredMcpPort).
set -euo pipefail

ch="${MAESTRO_CHANNEL:-production}"
case "$ch" in
  production)
    app="Mochlet";             bid="cloud.nexalance.maestro.webkit";             udd="desktop";             port=9235 ;;
  preview)
    app="Mochlet Preview";     bid="cloud.nexalance.maestro.webkit.preview";     udd="desktop-preview";     port=9236 ;;
  development)
    app="Mochlet Development"; bid="cloud.nexalance.maestro.webkit.development"; udd="desktop-development"; port=9237 ;;
  *)
    echo "ERROR: unknown MAESTRO_CHANNEL '$ch' (expected: production | preview | development)" >&2
    exit 1 ;;
esac

printf 'CHANNEL=%s\n'       "$ch"
printf 'APP_NAME=%s\n'      "$app"
printf 'BUNDLE_ID=%s\n'     "$bid"
printf 'USER_DATA_DIR=%s\n' "$udd"
printf 'MCP_PORT=%s\n'      "$port"
