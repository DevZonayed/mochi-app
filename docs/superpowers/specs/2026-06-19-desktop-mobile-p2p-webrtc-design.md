# Direct Desktop ↔ Mobile Realtime — WebRTC P2P (Mochi-specific design)

**Date:** 2026-06-19
**Status:** Approved direction (Option A). Ready for implementation planning.
**Branch:** `DevZonayed/p2p-better-ux`

## Decision

Move the **realtime data path** (phone→Mac commands + Mac→phone events) from
"always relayed through `maestro-relay`" to a **direct WebRTC DataChannel** when
the network allows, falling back to the existing relay automatically. Built
**code-complete now, infra-deferred** (Option A):

- All app/desktop/server code lands behind a **feature flag (default OFF)**.
- Ships using **public STUN** (LAN + easy-NAT cases work day one, no infra).
- **coturn (TURN)** and the **mobile EAS dev build** are operator-gated steps,
  documented here; the flag flips ON once they're in place. Full-P2P (incl. TURN
  + the Section 11 test matrix) is the end state — Option A is the safe road to it.
- The **existing relay is never removed** — it becomes one `Transport`
  implementation behind an abstraction, and remains the ultimate fallback **and**
  the WebRTC signaling carrier.

## Goals & success criteria

1. Direct host-to-host data path whenever the network allows; no server in the
   hot path in the common case.
2. Realtime, **ordered, lossless** app messages under normal and poor networks.
3. **Never regress reliability** — if P2P can't establish (restrictive NAT,
   hostile network, flag off, Mac offline), the relay path keeps working.
4. Transport is **swappable**; application code never branches on "P2P vs relay."
5. Network changes (Wi-Fi ↔ cellular) recover via ICE restart with no lost messages.

## The core adaptation: the relay already *is* a signaling server

The generic spec assumes a **new** signaling server + a **new** QR pairing
handshake. Mochi needs **neither**. `apps/server/src/server.ts` is already a
room-of-two that authenticates and routes messages between exactly the Mac (host
WS) and each remote (REST/SSE), with pairing, token auth, and per-device identity
(`x-maestro-device-id` / `?did=`) already solved.

Therefore:

- **No new signaling service, no second QR.** WebRTC signaling (SDP offer/answer
  + ICE candidates) rides the authenticated channel that already exists.
- **Reuse existing pairing.** The phone is already paired; signaling is gated by
  the same pairing token + device identity.
- The relay does double duty: **fallback transport + signaling coordinator**.

```
                  ┌─────────────────────────────────────────┐
                  │  VPS (Dokploy)                           │
                  │   maestro-relay (apps/server)            │
                  │   • host WS  • REST/SSE  • signal relay   │
                  │   • TURN-cred mint endpoint               │
                  │   coturn (operator-deployed; STUN+TURN)   │
                  └───────┬───────────────────────┬──────────┘
        (1) signaling      │                       │  (3) STUN discovery /
        over existing relay │                       │      TURN fallback
                  ┌────────┴─────────┐     ┌────────┴─────────┐
                  │ DESKTOP (Electron)│     │ MOBILE (Expo RN) │
                  │ offerer           │◄═══►│ answerer         │
                  │ hidden-renderer pc│ (2) │ react-native-    │
                  │ + main = brain    │DIRECT│ webrtc (dev build)│
                  └──────────────────┘ DTLS └──────────────────┘
```

- **(1)** Signaling: phone `POST /api/signal` → relay → host WS; Mac → SSE
  `signal` event (device-targeted) → phone. Used for offer/answer/ICE + ICE restart.
- **(2)** Once ICE picks a path, the DataChannel carries command/result/event
  envelopes **directly**, DTLS-encrypted.
- **(3)** STUN (public now; self-hosted later) for discovery; TURN (coturn) for
  the hard-NAT fallback. Total WebRTC failure → relay transport.

## Roles & what moves over P2P

- **Desktop = offerer.** Creates the `app` DataChannel (`ordered: true`) and the SDP offer.
- **Mobile = answerer.** Produces the SDP answer.
- **The phone is the transport decider** (it initiates commands and benefits from
  low latency). The Mac replies on whichever transport a command arrived on, and
  emits events over the channel when it's open, else over SSE. The
  `ReliableMessenger` dedupes by id, so any transient double-delivery is harmless.

Mapped to today's flows:

| Flow | Today | Over P2P |
|------|-------|----------|
| phone→Mac command + result | `POST /api/* → cmd() → host WS → onCommand` | `msg{kind:cmd}` over channel → dispatch → `msg{kind:result}` back |
| Mac→phone live events | `emit() → relay.event → sseSend → SSE` | `msg{kind:event}` over channel |
| phone GET snapshot reads | `GET /api/* ← relay cached snapshot` | **unchanged** — stays on relay snapshot (YAGNI; not latency-critical) |

## Components (real file map)

