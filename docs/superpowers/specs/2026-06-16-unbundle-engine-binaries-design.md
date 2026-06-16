# Unbundle Codex + Claude engine binaries — download on first run

**Date:** 2026-06-16
**Status:** Approved (proceeding to implementation)
**Goal:** Cut packaged desktop app size by removing the per-platform native CLI binaries (Codex Rust binary + Claude `claude` binary) from the bundle. Keep the small JS (Agent SDK, Codex JS wrapper). On first run, resolve each engine in order **managed download → existing system install → trigger a download screen**, and fetch the *exact pinned npm tarball* for the user's platform into the app's writable data dir.

## Why

The macOS build is `universal` (arm64 **and** x64) and bundles two native CLI binaries per engine, so it ships ~4 copies of CLI binaries (2 engines × 2 arches). Estimated removable weight: **~150–250 MB**.

| Thing | What it is | Rough size |
|---|---|---|
| `@openai/codex-<plat>-<arch>` | Rust binary, currently `asarUnpack`ed | ~50–80 MB / arch |
| `@anthropic-ai/claude-agent-sdk-<plat>-<arch>` | the `claude` binary (currently inside ASAR) | ~30–50 MB / arch |
| macOS `universal` | doubles both | ×2 |

`playwright-core` stays — it's a ~10 MB JS driver for the user's *system* Chrome, not a heavy binary. Electron (~150 MB) is the unavoidable baseline.

## Non-goals

- Per-arch macOS builds (separate follow-up; changes the release/auto-update matrix).
- Changing auth flows (Codex `login`, API keys) beyond gating actions on binary presence.
- Any Chromium / Playwright change.
- Bundling/maintaining a tar library — we use the system `tar` already present on every target OS (Win10 1803+ ships `tar.exe`).

## Current state (verified facts)

- `apps/desktop/electron/engine.ts`
  - `resolveClaude()` (l.318) and `resolveCodex()` (l.370): order is **bundled-first → login-shell PATH → common install locations**, memoized in module-level `claudePath` / `codexPath`.
  - Claude binary is consumed via the SDK option `pathToClaudeCodeExecutable` (l.699). The **JS SDK** is `import()`ed in-process — it must stay bundled; only the native `claude` binary is the weight.
  - Codex binary is spawned directly at l.848, 1233, 1250, 1283; availability checked at l.1824/1826.
  - `LocalEngine` constructor (l.1042) receives `emit: (name, data, opts?) => void`. It already emits `'job'`, `'bg'`, `'asset'`.
- `apps/desktop/electron/main.ts` l.262 wires that emit → `webContents.send('maestro:event', { name, data })`.
- IPC contract: renderer `src/lib/api.ts` `call(method, params, fallback)` → `preload.ts` `ipcRenderer.invoke('maestro:call', …)` → `localApi.ts` `handle()` switch (e.g. `case 'codexLogin': return engine.codexLogin()`). Events reach the renderer via `preload.ts` `onEvent` → `api.ts` `subscribe()`.
- Managed per-user dirs live under `app.getPath('userData')/…` (precedent: `browser-profiles`, `sock`, `update-channel`).
- `apps/desktop/electron-builder.yml`: mac `universal` (arm64+x64) dmg+zip; `asarUnpack: node_modules/@openai/codex/**`, `@openai/codex-*/**`.
- The meta packages pin their platform subpackages exactly via `optionalDependencies` (e.g. `@openai/codex` → `"@openai/codex-darwin-arm64": "0.140.0"`). We read that pin **at runtime from the bundled meta package** so the downloaded binary always matches the shipped JS — no hardcoded version constant to drift.

## Design

### 1. Engine binary store — new module `electron/engines.ts`

Pure, testable. No Electron import beyond a passed-in `dir`.

```
type EngineId = 'codex' | 'claude';
PLATFORM_PKG: { codex: '@openai/codex-<plat>-<arch>', claude: '@anthropic-ai/claude-agent-sdk-<plat>-<arch>' }   // null for unsupported plat
BINARY_REL:   codex → 'vendor/<triple>/bin/codex[.exe]'   ;   claude → 'claude'

requiredVersion(id): string|null      // read meta pkg's optionalDependencies[platformPkg] from bundled node_modules
managedRoot(dir): `${dir}/engines`
managedBinary(dir, id): string|null   // path iff a verified copy for the *pinned* version exists (checks .ok marker)
enginesStatus(dir): { codex: EngineState, claude: EngineState }   // installed?, source: 'managed'|'system'|'none', version?
downloadEngine(dir, id, onProgress, signal): Promise<{ path }>    // see below
```

