# Account-based multi-tenant auth & device switching

**Date:** 2026-06-20
**Status:** Approved (design) — pending spec review → implementation plan
**Supersedes:** the pairing-code model (`deck.accessToken`, QR pairing) from #35 / `maestro-relay-split-brain`.

## Problem

The current relay identifies a tenant by **pairing code**: one code = one deck. When two
hosts (Macs) end up sharing a code, the relay can't disambiguate them, so a phone's
commands route to the wrong/half-open host and hang forever (the "send button spins"
bug). Pairing codes are also in-memory, drift on redeploy, and offer no real account
isolation.

We want **true isolation by account**:

- I register/login with an **account** (email + password).
- I log in on **multiple Macs**; the account knows about each of them.
- I log in on my **phone**; it shows **which of my Macs are online** and lets me
  **switch** which one I'm driving.
- 100 other people's Macs/accounts never conflict with mine.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Auth method | Email + password, **minimal** (no email verification; a successful login can act immediately) |
| Auth library | **Better Auth** (MIT, self-hosted, in-process), Postgres adapter |
| Primary DB | **PostgreSQL** (relational: accounts → devices → sessions) |
| Coordination/cache | **Redis** (presence, pub/sub fan-out, snapshot mirror, rate-limit) |
| Server | One **Fastify** service; auth + WebSockets + routing; **stateless**, horizontally scalable |
| Execution | Stays on each **Mac** (host). Server only does identity + registry + presence + routing. |
| Rollout | **Clean cutover** — replace pairing codes with account login; no dual path |

Out of scope for v1 (architecturally enabled, not built): OAuth/social, 2FA, email
verification, new-device approval, org/team sharing. Better Auth plugins cover these later.

## Terminology

- **Account** — an email+password identity. **The tenant boundary.** (Better Auth `user` row.)
- **Device** — anything that logs in. Two roles:
  - **Host** — a Mac running the desktop app (the execution engine).
  - **Remote** — a phone or web client that controls a host.
- **Session** — an authenticated login on one device (Better Auth session + token).
- **Active host** — the host a given remote is currently targeting.

## Architecture overview

```
 ┌─────────────┐   login (email/pw)         ┌──────────────────────────────┐
 │  Mac (host) │ ───────── session ───────► │  Server (Fastify, N stateless │
 │  desktop    │ ◄── cmd / events (WS) ────►│  instances)                   │
 └─────────────┘                            │   • Better Auth (email/pw)    │
 ┌─────────────┐   login (email/pw)         │   • Device registry           │
 │ Phone(remote)│ ──────── session ───────► │   • Routing (account→host)    │
 │  + web      │ ◄── snapshot / events ────►│   • Presence                  │
 └─────────────┘   pick active host         └──────┬───────────────┬────────┘
                                                   │               │
                                            ┌──────▼─────┐   ┌─────▼──────┐
                                            │ PostgreSQL │   │   Redis    │
                                            │ users      │   │ presence   │
                                            │ sessions   │   │ pub/sub    │
                                            │ devices    │   │ snapshots  │
                                            └────────────┘   └────────────┘
```

Every request and WS carries a Better Auth **session**, from which the server derives
`userId` (account) and `deviceId`. **Every** device query/route is filtered by `userId`,
so accounts are mutually invisible — that is the isolation guarantee.

## Data model (PostgreSQL)

Better Auth owns its core tables (created by its migration):

- `user` — `id, email, name, emailVerified, createdAt, updatedAt`. **This row IS the Account/tenant.**
- `account` — Better Auth's credential store (holds the hashed password for email/pw). *(Name collision with our "Account" concept — in this doc "Account" = `user`.)*
- `session` — `id, userId, token, expiresAt, ipAddress, userAgent, createdAt`.
- `verification` — token store (unused without email verification, still created).

We add one table:

```sql
device (
  id            text PRIMARY KEY,           -- stable deviceId persisted on the device
  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role          text NOT NULL,              -- 'host' | 'remote'
  name          text NOT NULL,              -- friendly, e.g. "Jonayed's MacBook Pro"
  platform      text NOT NULL,              -- 'macos' | 'ios' | 'android' | 'web'
  deck_id       text,                       -- hosts only: the host's deck identity
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_user_role_idx ON device (user_id, role);
```

