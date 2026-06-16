# Self-contained Codex engine — design

**Date:** 2026-06-16
**Status:** approved, in build

## Problem

Codex in Mochi depends on a **globally-installed `codex` binary** and treats auth as
ChatGPT-subscription-only. Two concrete symptoms:

1. **Settings vs. model-picker disagree.** Settings → Accounts reports "Connected · Codex ·
   Signed in" from `codexLoggedIn()` alone (just `~/.codex/auth.json` exists), while the model
   picker calls `engine.status('codex')`, which *also* requires `resolveCodex()` to find a binary
   on PATH. If the CLI isn't on PATH, one surface says signed-in and the other says "not signed in".
2. **A stored OpenAI API key is dead.** `providers.connect('openai', key)` validates and stores a
   key in the Keychain, but it is **never passed to `codex exec`**, so an API key alone cannot run
   Codex.
3. **No in-app login.** The UI only prints "run `codex login` yourself in a terminal."

By contrast, Claude bundles its binary (`@anthropic-ai/claude-agent-sdk-<platform>`), and
`resolveClaude()` prefers that bundled copy — so Claude always works regardless of global installs.

## Goals

- Mochi ships **its own Codex CLI** (bundled), so Codex runs whether or not the user installed
  anything globally. (Mirrors Claude.)
- **Both auth methods work and are interchangeable**: ChatGPT subscription login *or* an OpenAI
  API key. Whichever is present makes Codex runnable.
- **In-app sign-in / re-sign-in**, available whether or not already signed in (switch account /
  re-auth), plus sign-out.
- The Settings ⇄ model-picker disagreement can never happen again (single source of truth).

## Non-goals

- Switching the Codex run path from `codex exec` (spawn) to `@openai/codex-sdk`. Keep spawning
  `codex exec`; the browser-MCP `-c` wiring and sandbox flags depend on it.
- Generalizing the new login UX to other providers. Scope to OpenAI/Codex.

## Design

### 1. Bundle Codex
Add `@openai/codex@^0.140.0` to `apps/desktop` dependencies. It ships platform binaries via
optional deps (`@openai/codex-<platform>-<arch>`), exactly like the Claude SDK.

Rewrite `resolveCodex()` (engine.ts) to mirror `resolveClaude()`:
1. The bundled binary from the platform optional-dep package (always present in `node_modules`).
2. A `codex` on the login-shell PATH.
3. Common install locations (`~/.local/bin`, homebrew, `/usr/local/bin`).

Result: the binary is effectively always found → the "CLI not found" branch becomes a last-resort
edge case, and Settings/picker can no longer disagree about binary presence.

### 2. Both auth methods → runnable
`status('codex')` becomes:
- subscription login (`~/.codex/auth.json`) → `available, method: 'subscription'`
- else a stored OpenAI key (`providers.getLocalKey('openai')`) → `available, method: 'apiKey'`
- else → not available, reason "Sign in with ChatGPT or add an OpenAI API key in Settings → Accounts."

`runCodex()` gains an optional `openaiKey` in its ctx. When there is **no** subscription login and a
key is present, spawn `codex exec` with `OPENAI_API_KEY=<key>` in its env (and let Codex use API-key
auth). When a subscription login exists, run as today (no env override). The key is threaded from
`this.providers.getLocalKey('openai')` via the existing `imageCtx` object in `run()`.

### 3. In-app sign-in / re-sign-in
New `LocalEngine` methods driving the **bundled** binary:
- `codexLogin()` → spawn bundled `codex login` (opens browser OAuth, writes `auth.json`); resolves
  on exit 0, rejects with captured stderr otherwise. Works even when already signed in (re-auth).
- `codexLogout()` → spawn bundled `codex logout` (removes `auth.json`).

New IPC actions in `localApi.ts`: `codexLogin`, `codexLogout`. New `api.ts` client methods
(desktop-only; the web fallback throws a clear "desktop only" `ApiError`).

Settings → Accounts, OpenAI row gains:
- A **"Sign in with ChatGPT"** button (always available — first sign-in or re-auth).
- The existing API-key entry as the alternative.
- When subscription-connected: "Signed in" + a "Sign out" affordance.
After login/logout/connect, the pane refetches providers and calls `refreshModelGroups()` so the
picker updates immediately.

### 4. Kill the disagreement at the source
Point the Settings Accounts pane's OpenAI/Codex (and Anthropic/Claude) "runnable" verdict at the
same engine status the picker uses, rather than `list()`'s file-only check, OR have `providers.list()`
itself account for the API-key-makes-it-runnable rule so both surfaces read identical data. Make the
model-picker tooltip show the real reason string (already wired via `g.reason`; just ensure the
reason is accurate, e.g. CLI-not-found vs not-signed-in).

## Files touched
- `apps/desktop/package.json` — add dependency.
- `apps/desktop/electron/engine.ts` — `resolveCodex()` bundled-first; `runCodex()` env injection;
  `status('codex')` API-key path; `codexLogin()`/`codexLogout()`; thread `openaiKey` into `imageCtx`.
- `apps/desktop/electron/providers.ts` — `list()` reflects API-key-runnable for openai (keep parity).
- `apps/desktop/electron/localApi.ts` — `codexLogin` / `codexLogout` IPC actions.
- `apps/desktop/src/lib/api.ts` — client methods.
- `apps/desktop/src/screens/Settings.tsx` — OpenAI row: ChatGPT sign-in / re-auth / sign-out.
- `apps/desktop/src/lib/ModelPicker.tsx` — ensure tooltip reason accurate (minor).

## Verification
- `pnpm typecheck` clean.
- `resolveCodex()` returns the bundled binary path on this Mac.
- `status('codex')` is available with only an API key (no auth.json), and runs a turn with the key
  in env.
- Settings and model picker agree in all four states: subscription, api-key, both, neither.
- `codexLogin()` opens the browser and, on completion, flips both surfaces to "Signed in".