Layout: `userData/engines/<id>/<version>/<binary>` + a sibling `<version>/.ok` marker JSON `{ version, sha512, installedAt }`. Pinning by version dir means a version bump simply misses the new dir → re-download; stale sibling version dirs are GC'd after a successful install.

`downloadEngine` steps (atomic, concurrency-guarded — one in-flight per id):
1. Resolve `requiredVersion(id)` and `PLATFORM_PKG[id]`; bail with a typed error if the platform is unsupported.
2. `GET https://registry.npmjs.org/<pkg>` → pick `versions[version].dist` → `{ tarball, integrity }` (sha512, base64).
3. Stream the `.tgz` to a temp file, emitting `onProgress({ phase:'download', received, total, pct })`.
4. Verify sha512 against `dist.integrity`. Mismatch → delete, one auto-retry, then typed error.
5. Extract with system `tar -xzf <tgz> -C <tmp>` (`onProgress({ phase:'extract' })`); locate `package/<BINARY_REL>`.
6. `chmod 0o755`; move into `userData/engines/<id>/<version>/`; write `.ok`; GC older version dirs.
7. Return `{ path }`.

### 2. Resolution changes — `engine.ts`

Decision #1 policy:
- **`resolveCodex()`** (loosely-coupled standalone CLI): **system PATH → common locations → managed download → bundled (dev only) → null.**
- **`resolveClaude()`** (SDK ↔ binary version-coupled): **managed download → system PATH → common locations → bundled (dev only) → null.**

