# Device Management — Design

**Date:** 2026-06-18
**Status:** Approved (option B)

## Problem

From the desktop app the operator must be able to (1) see every connected remote device, (2) **disconnect any single device** while others keep working, (3) **regenerate the pairing code** (kick everyone), and a disconnected device must be able to **reconnect by re-pairing**.

Today this is impossible: every remote shares one global token (`accessToken`) and the relay tracks remotes as a single anonymous aggregate (`remoteName` sticky + `sseClients` count). There is **no per-device identity** anywhere. This also causes the "ghost device" (sticky name + a 90s freshness window keep a stale device showing as connected).

## Approach (B): per-device identity + targeted kick

Give each remote a stable `deviceId`; the relay tracks devices individually and can close + revoke one without touching the others. A "Regenerate code" path rotates the token to kick everyone. Re-pairing mints a fresh id, which is the reconnect path.

## Contract (the shared protocol — get this exactly right)

### Device identity
- **`deviceId`**: client-generated UUID (`crypto.randomUUID()`), persisted. **Re-minted on every (re-)pair** so a kicked device returns as a new identity (clean reconnect).
  - Web (`apps/desktop/src/lib/api.ts`, browser branch): `localStorage['maestro.remote.deviceId']`.
  - Mobile (`apps/mobile/src/api.ts`): `AsyncStorage['maestro.device.id']`.
- **`label`**: human name. Web derives from User-Agent → e.g. `"Chrome · macOS"`. Mobile reuses existing `DEVICE_NAME` (`"iPhone"` / `"Android phone"`).
- **Transport**
  - REST `/api/*`: headers `x-maestro-device-id: <uuid>`, `x-maestro-device: <label>` (label header already exists).
  - SSE `/api/stream`: query `?token=<t>&did=<uuid>&device=<label>` (browser `EventSource` can't set headers; `?device=` already exists).

### Relay frames
- `remote` (relay → Mac) now carries a **list**: `{ type:'remote', devices: DeviceInfo[] }` where `DeviceInfo = { id: string; name: string|null; live: boolean; lastSeen: number }`. Replaces the old `{streams,lastSeen,name}` aggregate.
- `kick` (Mac → relay, **new**): `{ type:'kick', deviceId: string }`.
- Token rotation reuses the existing `hello` path: the Mac reconnects with the new `accessToken`; the relay updates `deck.accessToken` (server.ts:192) and, on a **changed** token, calls `devices.reset()`.

### Auth (relay onRequest hook)
- After the existing token check, read `x-maestro-device-id` (or `?did=`). If `devices.isRevoked(id)` → `401 { error:'This device was disconnected — enter the code to reconnect.', code:'device-revoked' }`. Otherwise `devices.touch(id, label)`.

## Components

### Relay — new module `apps/server/src/devices.ts`
Pure, Fastify-free, unit-testable `DeviceRegistry` (inject `now()` for tests):
- `touch(id, name)` — upsert + lastSeen (skips revoked).
- `addStream(id, name, res)` / `removeStream(id, res)` — SSE membership.
- `isRevoked(id)`.
- `kick(id): ServerResponse[]` — returns that device's open streams (caller `res.end()`s them), marks `revoked`, deletes entry.
- `list(): DeviceInfo[]` — prunes entries with no streams and `lastSeen` older than `ttlMs` (default 5 min).
- `reset()` — clears devices + revoked (new pairing epoch).
- Legacy: a request with no `deviceId` buckets under `id:'legacy'` so old clients still show as one entry; documented that legacy (pre-rebuild) clients can't be individually revoked. Moot once web+mobile ship.

### Relay — `apps/server/src/server.ts`
Instantiate the registry; wire onRequest (revoke check + touch), `/api/stream` (addStream/removeStream + did/device), `notifyRemote` (send `devices.list()`), the host WS handler (`kick` case + type union), and `reset()` on token change in `hello`. Remove the module-level `remoteName`/`remoteSeenAt`.

### Desktop electron
- `store.ts`: add `setAccessToken(token)` (persist); replace single-presence with `setRemoteDevices(list)` / `getRemoteDevices()`; `getPairing` returns `devices: DeviceInfo[]`.
- `relay.ts`: `remote` frame → `onRemote(DeviceInfo[])`; add `kick(deviceId)` and `updateToken(token)` (updates `opts.accessToken`, closes socket → auto-reconnect re-`hello`s with new token).
- `localApi.ts` + `main.ts`: dispatch methods `kickDevice({deviceId})` → `relay.kick`; `regeneratePairingCode()` → `store.setAccessToken(newPairingToken())` + `relay.updateToken(t)` + return new token. (Pass a small relay-control handle into `createDispatch`, or intercept in main's `maestro:call`.)

### Desktop renderer + web — `apps/desktop/src/lib/api.ts`, `screens/Settings.tsx`
- Types: `DeviceInfo[]` replaces `DevicePresence`; `PairingInfo.devices: DeviceInfo[]`.
- Methods: `kickDevice(deviceId)`, `regeneratePairingCode()` (desktop-only; REST fallback rejects).
- Web/REST branch: `ensureDeviceId()`, send the two headers, append `&did=&device=` to the SSE URL, and a **401 interceptor** → clear token+deviceId and show a re-pair gate (new lightweight code-entry overlay in the web build, which currently has none). Mint a fresh deviceId on pair.
- `DevicesPane`: render the device **list** (name, live/last-seen, **Disconnect** button per row → `kickDevice`), a **Regenerate code** action with a confirm sheet, and fixed copy.

### Mobile — `apps/mobile/src/api.ts` + Onboarding
Parity: `ensureDeviceId()` (minted on pair), `x-maestro-device-id` header + `?did=` on SSE, and a 401(`device-revoked`)→clear-token→route-to-Onboarding handler (mobile currently fails silently after a kick).

## Behavior
- **Disconnect** (one click): the device's streams close instantly, its id is revoked, its next request 401s → it shows the re-pair gate. Other devices unaffected.
- **Regenerate code** (with confirm): new code; all remotes 401 → re-pair with the new code.
- **Idle auto-drop**: a device with no stream and no activity for `ttlMs` falls off the list.
- **Ghost fixed**: presence is the real per-device list, not a sticky aggregate.

## Testing
- `apps/server`: add Vitest (first server-side tests). `devices.test.ts` covers touch/stream add+remove/list+live+lastSeen/prune/kick (closes streams + revokes)/isRevoked/reset/legacy bucket.
- `apps/desktop/electron`: Vitest for `store.setAccessToken` + device-list presence, and `relay.ts` `kick`/`updateToken` framing (existing harness).

## Shipping (operator-gated, outward-facing)
1. **Redeploy the relay** (Dokploy, manual) — wipes in-memory state; the Mac reconnects after.
2. **Rebuild the desktop app** (and a release if auto-update is wanted).
3. **Rebuild + redeploy the web remote** (`deploy/desktop-web`).
Build + tests happen first; deploy/rebuild/release only on explicit go-ahead.

## Out of scope (YAGNI)
Device rename, per-device permissions, geolocation, multiple decks, push-to-approve.
