# Engine Connection Unit — make the SwiftUI app and Node brain behave as one

**Date:** 2026-06-30
**Branch:** DevZonayed/native-macos-disconnect
**Status:** design, pending approval

## Problem

The native macOS app intermittently shows **"Not connected to the Maestro
engine."** (the screenshot symptom). Root cause, confirmed by a multi-agent
code trace:

- `RPCError.notConnected` is thrown in exactly one place — `MaestroClient.callRaw`
  when `task == nil` after a hard **10-second** grace wait
  (`MaestroClient.swift:83-89`). `task` only becomes non-nil after the sidecar
  prints `{"ready":true,...}`, which is the **last** thing it does, after all
  brain construction (`headless-main.ts:60-151`) plus `await startWsHost`.
- For the symptom to appear, the brain must still be unconnected ~10s after
  launch (the first `listProjects` already burns the same grace, gating the
  LaunchScreen at `RootView.swift:9,28`). In a dev launch this is common: Node
  esbuild-transpiles the whole ~60k-line brain on cold start before it can
  print ready.
- It feels mysterious and never self-heals because: **stderr is swallowed**
  (`SidecarSupervisor.swift:59` sets `p.standardError = Pipe()` with no reader);
  the UI **never observes connection state** (`client.state` / `supervisor.status`
  are read only in the `--selftest` path); there is **no reconnect** when a live
  socket drops; and dialogs cache the error string with no auto-clear
  (`CreateProjectSheet.swift:32-34,188-189`).

A literal single-process merge is impractical — the "engine" is the Node brain
(~60k lines of TypeScript reused from `apps/desktop/electron/*`). Embedding
libnode or rewriting the brain in Swift both throw away the reason the native
app exists.

## Goal

Make the two processes **behave as one inseparable unit**: a transient startup
race or a crash is invisible and self-healing, never a dead "Not connected"
wall. Concretely:

- A user action issued before the engine is ready **waits** for it, then
  proceeds — it does not throw.
- Connection status is a **single observable source of truth** the whole UI
  binds to (a brief "Connecting… / Reconnecting…" instead of a stuck red error).
- The engine is always supervised: heartbeat, auto-reconnect of a dropped
  socket, auto-restart of a crashed process — transparently.
- When the engine genuinely cannot start, the UI shows the **real reason**
  (from stderr), not the generic catch-all.

## Architecture

One coordinating unit made of small, well-bounded pieces:

### 1. `EngineState` — the single connection status (new, pure value type)

Replaces the split `MaestroClient.State` (`idle/connecting/connected/failed`)
and `SidecarSupervisor.Status` with one enum that the UI observes:

```swift
enum EngineState: Equatable {
    case starting              // process spawning / brain booting; no socket yet
    case connecting            // handshake received, WS connecting + verifying
    case ready                 // verified live; RPCs flow
    case recovering(String)    // was up, socket/process dropped; auto-recovering
    case down(String)          // recovery exhausted; reason = stderr tail
}
```

`SidecarSupervisor` owns and publishes `engineState` (`@Observable`). It is the
only writer. Everything else reads it.

### 2. Await-readiness call gate (`MaestroClient`) — kills the symptom

`callRaw` no longer does "wait 10s for `task`, else throw `.notConnected`".
Instead every RPC first `await`s a readiness gate:

```swift
func whenReady() async throws            // returns when .ready; throws EngineDown(reason) when .down
```

- `.starting` / `.connecting` / `.recovering` → the call **suspends** (parked in
  a list of `CheckedContinuation`s).
- `.ready` → returns immediately; the call sends.
- `.down(reason)` → throws `RPCError.engineDown(reason)` — a *real* error, only
  reached after bounded restart attempts, so calls never hang forever.

When the supervisor transitions to `.ready` it resolves all parked
continuations; on `.down` it rejects them with the reason. Result: a Create
click during boot quietly waits ~1–2s and then succeeds. `RPCError.notConnected`
is removed.

### 3. Liveness: confirmed-ready + heartbeat (`MaestroClient`)

- Flip to `.ready` only after a **confirmed round-trip** (a lightweight
  `health` RPC or first server message), not synchronously after `t.resume()` —
  fixes the premature-`.connected` race (`MaestroClient.swift:56`).
- A **heartbeat** sends `task.sendPing` every ~12s. If a ping errors or N
  consecutive pings go unanswered, the socket is declared dead even if
  `receive()` is silently hung (half-open after sleep/wake) → drives recovery.

### 4. WS-level reconnect, independent of the process (`MaestroClient` ⇄ `SidecarSupervisor`)

`receiveLoop`'s `.failure` path currently dead-ends (sets `.failed`, never
reconnects, never nils `task`). New behavior: on failure or heartbeat death the
client calls back to the supervisor (`onSocketDown`), which:

1. transitions `engineState` → `.recovering`,
2. re-`connect()`s the WS to the **current endpoint** with short backoff (the
   process is often still alive), and
