# Native browser-extension control channel for Maestro

**Date:** 2026-06-16
**Status:** Approved — building (Round 1 of 2)
**Scope this round:** unified local transport + extension control surface (send/steer messages to any chat, comments tied to a project+chat, live projects/chats list) + multi-profile active/standby/takeover.
**Out of scope (Round 2):** restoring the agent's *browser automation* (navigate/click/snapshot/screenshot) through the extension over this same server.

## Background

The bundled in-app browser (playwright) was removed; the replacement is the native Chrome extension at `/Users/jonayedahamed/Desktop/Projects/Personal/Mochi/extension`. The extension already speaks a clean WebSocket protocol (`hello` handshake → `{id,type,params,clientId}` ⇄ `{id,ok,result}` + `standby`/`promoted`/`request_takeover` lifecycle) but it points at the **old Mochi MCP broker on `ws://127.0.0.1:9009`** and targets "Claude CLI sessions," not our app's projects+chats.

The desktop app ("the Mac is the brain") owns the data/engine via `dispatch` (localApi.ts) + an `emit()` event stream, but has **no local server** — it only dials out to the cloud relay.

## Goal

Make the extension a **native control surface** for the desktop app: from any Chrome profile's extension you can see every project + its chats live, send a message to any chat (or start a new one), steer a running chat, and drop element-anchored comments that attach to a chosen project+chat. One app-owned local server is the single transport ("the unique way"). Multiple Chrome profiles connect simultaneously; exactly one is "active"; you can take over from any profile's popup **or** from the app.

## Architecture

### One app-owned local server (the unique transport)
New module **`apps/desktop/electron/extension-bridge.ts`** exporting **`ExtensionBridge`** (modeled on `codex-bridge.ts`). Responsibilities, single-owned:
- Open **one WebSocket server** (the `ws` package, already a dep) bound to **`127.0.0.1`** on a fixed **Maestro port (default `9234`)**, configurable via store setting + `MAESTRO_EXT_PORT`. Distinct from `9009` so it never collides with the still-installed Mochi plugin.
- Maintain the **connected-extension registry** (one entry per Chrome profile), the **active/standby** election, request/response correlation, and the bridge into the existing `dispatch` (actions) + `emit` subscription (live snapshot/events).
- Token-gate every connection; expose only a **curated action allowlist** (never the full dispatch).

Wired in `main.ts` alongside `codexBridge`: construct, `start()`, subscribe to emit, `stop()` on quit. The bridge emits an `extension` status event to the renderer (connected profiles / active) for the Settings panel.

