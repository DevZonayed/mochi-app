# Mochlet WebKit App

This is the native macOS WebKit host for the existing Mochlet React renderer.
It does not bundle Electron or Chromium.

- `WKWebView` renders the Vite-built React UI from `Contents/Resources/web`.
- The existing headless sidecar is embedded under `Contents/Resources/sidecar`.
- A document-start JavaScript bridge exposes `window.maestro` with the same call
  shape as Electron preload, backed by the sidecar WebSocket.
- Native macOS pickers are handled through `WKScriptMessageHandler`.

Build:

```sh
cd MacOS/webview-app
./package-app.sh debug
open "dist/Mochlet.app"
```

## Channels

Every build targets an isolated channel (see `resolve-channel.sh`). Each channel
gets a distinct app name, bundle id, userData subdir, and MCP port so they never
share a store, token, keychain entry, or runtime:

| Channel      | App name              | Bundle id                                    | userData (`@maestro/…`) | MCP port |
| ------------ | --------------------- | -------------------------------------------- | ----------------------- | -------- |
| production   | `Mochlet`             | `cloud.nexalance.maestro.webkit`             | `desktop`               | 9235     |
| preview      | `Mochlet Preview`     | `cloud.nexalance.maestro.webkit.preview`     | `desktop-preview`       | 9236     |
| development  | `Mochlet Development` | `cloud.nexalance.maestro.webkit.development` | `desktop-development`   | 9237     |

```sh
# A specific channel + version:
MAESTRO_CHANNEL=preview MAESTRO_VERSION=0.1.52 ./package-app.sh release
```

`package-app.sh` signs channel + provenance metadata into `Info.plist`
(`MaestroChannel`, `MaestroUserDataDir`, `MaestroMcpPort`, `MaestroSourceRevision`,
`MaestroSourceFingerprint`, `MaestroSourceStatus`) and runs a preflight that
rejects a mislabelled channel, a bad version, or missing/malformed provenance.

Supporting scripts: `resolve-channel.sh` (channel → identity), `resolve-version.sh`
(release version from `MAESTRO_VERSION` or the nearest `mochlet-v*` tag),
`resolve-next-version.sh` (next PATCH after the highest semver in play), and
`source-fingerprint.sh` (deterministic `SOURCE_REV`/`SOURCE_FINGERPRINT`/
`SOURCE_STATUS`; the fingerprint flips on any tracked diff or untracked-file change
and never prints source bytes).

## Local release: `local-release.sh`

A safe, two-phase driver to test a build on this Mac before shipping it as
production. All decision logic lives in the unit-tested `local-release.mjs`; the
shell only wires I/O. **There is deliberately no `--force` / bypass flag.**

```sh
# See the ordered plan without doing anything (executes nothing):
./local-release.sh preview --plan
./local-release.sh promote --plan

# Build + verify + install the PREVIEW bundle beside production:
./local-release.sh preview

# Ship the already-installed, verified preview as production:
./local-release.sh promote

# Point at a non-default install root (used by tests / sandboxes):
./local-release.sh preview --applications-dir /tmp/apps   # or MAESTRO_APPLICATIONS_DIR
```

### `preview` guarantees

1. Captures the source fingerprint, resolves the next PATCH candidate.
2. Runs CI-equivalent gates from the repo root, failing closed:
   `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm typecheck` → `pnpm build`.
3. Packages `MAESTRO_CHANNEL=preview MAESTRO_VERSION=<candidate>`.
4. Smokes the **exact** `dist/Mochlet Preview.app` (its embedded node + sidecar)
   in a throwaway `MAESTRO_USER_DATA_DIR`, `MAESTRO_CHANNEL=preview`,
   `MAESTRO_MCP_PORT=9236`, with reliable cleanup.
5. Recomputes the fingerprint and **refuses to install if the source changed**
   during verification.
6. Strict `codesign --verify` + validates the plist channel/version/fingerprint.
7. Stages the built bundle to a unique same-filesystem hidden path and validates
   it **before** touching the installed preview, then stops only the preview bundle
   id (bounded wait — **aborts if the exact preview executable will not exit**),
   backs up any existing preview, and **atomically renames** the stage into place.
   After launch it waits for the exact destination executable, requires a PID, and
   revalidates version/channel. **Never quits, kills, replaces, or renames
   production** — it captures the production PID read-only (by exact executable
   path) and proves it is unchanged afterward.

### `promote` guarantees

1. Reads the candidate version/fingerprint/channel from the installed
   `Mochlet Preview.app`; requires `channel=preview`, strict semver, candidate
   **strictly greater** than the installed production version, and the fingerprint
   **exactly equal** to the current source (no re-increment, no drift).
2. Rebuilds the **same** source/version as production, smokes the exact packaged
   production app under a fresh isolated temp userData on a **non-production test
   MCP port 9238** (verification-only — the smoke never binds the live production
   port 9235), and requires the package fingerprint/version to match the preview.
   The freshly built bundle is staged to a unique same-filesystem hidden path and
   fully validated **before** the job guard or any quit; installation is an atomic
   rename with a timestamped backup, and a failed launch/readiness check rolls back
   to the previous bundle so production is never left absent.
3. **Fail-closed active-job guard:** before any production quit/replace, the
   production store must parse and have **zero** non-terminal jobs. Only the
   terminal `JobStatus` values (`done`, `failed`, `cancelled`) are safe;
   `pending`/`running`/anything unknown or malformed blocks. The guard runs again
   immediately before the quit.
4. Transactional install with timestamped backup and rollback on failure; target
   stays `/Applications/Mochlet.app`, preserving production userData/token. Quits
   production by its **exact bundle id only** — never a generic Mochlet/Node
   process name — then launches from the install path and verifies the shipped
   version.

All scripts are Bash 3.2 compatible (macOS `/bin/bash`) and never print store
contents, tokens, or source bytes.