3. escalates to a full process restart only if reconnects keep failing.

Process crash (`terminationHandler` → `onExit`) feeds the **same**
`.recovering` path and existing capped backoff, instead of the old `.failed`.
Backoff resets on a successful `.ready`.

### 5. Surfaced stderr (`SidecarSupervisor`) — diagnosis + the `.down` reason

Attach a `readabilityHandler` to the stderr `Pipe` (today it has none). Keep a
rolling tail (~50 lines). Forward to the app log. When recovery is exhausted,
`.down(reason)` carries that tail so the user/operator sees *why* (e.g. a locked
store, a missing engine) instead of the generic message.

### 6. Node side: don't die silently, signal progress (`headless-main.ts`)

- Wrap the **top-level brain construction** (`new Store()`, `new LocalEngine()`,
  `new BrowserManager()`, `createDispatch(...)`, etc. — currently un-`try`'d at
  lines 60-151) so one failing subsystem can't kill boot before the handshake;
  on a fatal failure, print a structured `{"fatal":"<reason>"}` line to stdout so
  the supervisor can surface it as `.down` immediately rather than waiting out a
  restart loop.
- Emit an early `{"phase":"starting"}` line as soon as the process is alive, so
  the supervisor distinguishes "alive and booting" from "hung/dead".
- Keep `{"ready":true,...}` as the gate to `.ready`. (Boot latency stops
  mattering to UX because the client queue waits — but the early phase line plus
  guarded construction make a slow boot visible and a failed boot diagnosable.)

### 7. Robust handshake parse (`SidecarSupervisor`)

Give the stdout reader a **retained cross-callback line buffer**: accumulate
bytes, split on `\n`, parse only complete lines. Removes the (low-rate but real)
chance of losing the ready frame to a chunk boundary
(`SidecarSupervisor.swift:60-71` has no buffer today).

### 8. UI: observe state, no stuck errors

- New `EngineGate` overlay/banner bound to `engineState`: a quiet
  "Connecting to the engine…" / "Reconnecting…" indicator while not `.ready`;
  the real failure reason on `.down` with a Retry button (Retry resets attempts
  and restarts).
- `RootView.ready` gates on `engineState == .ready` (+ the existing min-splash),
  not on `workspace.loading` alone.
- Dialogs (`CreateProjectSheet`, etc.) drop the `.notConnected` special-case;
  because calls await readiness, the red error path is only hit by genuine RPC
  errors. Optionally the Create button reflects "waiting for engine…" while not
  ready instead of being clickable into a wait.

## Data flow (startup)

```
MaestroApp.task → AppEnv.boot()
  → supervisor.start()            // spawn Node; engineState = .starting
  → WorkspaceStore.start()        // first listProjects → client.whenReady() → parks
Node: {"phase":"starting"}        // supervisor stays .starting (alive, booting)
Node: brain built, WS listening, {"ready":true,port,token}
  → supervisor.onReady → client.connect(ep)
  → client confirms round-trip   → engineState = .ready
  → parked continuations resolve → listProjects proceeds → projects render
```

No path yields `.notConnected`. A user who clicked Create mid-boot simply
completes when `.ready` fires.

## Component boundaries

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `EngineState` | the one status value | — |
| `MaestroClient` | socket + RPC + readiness gate + heartbeat | URLSession, supervisor callbacks |
| `SidecarSupervisor` | process lifecycle, `engineState`, stderr tail, handshake parse | Process, MaestroClient |
| `EngineGate` (view) | render status / Retry | `engineState` |

## Error handling

- Transient (boot slow, socket drop, process crash): invisible — calls queue,
  recovery runs, then they proceed. UI shows "Connecting/Reconnecting".
- Terminal (recovery exhausted / `{"fatal"}`): `engineState = .down(reason)`,
  parked calls throw `RPCError.engineDown(reason)`, UI shows the real reason +
  Retry.

## Testing

- **Pure logic (unit):** `EngineState` transition table; the readiness-gate
  queue (park → resolve on ready, reject on down); the stdout line-buffer
  (split frames across synthetic chunk boundaries, including the ready frame
  split mid-line). These run without spawning Node.
- **Integration (`--selftest`, extended):** boot, confirm `.ready`, real RPC,
  then kill the sidecar process and assert auto-recovery back to `.ready`
  without a surfaced error; assert a forced fatal yields `.down` with a reason.
- **Build gate:** `swift build` green; existing sidecar `pnpm test` green.

## Out of scope (separate follow-ups)

- Prebuilding the dev sidecar to `.js` to cut cold-boot transpile time (the
  await-queue makes this a perf nicety, not correctness).
- Relay/mobile connection handling — this spec is the Mac app ⇄ local sidecar
  link only.

## Non-negotiables carried from repo policy

- No commit/push without explicit operator ask; no merge; no AI-attribution
  trailers. Land via feature branch + PR when the operator says so.