### Shared — new package `@maestro/realtime` (platform-agnostic core)
`packages/realtime/src/`
- `transport.ts` — `Transport` interface + `ConnState` union.
- `envelope.ts` — message envelope types + `makeEnvelope()`.
- `connectionManager.ts` — `ConnectionManager` (P2P-first, relay-fallback, timeout race).
- `reliableMessenger.ts` — outbox/ack/dedupe/flush + heartbeat.
- `ice.ts` — `buildIceServers({turn?})`; public-STUN default.

Pure TS, no DOM/Node/RN imports, so both apps consume it. Platform-specific
`P2PTransport` implementations live in each app (different WebRTC engines).

### Server — `apps/server/src/server.ts` (+ `signaling.ts`, `turn.ts`)
- **`signal` passthrough**, device-targeted (mirrors `cmd`/`event` plumbing):
  - `POST /api/signal` (phone→Mac): body `{ did, signal }` → host WS `{type:'signal', did, signal}`.
  - Host WS inbound `{type:'signal', did, signal}` (Mac→phone) → deliver to the
    **specific** SSE client for that `did` (not broadcast).
  - Requires tracking `did → ServerResponse` in the SSE registry (the connection
    already captures `?did=`). New helper `sseSendTo(did, 'signal', data)`.
- **TURN credentials:** `GET /api/turn-credentials` → `{ urls, username, credential, ttl }`
  via `turn.ts` `makeTurnCredential(secret, ttl)` (HMAC-SHA1, `use-auth-secret`).
  Static secret from env (`TURN_STATIC_SECRET`), **never** shipped to clients.
  Absent secret → endpoint returns STUN-only list (Option A default).

### Desktop — `apps/desktop/electron/`
- `relay.ts` `RelayClient`: extend the `onMessage` switch to handle inbound
  `{type:'signal'}` (→ forward to P2P layer) and add `signal(did, payload)` send,
  symmetric to existing `event()` / `kick()`.
- `p2p/host.ts` (main process) — `DesktopP2P`: owns a **hidden `BrowserWindow`**
  that runs the real Chromium `RTCPeerConnection` (best ICE/TURN, zero new runtime
  deps). Main ↔ hidden-renderer over IPC:
  - `p2p:signal-out` (renderer→main) → `RelayClient.signal(did, …)`.
  - `p2p:signal-in` (main→renderer) ← inbound relay `signal`.
  - `p2p:msg-in` / `p2p:msg-out` — channel envelopes.
  - `p2p:state` — channel open/close/ice state.
- `p2p/renderer.html` + `p2p/preload.ts` — the thin WebRTC pipe (offerer logic,
  data channel, ICE restart on `failed`). Carries only JSON; the Mac stays the brain.
- `main.ts` wiring: construct `DesktopP2P` next to `RelayClient`; route inbound
  `cmd` envelopes through the existing `dispatch()` and outbound `event` envelopes
  through the existing `emit()` (so P2P and relay share one execution path).
  Honor the same relay-blocked method list (desktop-only methods stay desktop-only).
- Feature flag in `store.ts` settings (`p2pEnabled`, default `false`).

### Mobile — `apps/mobile/`
- `package.json`: add `react-native-webrtc` + `@config-plugins/react-native-webrtc`.
- `app.json`: add the config plugin under `expo.plugins`.
- `eas.json` (new): a `development` profile producing a **dev client** (Expo Go
  cannot load native WebRTC).
- `src/p2p/transport.ts` — `MobileP2P` (answerer) using `react-native-webrtc`,
  signaling via `api.postSignal()` / the SSE `signal` event.