### Connection & multi-profile model
- Each profile's extension persists a stable **`clientId`** (chrome.storage.local, per profile) and a human **`profile`** label. It connects once and sends `hello` with `clientId`, `profile`, `version`, and the pairing `token`.
- The bridge keeps `Map<clientId, {ws, profile, active, lastActiveAt}>`. **Exactly one active**; first to connect becomes active. On `request_takeover` (popup "Take over") or app-side `extensionSetActive`, that profile becomes active and the previous is demoted. On active disconnect, promote the most-recently-active remaining profile.
- The bridge broadcasts `promoted`/`standby` (reused by the extension's existing icon/lifecycle) and a `peers` list so every popup — and the app's Settings panel — shows all connected profiles and which is active.
- **Messaging/comments are allowed from any connected profile** (any profile can drive the app). "Active" is the canonical context owner (and the future browser-automation target). This matches today's behavior and is forward-compatible with Round 2.

### Protocol (app ↔ extension)
- ext→app: `{type:'hello', role:'extension', clientId, profile, version, token}`
- app→ext: `{type:'welcome', clientId, active}` → `{type:'snapshot', active, projects:[{id,name,kind,color, sessions:[{id,title,running,updatedAt}]}]}`
- app→ext lifecycle: `{type:'promoted'}` | `{type:'standby', reason}` | `{type:'peers', peers:[{clientId,profile,active}]}`
- app→ext live: `{type:'event', name:'project'|'session'|'job', data}` (keeps the projects/chats list + running flags fresh)
- ext→app RPC `{id, type, params}` → `{id, ok, result}` | `{id, ok:false, error}`:
  - `send_message {projectId, sessionId?|null, text, context?}` → `dispatch('sendChat', …)` → `{sessionId, jobId}` (new chat when `sessionId` is null)
  - `steer_message {projectId, sessionId, text}` → steer the running job (engine), fallback to `sendChat` into that session → `{ok, jobId?}`
  - `add_comment {projectId, sessionId?, selector, label, note, url, route, box, viewport, deliverToChat?}` → `dispatch('addDesignComment', …)` **and**, when `deliverToChat`, deliver the note (+ element context) into the chosen chat via send/steer → `{commentId, sessionId?}`
  - `get_snapshot {}` → current snapshot (popup refresh)
- ext→app lifecycle: `{type:'request_takeover'}`
- heartbeat ping/pong for liveness.

### Security
- Bind `127.0.0.1` only. **Pairing token**: store generates a persistent `extensionToken` (like `accessToken`), shown in Settings (copy button). Extension must present it in `hello`, else the socket is closed. Stops any other local program/website-via-extension from driving the app.
- The bridge exposes only the curated action allowlist above — it cannot reach sensitive local dispatch methods (git, project memory, feedback), preserving the existing local-vs-remote trust boundary.

## Desktop changes
- `store.ts`: add `extensionToken` (generated on first boot, migration) + optional `extensionPort` setting; getter.
- `extension-bridge.ts`: new module (server, registry, election, action allowlist, snapshot builder, event forwarding).
- `main.ts`: construct + start `ExtensionBridge(store, dispatch, …)`, feed it `emit` events, `stop()` on quit; expose `extensionPeers` / `extensionSetActive` dispatch methods + an `extension` status emit.
- `localApi.ts`: `extensionStatus`/`extensionPeers`/`extensionSetActive` dispatch cases (local-only; blocked from relay).
- `Settings.tsx` + `api.ts`: a **"Browser extension"** panel — server status + port, the pairing token (copy), connected-profile list with active indicator + "Make active" buttons (app-side takeover). Fills the space left by the removed Browser settings.
- Steering: confirm the engine's in-flight mechanism during implementation; if none, `steer_message` = deliver as the next message to that session (define `steer` = send into the running chat). No fabricated behavior.

## Extension changes (reuse-heavy)
- `background.js`: `WS_URL` → `ws://127.0.0.1:<port>` (default 9234, overridable from storage); persist per-profile `clientId`; include `clientId`/`profile`/`token` in `hello`; handle `welcome`/`snapshot`/`event`/`peers`/`promoted`/`standby`; cache `projects`; map modal send → `send_message`/`steer_message`; map comment submit → `add_comment`. Keep active/standby/takeover handling (already present).
- `mochi-modal.js`: session picker → **project+chat picker** (grouped by project, with "New chat in <project>"); send vs steer (steer when the chat has a running job).
- `comment-mode.js`: add a **project+chat picker** to the comment composer; on submit send `add_comment` to the app (keep the local pin rendering).
- `popup.html`/`popup.js`: show connection status, **profile name + active/standby**, the connected-peers list, a **Take over** button, a one-time **token pairing** field, and a quick send (project+chat+message).

## Testing
- vitest unit tests in `apps/desktop` for `ExtensionBridge`: token auth (reject bad token), connection registry, active/standby election + `request_takeover` + app-side `extensionSetActive`, action routing to a stubbed dispatch, snapshot/event forwarding.
- Desktop typecheck + full build must stay green.
- Extension: Chrome-API surface verified manually via the popup (load unpacked, pair, send a message, drop a comment, switch profiles). No fabricated automated coverage claims.

## Rollout
Round 1 (this): everything above. Round 2 (next): re-expose the agent's `browser_*` tools driving the **active** profile over this same server (the playwright replacement).
