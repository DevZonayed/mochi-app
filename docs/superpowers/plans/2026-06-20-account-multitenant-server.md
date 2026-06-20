# Account Multi-Tenant — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the in-memory pairing-code relay into a real backend where email/password **accounts** own many **devices** (Macs = hosts, phones/web = remotes), with live presence and account-scoped routing of commands, events, and WebRTC signaling.

**Architecture:** One Fastify service, stateless, horizontally scalable. Identity in **PostgreSQL** (Better Auth manages `user`/`session`/`account`; we add `device`). Coordination in **Redis** (presence TTL, snapshot mirror, pub/sub for cross-instance command/event/signal routing). Execution stays on each Mac. Every request/WS carries a Better Auth session → `{userId, deviceId}`; every device lookup is `WHERE user_id = :sessionUserId` (isolation by construction).

**Tech Stack:** Fastify, `better-auth`, `pg` (node-postgres) + `kysely` (Better Auth's SQL adapter), `ioredis`, `@fastify/websocket` (existing), Vitest.

## Global Constraints

- pnpm workspace; install with `pnpm --filter @maestro/server add <pkg>` (NEVER npm — a stray `package-lock.json` breaks EAS/Docker; it's gitignored).
- Open-source/MIT deps only. No paid services.
- Env config: `DATABASE_URL` (Postgres), `REDIS_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, optional `TURN_*`. Provide safe local defaults; never hardcode secrets.
- TypeScript strict; `pnpm --filter @maestro/server typecheck` and `pnpm --filter @maestro/server test` must pass before each commit.
- Account isolation is non-negotiable: no route or WS path may return or target a device whose `user_id` ≠ the session's `userId`.
- Command/signal routing MUST be bounded by a timeout — never an unbounded await (this is the original "send spins forever" bug).
- Tests use a disposable Postgres (env `TEST_DATABASE_URL`, default a local `maestro_test` db) and a real or mocked Redis (`ioredis-mock`). Skip-with-clear-log if `TEST_DATABASE_URL` is unreachable, so the suite never hangs CI.

---

## File Structure

- `apps/server/src/db.ts` — Postgres pool (`pg`) + Kysely instance + migration runner.
- `apps/server/src/migrations/0001_devices.ts` — the `device` table (Better Auth owns its own migrations).
- `apps/server/src/auth.ts` — Better Auth instance (email/password, Postgres) + `getSession(req)` helper.
- `apps/server/src/redis.ts` — ioredis client(s) + presence/snapshot/pubsub helpers.
- `apps/server/src/devices.ts` — device registry: `upsertDevice`, `listDevicesForUser`, presence read/write.
- `apps/server/src/routing.ts` — cross-instance bridge: `forwardCommand`, `publishEvent`, `routeSignal`, pending-result map.
- `apps/server/src/authHook.ts` — Fastify `onRequest` + WS auth: resolve `{userId, deviceId}` or reject.
- `apps/server/src/wsHost.ts` — host WS endpoint.
- `apps/server/src/wsRemote.ts` — remote WS/SSE endpoint.
- `apps/server/src/webrtc.ts` — session-authed TURN creds + signaling helpers.
- `apps/server/src/server.ts` — wire it all (replaces the deck model).
- Tests alongside: `*.test.ts` (Vitest), plus `apps/server/src/account.integration.test.ts`.

---

## Task 1: Dependencies + Postgres pool & migration runner

**Files:**
- Modify: `apps/server/package.json` (deps)
- Create: `apps/server/src/db.ts`
- Test: `apps/server/src/db.test.ts`

**Interfaces:**
- Produces: `getDb(): Kysely<DB>`, `getPool(): Pool`, `runMigrations(): Promise<void>`, `closeDb(): Promise<void>`. `DB` type includes `device` table (Better Auth tables typed loosely as `Record<string,unknown>` where needed).

- [ ] **Step 1: Install deps**

```bash
pnpm --filter @maestro/server add better-auth pg kysely ioredis
pnpm --filter @maestro/server add -D @types/pg ioredis-mock
```

- [ ] **Step 2: Write failing test** (`db.test.ts`)

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { getDb, runMigrations, closeDb } from './db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
describe.skipIf(!HAS_DB)('db', () => {
  afterAll(async () => { await closeDb(); });
  it('runs migrations and the device table exists', async () => {
    await runMigrations();
    const rows = await getDb().selectFrom('device').selectAll().execute();
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test, expect FAIL** (`pnpm --filter @maestro/server test src/db.test.ts`) — module not found.

- [ ] **Step 4: Implement `db.ts`**

```ts
import { Pool } from 'pg';
import { Kysely, PostgresDialect, Migrator } from 'kysely';
import { migrations } from './migrations/index.js';

export interface DeviceTable {
  id: string; user_id: string; role: 'host' | 'remote';
  name: string; platform: string; deck_id: string | null;
  last_seen_at: Date; created_at: Date; updated_at: Date;
}
export interface DB { device: DeviceTable }

const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/maestro';
let pool: Pool | null = null;
let db: Kysely<DB> | null = null;

export function getPool(): Pool { return (pool ??= new Pool({ connectionString: url })); }
export function getDb(): Kysely<DB> {
  return (db ??= new Kysely<DB>({ dialect: new PostgresDialect({ pool: getPool() }) }));
}
export async function runMigrations(): Promise<void> {
  const migrator = new Migrator({ db: getDb(), provider: { getMigrations: async () => migrations } });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}
export async function closeDb(): Promise<void> { await db?.destroy(); db = null; pool = null; }
```

- [ ] **Step 5: Create `migrations/0001_devices.ts` + `migrations/index.ts`**

```ts
// 0001_devices.ts
import { Kysely, sql } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createTable('device')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('platform', 'text', (c) => c.notNull())
    .addColumn('deck_id', 'text')
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('device_user_role_idx').on('device').columns(['user_id', 'role']).execute();
}
export async function down(db: Kysely<any>): Promise<void> { await db.schema.dropTable('device').execute(); }
```
```ts
// index.ts
import * as m0001 from './0001_devices.js';
export const migrations = { '0001_devices': m0001 };
```

- [ ] **Step 6: Run test, expect PASS** (when `TEST_DATABASE_URL` set; otherwise skipped — note that in the run output).

- [ ] **Step 7: Commit**
```bash
git add apps/server/package.json apps/server/src/db.ts apps/server/src/migrations pnpm-lock.yaml
git commit -m "feat(server): Postgres pool + Kysely + device migration"
```

---

## Task 2: Better Auth (email/password) on Postgres

**Files:**
- Create: `apps/server/src/auth.ts`
- Test: `apps/server/src/auth.test.ts`

**Interfaces:**
- Produces: `auth` (Better Auth instance), `getSessionFromHeaders(headers): Promise<{userId:string}|null>`. Mounts at `/api/auth/*`.

- [ ] **Step 1: Write failing test** — sign up a user, then resolve their session.

```ts
import { describe, it, expect } from 'vitest';
import { auth } from './auth.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('auth', () => {
  it('signs up and returns a session token', async () => {
    const res = await auth.api.signUpEmail({ body: { email: `u${Date.now()}@x.dev`, password: 'pw-12345678', name: 'U' } });
    expect(res.token).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing).

- [ ] **Step 3: Implement `auth.ts`**

```ts
import { betterAuth } from 'better-auth';
import { getPool } from './db.js';

export const auth = betterAuth({
  database: getPool(),                       // Better Auth creates/uses user/session/account/verification
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  secret: process.env.BETTER_AUTH_SECRET || 'dev-insecure-secret-change-me',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:8787',
  trustedOrigins: ['*'],                     // remotes are native apps; tighten for web origins later
});

export async function getSessionFromHeaders(headers: Headers | Record<string, string>) {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const s = await auth.api.getSession({ headers: h });
  return s?.user?.id ? { userId: s.user.id } : null;
}
```

- [ ] **Step 4: Generate Better Auth tables** — add to `runMigrations()` a call to Better Auth's migrator, OR run `npx @better-auth/cli migrate` in deploy. For tests, call `auth` once so its schema is created (Better Auth auto-creates with the pg adapter on first use in dev). Document the deploy migration command in Task 11.

- [ ] **Step 5: Run, expect PASS** (with TEST_DATABASE_URL).

- [ ] **Step 6: Commit** `feat(server): Better Auth email/password on Postgres`.

---

## Task 3: Redis client + presence/snapshot/pubsub helpers

**Files:**
- Create: `apps/server/src/redis.ts`
- Test: `apps/server/src/redis.test.ts` (uses `ioredis-mock`)

**Interfaces:**
- Produces: `markOnline(deviceId, ttlSec)`, `isOnline(deviceId): Promise<boolean>`, `setSnapshot(hostId, json)`, `getSnapshot(hostId)`, `pub` / `sub` clients, `publish(channel, msg)`, `subscribe(channel, cb): () => void`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { markOnline, isOnline, setSnapshot, getSnapshot } from './redis.js';
describe('redis helpers', () => {
  it('presence reflects markOnline', async () => {
    await markOnline('dev-1', 30); expect(await isOnline('dev-1')).toBe(true);
    expect(await isOnline('nope')).toBe(false);
  });
  it('snapshot round-trips', async () => {
    await setSnapshot('host-1', { projects: [{ id: 'p1' }] });
    expect(await getSnapshot('host-1')).toEqual({ projects: [{ id: 'p1' }] });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `redis.ts`** (use `ioredis-mock` when `NODE_ENV==='test'` or `REDIS_URL` unset).

```ts
import Redis from 'ioredis';
const makeClient = (): Redis => {
  if (process.env.NODE_ENV === 'test' || !process.env.REDIS_URL) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Mock = require('ioredis-mock'); return new Mock();
  }
  return new Redis(process.env.REDIS_URL);
};
export const pub = makeClient();
export const sub = makeClient();
const main = makeClient();
export const markOnline = (id: string, ttl = 30) => main.set(`presence:device:${id}`, '1', 'EX', ttl);
export const isOnline = async (id: string) => (await main.exists(`presence:device:${id}`)) === 1;
export const setSnapshot = (host: string, j: unknown) => main.set(`snapshot:host:${host}`, JSON.stringify(j), 'EX', 120);
export const getSnapshot = async (host: string) => { const v = await main.get(`snapshot:host:${host}`); return v ? JSON.parse(v) : null; };
export const publish = (ch: string, m: unknown) => pub.publish(ch, JSON.stringify(m));
export function subscribe(ch: string, cb: (m: any) => void): () => void {
  const c = makeClient(); void c.subscribe(ch);
  const handler = (chan: string, raw: string) => { if (chan === ch) { try { cb(JSON.parse(raw)); } catch { /* */ } } };
  c.on('message', handler); return () => { c.removeListener('message', handler); void c.unsubscribe(ch); void c.quit(); };
}
```

- [ ] **Step 4: Run, expect PASS. Step 5: Commit** `feat(server): Redis presence/snapshot/pubsub helpers`.

---

## Task 4: Device registry (upsert, list-by-account, presence merge)

**Files:** Create `apps/server/src/devices.ts`; Test `apps/server/src/devices.account.test.ts`

**Interfaces:**
- Consumes: `getDb` (Task 1), `isOnline` (Task 3).
- Produces: `upsertDevice(input)`, `listDevicesForUser(userId): Promise<DeviceView[]>` where `DeviceView = { id,role,name,platform,deckId,online,lastSeen }`, `assertHostInAccount(userId, hostId): Promise<DeviceRow>` (throws `{statusCode:404}` if not owned).

- [ ] **Step 1: Failing test** — two users; each only sees their own devices; isolation holds.

```ts
import { describe, it, expect } from 'vitest';
import { upsertDevice, listDevicesForUser, assertHostInAccount } from './devices.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('devices isolation', () => {
  it('lists only the owner\'s devices and blocks cross-account host access', async () => {
    await upsertDevice({ id: 'A-host', userId: 'userA', role: 'host', name: 'A Mac', platform: 'macos', deckId: 'dA' });
    await upsertDevice({ id: 'B-host', userId: 'userB', role: 'host', name: 'B Mac', platform: 'macos', deckId: 'dB' });
    const a = await listDevicesForUser('userA');
    expect(a.map((d) => d.id)).toEqual(['A-host']);
    await expect(assertHostInAccount('userA', 'B-host')).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

- [ ] **Step 2: Run FAIL. Step 3: Implement `devices.ts`** (upsert via Kysely `onConflict`, list joins presence via `isOnline`). **Step 4: Run PASS. Step 5: Commit** `feat(server): account-scoped device registry`.

---

## Task 5: Auth hook (REST + WS) → `{userId, deviceId}`

**Files:** Create `apps/server/src/authHook.ts`; Test `apps/server/src/authHook.test.ts`

**Interfaces:**
- Consumes: `getSessionFromHeaders` (Task 2).
- Produces: Fastify `onRequest` hook that sets `req.userId`; `authWs(req): Promise<{userId,deviceId}|null>`. `deviceId` from header `x-maestro-device-id` / query `did`.

- [ ] Steps: failing test (request without session → 401; with valid session → `req.userId` set), implement (skip `/api/auth/*`, `/health`, `/`), pass, commit `feat(server): session auth hook for REST + WS`.

---

## Task 6: `GET /api/devices` (account-scoped + presence)

**Files:** Modify `apps/server/src/server.ts`; Test in `account.integration.test.ts`
- [ ] Failing integration test: sign up user, simulate a host registration row, `GET /api/devices` with session → returns that host with `online`. A second account's GET never sees it. Implement route (uses `listDevicesForUser(req.userId)`), pass, commit `feat(server): GET /api/devices`.

---

## Task 7: Host WS — register, presence heartbeat, snapshot/event ingest

**Files:** Create `apps/server/src/wsHost.ts`; Test `apps/server/src/wsHost.test.ts`

**Interfaces:**
- Consumes: `authWs` (T5), `upsertDevice` (T4), `markOnline`/`setSnapshot`/`publish` (T3).
- Produces: WS at `/ws/host`. On hello `{deviceId, deckId, name, platform}` → upsert (role=host) + `markOnline` + subscribe `cmd:host:<deviceId>` + `signal:device:<deviceId>`. On `{type:'state', state}` → `setSnapshot`. On `{type:'event', name, data}` → `publish(events:host:<id>)`. On `{type:'result', id, ...}` → `publish(result:cmd:<id>)`. On `{type:'signal', toDeviceId, signal}` → assert same account → `publish(signal:device:<toDeviceId>)`. Heartbeat `markOnline` every 20s; on close clear presence.

- [ ] TDD: failing test (open host WS with a session, send hello, assert a `device` row + presence + snapshot stored). Implement. Pass. Commit `feat(server): host WS (register/presence/snapshot/events)`.

---

## Task 8: Remote WS/SSE — subscribe active host + fan-out

**Files:** Create `apps/server/src/wsRemote.ts`; Test `apps/server/src/wsRemote.test.ts`
- [ ] Remote connects with session + `hostId` (active host). Assert `assertHostInAccount`. Subscribe `events:host:<hostId>` and `signal:device:<remoteDeviceId>`; replay `getSnapshot(hostId)` as `hello`. Forward incoming host events to the remote. TDD: a host publishes an event → the subscribed remote receives it; a remote for account B cannot subscribe to account A's host (404). Commit `feat(server): remote WS/SSE active-host fan-out`.

---

## Task 9: Command routing (remote→host) with timeout + result correlation

**Files:** Create `apps/server/src/routing.ts`; Modify `server.ts` (forward routes); Test `routing.test.ts`

**Interfaces:**
- Produces: `forwardCommand(userId, hostId, method, params): Promise<unknown>` — asserts host in account, `publish(cmd:host:<hostId>, {cmdId, method, params})`, awaits `result:cmd:<cmdId>` via a pending map, **rejects with `{statusCode:504}` after `CMD_TIMEOUT_MS` (10 min)**, `{statusCode:503}` if host offline.

- [ ] TDD: two in-process instances sharing one (mock) Redis: instance-1 `forwardCommand`, a fake host on instance-2 replies → resolves; no reply → 504 within a short test timeout (inject `CMD_TIMEOUT_MS`). Cross-account host → 404. Commit `feat(server): account-scoped command routing with bounded timeout`.

---

## Task 10: WebRTC — session-authed TURN creds + signaling route

**Files:** Create `apps/server/src/webrtc.ts`; Modify `server.ts`; Test `webrtc.test.ts`

**Interfaces:**
- Produces: `GET /api/turn-credentials` (session-gated) → `{ host, username, credential, ttl }` (HMAC over `TURN_SECRET`; all-null when unconfigured). `POST /api/signal` `{ toDeviceId, signal }` → assert both devices same account → `publish(signal:device:<toDeviceId>)`. (Host→remote signals already handled in T7.)

- [ ] TDD: signal from remote to its active host is delivered to that host's `signal:device` subscriber; a signal aimed at another account's device → 404; turn-credentials without a session → 401, with a session → creds (or nulls if unconfigured). Commit `feat(server): WebRTC signaling + session-authed TURN creds`.

---

## Task 11: Wire `server.ts`, remove pairing model, deploy config

**Files:** Modify `apps/server/src/server.ts` (remove `deck`/`accessToken`/pairing routes, mount auth + hooks + WS + routes; call `runMigrations()` + Better Auth migrate on boot); update `apps/server/docker-compose.dokploy.yml` (add Postgres + Redis services/volumes) and document env.
- [ ] Replace the `Map<deckId,Deck>` deck model and `deckByAccessToken` with the account/device model. Delete `server.tenant.test.ts` / `server.deck-lifecycle.test.ts` (obsolete) or rewrite as account tests. Boot runs migrations. Add `DATABASE_URL`/`REDIS_URL`/`BETTER_AUTH_SECRET` to compose + a `.env.example`. Document the Dokploy deploy: add a Postgres service (persistent volume) + Redis service, set env, deploy.
- [ ] Full suite green + typecheck. Commit `feat(server): account multi-tenant server (remove pairing model)`.

---

## Self-review notes
- Every spec section maps to a task: auth→T2, data model→T1/T4, Redis→T3, devices/isolation→T4/T6, host WS→T7, remote WS→T8, routing+timeout→T9, WebRTC→T10, migration/deploy→T11.
- No unbounded awaits (T9 timeout). No cross-account path (T4 `assertHostInAccount` used by T6/T8/T9/T10).
- Desktop + mobile are SEPARATE plans (next), consuming this server's API: `/api/auth/*`, `/api/devices`, `/ws/host`, `/ws/remote`, `/api/sync?host=`, `/api/turn-credentials`, `/api/signal`, and the account-scoped command routes.