Durable identity lives in Postgres. Ephemeral/large state does **not** (see Redis).

## Redis usage

- **Presence** — `presence:device:<deviceId>` = TTL key (~30s) refreshed by each device's
  heartbeat. A device is "online" iff its key exists. `online:user:<userId>` may mirror a
  set of online deviceIds for fast listing.
- **Snapshot mirror** — `snapshot:host:<hostDeviceId>` = latest host snapshot JSON
  (projects/sessions/jobs/assets), refreshed on each host push, TTL'd. Lets any instance
  serve a remote's reads instantly, even right after the remote (re)connects.
- **Pub/sub fan-out** (cross-instance) —
  - `cmd:host:<hostDeviceId>` — a command for a host; the instance holding that host's WS
    is subscribed and delivers it.
  - `events:host:<hostDeviceId>` — host→remote events; instances holding that account's
    subscribed remotes deliver to them.
  - `result:cmd:<cmdId>` — a host's reply to a command; the instance holding the requesting
    remote awaits it and resolves the open request.
- **Rate limiting** — per-account/IP login + command throttles.

## Server (Fastify, stateless, N instances)

**Auth.** Mount Better Auth (email/password). It exposes `POST /api/auth/sign-up`,
`/sign-in`, `/sign-out`, `GET /api/auth/session`, etc. Password hashing, session issuance,
and rotation are Better Auth's job.

**Auth middleware.** On every `/api/*` and on every WS upgrade, validate the session
(cookie or `Authorization: Bearer <token>`) → resolve `{ userId, deviceId }`. Reject with
401 if absent/invalid.

**WS endpoints.**
- **Host WS** (`/ws/host`): authenticated by session; the Mac presents `deviceId, deckId,
  name, platform`. Server **upserts** the `device` row (role=host), sets the presence key,
  and subscribes this instance to `cmd:host:<deviceId>`. The host streams snapshot + events
  up (written to the Redis snapshot mirror + published on `events:host:<deviceId>`).
- **Remote WS / SSE** (`/ws/remote` or `/api/stream`): authenticated by session; the remote
  declares its **active host** (`hostDeviceId`, must be `device.user_id === session.userId`).
  Server subscribes it to `events:host:<hostDeviceId>` and replays the Redis snapshot.

**Routing (account-scoped).**
- A remote targets a host by `hostDeviceId`. The server **asserts** that host belongs to the
  caller's `userId`; otherwise 404 (never reveal another account's devices).
- **Command:** remote → server instance I1 → publish `cmd:host:<H>` → instance I2 (holds H's
  WS) → H executes → publishes `result:cmd:<cmdId>` → I1 (awaiting) → response to remote.
  I1 keeps an in-memory pending map keyed by `cmdId`, resolved by the Redis result message;
  bounded by a timeout (fast 504 instead of an infinite hang).
- **Events:** host → I2 → publish `events:host:<H>` → every instance with a subscribed remote
  → delivered. (Single-instance deployments still work — pub/sub just loops back locally.)

**REST surface (account + active-host scoped).**
- `GET /api/devices` — the account's devices with `online`/`lastSeen` (drives the phone's
  device switcher). Hosts and remotes both listed; hosts flagged.
- `GET /api/hosts/:hostId/state` (or `/api/sync?host=<id>&since=<ts>`) — the host's snapshot
  from the Redis mirror, scoped + authorized to the account.
- `PATCH /api/devices/:id` — rename a device (e.g., friendly host name).
- `DELETE /api/devices/:id` — remove/sign-out a device.
- All existing command routes (`/api/jobs/*`, `/api/projects/*`, chat send, etc.) gain a
  required **`hostId`** (the active host) and are session-authed instead of token-authed.

**Isolation.** Every device/host lookup is `WHERE user_id = :sessionUserId`. There is no code
path that returns or targets a device outside the caller's account. This is the property that
makes "100 other desktops never conflict" true by construction.

**Scale.** Instances are stateless; all cross-instance state is in Redis (presence, pub/sub,
snapshot) and Postgres (identity). A device's WS lives on exactly one instance; everything
else routes by deviceId through Redis.

## Desktop (host) changes

- **Login UI** — email/password sign-in + register (Better Auth client). Session token stored
  in the OS keychain (existing secure-storage path).
