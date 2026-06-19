# P2P (WebRTC) — Operator Runbook (P5)

The code (P0–P4) is built, behind the **`p2pEnabled` flag (default OFF)** so today's
relay behavior is unchanged. These are the steps **only you** can run to take it live.
Spec: `docs/superpowers/specs/2026-06-19-desktop-mobile-p2p-webrtc-design.md`.

## 1. Deploy coturn (TURN/STUN) on the VPS
Needed only for restrictive/symmetric-NAT networks; LAN + easy-NAT already work with
public STUN. Without coturn those hard cases fall back to the relay (still works).

```
apt-get install -y coturn
# /etc/turnserver.conf (essentials)
listening-port=3478
tls-listening-port=443
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<LONG_RANDOM>          # must equal the relay's TURN_STATIC_SECRET
realm=<your-domain>
cert=/etc/letsencrypt/live/turn.<domain>/fullchain.pem
pkey=/etc/letsencrypt/live/turn.<domain>/privkey.pem
no-tlsv1
no-tlsv1_1
no-multicast-peers
```
- Open firewall: **3478/udp + 3478/tcp** and **443/tcp** (TURNS) to the VPS.
- DNS: `turn.<domain>` as a **DNS-only (grey-cloud)** A record — Cloudflare's proxy
  does not forward TURN/UDP.

## 2. Point the relay at coturn (Dokploy env)
Set on the **maestro-server** service, then redeploy (manual — see the deploy gate):
```
TURN_STATIC_SECRET=<same LONG_RANDOM as static-auth-secret>
TURN_HOST=turn.<domain>
TURN_TTL_SECONDS=3600          # optional, default 3600
```
Verify: `GET https://api.nexalance.cloud/api/turn-credentials` (with a valid pairing
token) returns non-null `host/username/credential`. Unset → all-null → clients use
public STUN (the Option-A default).

## 3. Mobile dev client (ends Expo Go for the phone)
`react-native-webrtc` is native and cannot run in Expo Go.
```
cd apps/mobile
eas build --profile development --platform ios      # and/or android
# install the resulting dev client on the test phone, then:
npx expo start --dev-client
```
`eas.json` already has the `development` profile. (The web bundle + Expo Go keep using
the relay — the native module is dynamically imported only when P2P actually starts.)

## 4. Flip the flag
Desktop → **Settings → Connection → "Direct device connection (P2P)"** → ON.
The phone reads `settings.p2pEnabled` from the Mac's snapshot and begins attempting P2P
on its next live-stream open. Turn OFF to instantly revert to relay-only.

## 5. Verify it's actually direct
- Phone **Home** shows a green **"Direct"** pill once the channel is open.
- Desktop: open `chrome://webrtc-internals` (in an Electron window) → confirm a connected
  ICE pair; log the selected candidate type (host / srflx / relay).
- Pull the phone off Wi-Fi onto cellular mid-session → expect a brief reconnect (ICE
  restart) then recovery, **no lost events**.

## 6. Test matrix (spec §Testing)
1. Same Wi-Fi → **host** candidate (direct).
2. Wi-Fi ↔ cellular → **srflx** (STUN hole-punch, direct).
3. Restrictive/symmetric NAT → **relay (TURN)** — verify it still connects.
4. Force relay: temporarily set `iceTransportPolicy:'relay'` on the peer.
5. Network switch mid-session → ICE restart → recovery, no lost events.
6. Airplane-mode on/off → queued messages flush on reconnect.
7. Poor network (link conditioner) → delayed, not dropped.
8. Flag off / Mac offline → relay path keeps working.

## Notes / current scope
- **Events** ride P2P when the channel is up (the latency win); **commands stay on REST**
  (the desktop already supports P2P commands — a future step needs a phone-side
  REST-path→method map). No command-path regression risk.
- Nothing is pushed/deployed yet — 9 commits sit on `DevZonayed/p2p-better-ux`.
- Rollback at any layer: flag OFF (instant), or revert the branch.
