# Conductor-style git-status management for Maestro desktop

**Date:** 2026-06-23
**Status:** Approved (user: "go ahead and make it perfect")

## Problem

The Maestro desktop app feels laggy even when the rest of the Mac is smooth. Live
process sampling showed:

- The **renderer is idle**, parked in `mach_msg2_trap` waiting on IPC (~2392/2421
  samples).
- The **main process** spends ~75% of samples in `uv_run → uv_timer → JS`, i.e. a
  recurring timer firing promise-heavy JS that blocks the Node event loop.

Root cause, confirmed in code:

1. **All git reads are synchronous** — `git.ts` uses `execFileSync` everywhere
   (`execGit`, `repoInfo`, `ensureBranch`, …) with 5–15s timeouts. A synchronous
   `execFileSync` freezes the entire Node event loop until the child returns, even
   inside an `async` function (`await` does not make a sync call yield).
2. **A blanket 30s poll fans those sync reads across every session** — `main.ts`
   `pollGitStatuses` loops over `gitService.pollable()` and calls
   `fullStatus(s, { withPr: true })`. Per session that is ~7–8 synchronous git
   spawns (`localState` + `snapshotFor`).
3. **Scale multiplies it** — this repo currently has **36 worktrees**, so every 30s
   the main process spawns ~250+ synchronous git processes back-to-back on the UI
   thread, plus a GitHub PR fetch per session. The renderer's IPC stalls behind it.

The GitHub PR calls were already async (`fetch`); the **only** thing that ever
blocked the event loop was synchronous git in `localState` / `snapshotFor`.

## How Conductor does it (reference)

Conductor (Tauri/Rust) keeps many worktrees smooth by:

- Running git **off the UI thread** (native async Rust).
- Being **event-driven**, not blanket-polled: a `notify-debouncer-full` fsevents
  watcher recomputes on actual file changes.
- Caching per-workspace state with explicit **lifecycle states** (`initializing`,
  worktree-not-yet-created, …).
- Treating polling as an **optional** sync trigger (`SyncTriggerMode: poll | push |
  start`), not the default heartbeat.

Maestro already has the event-driven half: `git-watcher.ts` is a per-session
fsevents watcher with a 250ms debounce and a 5-min background fetch — the same
shape as Conductor's debouncer. The lag comes entirely from (a) synchronous git
and (b) the extra blanket poll bolted on top.

## Goals

- Git execution never blocks the Node event loop.
- Status is **event-driven + lazy**, not blanket-polled.
- No process storm: bounded git concurrency.
- Preserve all existing behavior and tests (PR lifecycle still surfaces; the
  workspace-overview strip still fills).

## Non-goals (YAGNI)

- Rewriting the git layer into a separate Electron utility process. Async
  `execFile` already frees the event loop (the blocking lived in the child, which
  is off-thread); a utility process adds IPC/serialization complexity for marginal
  gain. Documented as a future option if profiling ever demands it.
- A SQLite-backed status store. The in-memory `GitService.cache` already serves
  this role.
- A lifecycle `phase` field on `SessionGitStatus`. It would force renderer
  type-sync (`git-types.ts`) churn with no UI consumer yet, for no performance
  benefit. Deferred until a UI surface needs it.
- Changing the renderer's `withPr` fetch behavior (risks regressing the overview's
  PR awareness).

## Design

### 1. Async git core (`git.ts`)

Add a promisified `execGitAsync(args, opts)` mirroring `execGit`'s
`{ ok, out, code }` contract, plus async siblings for the status hot path:
`aheadBehindAsync`, `isDirtyAsync`, `dirtyFileCountAsync`, `lastCommitInfoAsync`,
`resolveBaseBranchAsync`, `localRefExistsAsync`. (`repoInfoAsync` already exists.)
Each reuses the existing pure parse logic of its sync twin.

Mutating ops (init/add/commit/push/merge/rename/worktree add-remove) stay
synchronous — they run on explicit user action, never in a loop, so they cannot
jank the idle UI.

### 2. Bounded git concurrency (`git.ts`)

A module-level async semaphore caps concurrent `execGitAsync` spawns
(`MAX_CONCURRENT_GIT`, default 8). Excess calls queue and drain as slots free.
This bounds the worst case (e.g. many watchers firing at once) regardless of
caller, matching Conductor's non-unbounded model.

### 3. GitService async hot path (`git-service.ts`)

`localState` and `snapshotFor` become `async`, awaiting the async helpers.
`fullStatus` (already async) awaits them. Only `fullStatus` calls these, so the
change is contained.

### 4. Slow down + de-block the poll (`main.ts`)

The fix is that git now runs **async**, so the poll no longer blocks the event
loop. We keep the poll's `withPr: true` semantics (the workspace-overview strip
depends on a real PR query to confirm pushed/PR rows — a `withPr: false` pass
would leave them `provisional` and hidden), but make it gentler:

- Replace `setInterval(pollGitStatuses, 30_000)` with a **3-minute** reconcile —
  6× less GitHub load — calling `fullStatus(s, { withPr: true })` over pollable
  sessions. Async + semaphore-bounded, so it never blocks the UI.
- Keep a launch-time pass (also `withPr: true`) so the overview strip confirms
  PR-derivable states immediately on open — now non-blocking.
- `unref()` the interval so it can't hold up shutdown.
- Between sweeps, freshness comes from the per-session GitWatcher (instant local
  recompute on `.git` mutations) and the renderer's on-view fetch.

**Concurrency note:** because `fullStatus` is now async, a cheap `withPr:false`
recompute (watcher kick / renderer lazy-fetch) can interleave with the
`withPr:true` reconcile. `fullStatus` re-reads the cache in an await-free section
immediately before writing (`pickPrFields`) so a PR-less pass can never clobber a
fresher PR result.

## Files touched

- `apps/desktop/electron/git.ts` — async helpers + semaphore.
- `apps/desktop/electron/git-service.ts` — async `localState`/`snapshotFor`;
  await-free `pickPrFields` race guard in `fullStatus`.
- `apps/desktop/electron/main.ts` — 30s sync poll → 3-min async reconcile
  (`withPr:true`) + non-blocking launch pass, `unref`'d.
- Tests: async-helper unit tests, semaphore test, `pickPrFields` race-guard test.

## Testing / verification

- `tsc` clean across the desktop app.
- Electron test suite green; renderer status tests green.
- Grep confirms no `execFileSync` on the status hot path
  (`localState`/`snapshotFor`).
- Manual: re-sample the running app under the 36-worktree load and confirm the
  main thread is no longer saturated by timer-driven sync git.