`bundledCodex()` / the SDK bundled-binary check stay as a **last** dev-only fallback (in production those packages aren't shipped, so they return null naturally — devs keep a zero-download inner loop).

Add `invalidateEngineCache(id)` to reset the `codexPath`/`claudePath` memo so a freshly-downloaded binary is picked up **without an app restart**.

### 3. Engine status + install surface

- `engine.ts` `LocalEngine`:
  - `enginesStatus()` → delegates to `engines.enginesStatus(userData)`, but overlays the live resolve result (so "system" installs are reflected).
  - `installEngine(id)` → `engines.downloadEngine(userData, id, p => this.emit('engine-download', { engine: id, ...p }))`, then `invalidateEngineCache(id)`; returns `{ ok, path, source:'managed' }`. Guards double-install.
  - `cancelEngineInstall(id)` → aborts the in-flight `AbortController`.
- `localApi.ts` new cases: `enginesStatus`, `installEngine` (validate `engine ∈ {codex,claude}`), `cancelEngineInstall`.
- `api.ts`: `enginesStatus()`, `installEngine(engine)`, `cancelEngineInstall(engine)`; extend `subscribe()` to map `'engine-download'` → `onEngineDownload?(p)`.

### 4. First-run UX — `Onboarding.tsx`

New step **"Set up engines"** (placed right after / merged with the existing `ProvidersStep`, which is about *auth*; this is about *runtime binaries*). On enter, call `enginesStatus()`:
- **Claude (core engine):** if not installed, auto-start `installEngine('claude')` with a progress bar; if a managed/system copy is present, show ✓. The step's **Continue is enabled once Claude is available**.
- **Codex (optional):** an "Install Codex (optional)" button → `installEngine('codex')`; skippable.

Disk-based resolution means nothing extra is persisted to `localStorage`.

### 5. Lazy safety-net (covers skip / failed download / later Codex sign-in)

- Where an engine is needed but `resolve* === null`, throw a typed error `{ statusCode: 503, code: 'engine-missing', engine }`:
  - `runClaude` start path (so a chat run can't silently no-op).
  - Codex `exec` + `codexLogin` (l.848/1250 area).
- Renderer: a small `EngineMissingPrompt` modal catches `engine-missing`, offers **"Download <engine> to continue"** with the same progress UI, then **retries the original action**. Wired into the chat run path and Settings' "Sign in with ChatGPT".

### 6. Build config

`electron-builder.yml`:
- **Remove** the two `asarUnpack` codex lines.
- **Exclude** the heavy platform binary subpackages from packaging via `files` negations (cover both the symlink and the pnpm `.pnpm` real path):
  - `!node_modules/@openai/codex-*/**`, `!node_modules/.pnpm/@openai+codex-*/**`
  - `!node_modules/@anthropic-ai/claude-agent-sdk-*/**`, `!node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-*/**`
- Keep `@openai/codex` and `@anthropic-ai/claude-agent-sdk` **JS** packages (the JS wrapper/SDK). Neither execs at import time, so a JS-only install is safe — verified: Codex is only reached via `require.resolve('@openai/codex-<plat>')` (returns null → falls through) and Claude via `pathToClaudeCodeExecutable`.

`vite.config.ts`: externals unchanged (SDK already external).

### 7. Version pinning & updates

`requiredVersion(id)` is read from the bundled meta package's `optionalDependencies` pin → the download always matches the shipped JS. On an app update that bumps the meta package, the new pinned version dir is absent → re-download happens lazily (next resolve-null) or is surfaced in Onboarding/Settings; old version dirs are GC'd after the new install succeeds.

### 8. Failure handling

- **Offline / fetch error:** typed error → UI shows **Retry** + **"install manually"** copy-paste commands, and (for the lazy net) lets the user continue if a *system* copy is detected.
- **Integrity mismatch:** delete temp → one auto-retry → surface error.
- **Disk/permission:** surface the path in the error.
- **Windows tar:** rely on built-in `tar.exe` (Win10 1803+); documented assumption.

## Components / interfaces

| File | Change |
|---|---|
| `electron/engines.ts` *(new)* | platform map, `requiredVersion`, `managedBinary`, `enginesStatus`, `downloadEngine`, version-dir GC |
| `electron/engine.ts` | resolve-order updates (Codex system-first, Claude managed-first), `invalidateEngineCache`, `enginesStatus`/`installEngine`/`cancelEngineInstall`, typed `engine-missing` throws |
| `electron/localApi.ts` | cases `enginesStatus`, `installEngine`, `cancelEngineInstall` |
| `src/lib/api.ts` | `enginesStatus`, `installEngine`, `cancelEngineInstall`, `subscribe` → `onEngineDownload` |
| `src/screens/Onboarding.tsx` | "Set up engines" step |
| `src/components/EngineSetup.tsx`, `EngineMissingPrompt.tsx` *(new)* | progress panel + lazy modal; wired into chat run + Settings |
| `electron-builder.yml` | drop codex `asarUnpack`; add platform-binary `files` exclusions |

## Testing

- **vitest `engines.test.ts`:** platform→pkg mapping; `requiredVersion` reads the optionalDependencies pin from a fixture; `managedBinary` version pinning (present / stale / missing) against a temp dir; sha512 verification (good vs corrupted buffer); tarball extraction locates the binary from a tiny fixture `.tgz`; stale-version GC.
- **vitest engine resolution:** mock fs/exec to assert Codex = system-first and Claude = managed-first; `invalidateEngineCache` picks up a newly-present managed binary.
- **Build verification:** `electron-builder` pack (or `du` the staged app contents) before/after to confirm the platform binaries are absent and size dropped; assert `@openai/codex-*` / `@anthropic-ai/claude-agent-sdk-*` are not in the packaged `node_modules`. At minimum: `pnpm typecheck` + unit tests + measure the excluded packages' on-disk size.
- **Manual:** fresh `userData` profile → first run downloads Claude (progress) → a chat run executes; Codex optional install → ChatGPT sign-in works.

## Risks & mitigations

- **pnpm node_modules layout** — negation globs must actually exclude the binaries → verify post-pack that they're absent and size dropped.
- **SDK requiring its own binary at import** — verified it uses `pathToClaudeCodeExecutable`; add a guard test.
- **Windows `tar`** — acceptable (Win10 1803+).
- **First-run network dependency** — mitigated by system-install fallback, clear errors, retry, and manual-install instructions.