- **Host registration** — on login, open the host WS authenticated by the session; send a
  stable `deviceId` (persisted in the store), `deckId`, a friendly `name` (default = machine
  name, editable), and `platform: 'macos'`. Server upserts the `device` row.
- **Remove pairing** — delete the pairing-code generation/QR display. The desktop no longer
  shows a code; identity is the logged-in account.
- Keep pushing snapshot + events over the (now session-authed) host WS.
- **Settings → Devices** lists the account's devices (server-sourced): your Macs + phones,
  each with online status; rename/remove.

## Mobile (remote) changes

- **Login/Register UI** — email/password (Better Auth client). Replaces the pairing/QR
  onboarding. Session token in SecureStore.
- **Device switcher** — `GET /api/devices` → list the account's **online Macs**; a header
  control to pick the **active host**. Switching re-points the SSE/event subscription and
  reloads that host's snapshot.
- **Active-host scoping** — all reads (`/api/sync`/snapshot) and commands carry the active
  `hostId`. The store keys cached data by host so switching is clean.
- **Auth transport** — drop `pairToken`; send the Better Auth session as `Bearer` on REST +
  SSE (`react-native-sse` supports the header; web uses the session cookie/`?token`).

## Migration / cutover

1. Stand up **Postgres** + **Redis** on Dokploy (Postgres needs a persistent volume; Redis
   can be ephemeral). Add `DATABASE_URL` + `REDIS_URL` to the `maestro-server` env.
2. Run Better Auth's migration + the `device` migration on boot (idempotent).
3. Ship the new server, desktop build, and mobile build together (clean cutover).
4. Register an account; log in on each Mac + the phone. No data migration — projects/sessions
   live on the Mac; there is no durable user data to port.
5. Remove pairing-code code paths (server `deck.accessToken` auth, desktop pairing UI, mobile
   QR onboarding).

## Security

- Better Auth handles password hashing (scrypt/argon2), session issuance + expiry/rotation.
- Account isolation enforced at the query layer (`user_id` scoping) — the core guarantee.
- WSS/HTTPS transport (existing reverse proxy).
- Command routing is bounded by a timeout → a dead/half-open host yields a fast error, never
  an infinite spin (the original bug, now impossible because routing is per-device + authed).
- Future: device approval, 2FA, OAuth (Better Auth plugins) — out of scope for v1.

## Components / boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `auth.ts` | Better Auth setup (email/pw, Postgres adapter), session helpers | Postgres |
| `db.ts` | Postgres pool + migrations | Postgres |
| `redis.ts` | Redis client + presence/pubsub/snapshot helpers | Redis |
| `devices.ts` | Device registry: upsert, list-by-account, presence, rename/remove | db, redis |
| `routing.ts` | Cross-instance command/event bridge (Redis pub/sub + pending map) | redis |
| `wsHost.ts` | Host WS endpoint (register, snapshot/event ingest) | auth, devices, redis |
| `wsRemote.ts` | Remote WS/SSE endpoint (subscribe to active host, fan-out) | auth, redis |
| routes | Account-scoped REST (`/api/devices`, `/api/sync`, command forwards) | auth, devices, routing |

Each unit has one purpose and a clear interface; the WS endpoints and routing can be tested
without a real Mac by driving fake host/remote sockets (as the current `server.tenant.test.ts`
does).

## Testing

- **Server (Vitest):** sign-up/in/out + session validation; device upsert + list scoped by
  account; presence online/offline (TTL); command routing + result correlation; **cross-account
  isolation** (account A cannot see or target account B's host → 404); command timeout →
  fast error (no hang). Use a disposable Postgres (testcontainers or a temp DB) and Redis
  (real or `ioredis-mock`). Cross-instance routing tested with two in-process server instances
  sharing one Redis.
- **Desktop / mobile:** typecheck; pure-function unit tests for the device-switcher selection
  and active-host scoping; auth-client wiring smoke test.

## Success criteria

1. Register + login with email/password on the server.
2. Two Macs logged into one account both appear as **hosts**, with live online status.
3. The phone logs into the same account, sees the online Macs, and **switches** which one it
   drives; commands + events go to the selected host only.
4. A second account's devices are completely invisible/unreachable from the first.
5. A dead/half-open host never hangs a command — bounded timeout, fast error.
6. Server runs as ≥2 stateless instances behind the proxy with no behavior change (Redis
   coordinates).