- `src/api.ts`: add `postSignal()`, surface the `signal` SSE event in
  `openLiveStream` listeners, and route `req()`-style commands + `useLive` events
  through the `ConnectionManager` when P2P is active (else today's REST+SSE).
- `src/p2p/useP2P.ts` — lifecycle hook: when paired + flag on, send `p2p-hello`,
  receive the offer, answer, manage state; expose connection state to the UI.

## Wire contracts

### Envelope (over the DataChannel)
```json
{ "id": "uuid", "kind": "cmd | result | event | ack | ping | pong | hello",
  "ts": 1718800000000, "payload": { "...": "..." } }
```
- `cmd` → `{ method, params }`; expects a `result`.
- `result` → `{ ok, result?, error?, statusCode? }` echoing the `cmd` id.
- `event` → `{ name, data }` (the same names `emit()` already uses: `job`,
  `session`, `approval`, `asset`, `comms`, `briefs`, `schedule`, `git-status`, …).
- `ack`/`ping`/`pong` → robustness layer only.

### Signaling (over the relay)
`signal` payloads: `{ kind: 'p2p-hello' | 'offer' | 'answer' | 'candidate' | 'bye',
sdp?, candidate? }`, always carried with the remote's `did` so the relay targets
the right peer and the Mac uses the right `RTCPeerConnection`.

## Transport abstraction
```ts
type ConnState = "connecting" | "connected" | "unstable" | "reconnecting" | "disconnected";
interface Transport {
  send(env: Envelope): void;
  isReady(): boolean;
  onMessage(cb: (e: Envelope) => void): void;
  onStateChange(cb: (s: ConnState) => void): void;
  close(): void;
}
```
- `ConnectionManager` builds the P2P transport, races it to `connected` within
  `p2pTimeoutMs` (default 8s); on success it's active, else it closes P2P and uses
  `RelayTransport`. Re-attempts P2P opportunistically on network change.
- `ReliableMessenger` sits above the manager: `outbox` (unacked) flushes on
  `connected`; `seen` set dedupes; optimistic echo hook for the UI; heartbeat
  ping/pong detects dead channels faster than ICE alone.

## Reliability modes
App messages/commands/results/events → **reliable + ordered** (default). No
unreliable/unordered channels in phase 1 (YAGNI).

## ICE / NAT
`buildIceServers()` returns public STUN by default; when
`GET /api/turn-credentials` yields TURN creds, it appends
`turn:…?transport=udp` and `turns:…:443?transport=tcp` (the hostile-network
lifeline). ICE restart (`iceRestart: true`, desktop re-offers) on `failed` or
detected network change.

## Security
- DTLS encryption is automatic on the DataChannel.
- Signaling is gated by the existing **pairing token + device identity**; a
  revoked device (`device-revoked`) can't signal.
- **No static TURN secret in clients** — time-limited HMAC creds minted server-side.
- No secrets in URLs/query for signaling payloads — they ride POST bodies / the WS frame.
- Optional later: desktop "approve this device for P2P?" prompt (deferred; pairing already gates).

## Rollout & flag
- `p2pEnabled` default **false**. With it off, behavior is byte-for-byte today's relay.
- With it on + public STUN: P2P on LAN/easy-NAT, relay everywhere else.
- With it on + coturn deployed + dev client installed: full P2P incl. hard-NAT.
- Log the **selected candidate-pair type** (host/srflx/relay) on connect, and every
  ICE state transition / restart, so we can see which path won.

## Operator-gated (out of repo, required for full-P2P end state)
1. **Deploy coturn** on the VPS: `use-auth-secret` + `TURN_STATIC_SECRET`,
   `tls-listening-port=443` with the domain cert, firewall 3478 (UDP/TCP) + 443
   (TCP/TLS), DNS-only (grey-cloud) record. Set `TURN_STATIC_SECRET` on the relay.
2. **Mobile dev client:** `eas build --profile development`, install on the test
   phone. **Ends Expo Go for the phone app** (accepted).

## Testing (Section-11 matrix; infra-gated items run after step 1–2 above)
1. Same Wi-Fi → **host** candidate direct.
2. Wi-Fi ↔ cellular → **srflx** direct (STUN hole-punch).
3. Restrictive/symmetric NAT → **relay (TURN)**; verify it still works.
4. `iceTransportPolicy:'relay'` forced-relay smoke test.
5. Network switch mid-session → `failed` → ICE restart → recover, **no lost
   messages** (verify via outbox/ack).
6. Airplane-mode on/off → queued messages flush on reconnect.
7. Poor network (link conditioner) → delayed, never dropped; UI shows sending→delivered.
8. Total WebRTC failure / flag off / Mac offline → relay path keeps working.
Debug: Electron `chrome://webrtc-internals` in the hidden window; structured ICE logs.

## Implementation phases (ordered)
- **P0** — `@maestro/realtime` package: `Transport`, `Envelope`, `ConnectionManager`,
  `ReliableMessenger`, `ice.ts` (+ unit tests). Wrap today's relay as `RelayTransport`
  on each side (no behavior change).
- **P1** — Server: `signal` device-targeted passthrough (`POST /api/signal`, SSE
  `signal`, `sseSendTo`) + `GET /api/turn-credentials` (STUN-only without secret).
- **P2** — Desktop: hidden-renderer `DesktopP2P` + `RelayClient.signal` + main wiring
  through existing `dispatch`/`emit`; `p2pEnabled` flag.
- **P3** — Mobile: deps + `app.json` plugin + `eas.json`; `MobileP2P` answerer;
  `api.postSignal` + SSE `signal`; route commands/events via `ConnectionManager`.
- **P4** — UX: optimistic send + sending/delivered states; a connection-state +
  selected-path indicator ("Direct" / "Relay"); ICE-restart on network change.
- **P5** — Operator steps (coturn + dev build), flip flag, run the test matrix.

## Out of scope (phase 1)
- Moving GET snapshot reads off the relay.
- Unreliable/unordered channels; media (audio/video).
- Multi-peer beyond the connected remotes the relay already tracks (design supports
  N peers via `did`-addressed signaling, but only the active remote is exercised).
