# P0 — `@maestro/realtime` Package Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans (inline) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. This is **P0 of the WebRTC P2P feature** (spec: `docs/superpowers/specs/2026-06-19-desktop-mobile-p2p-webrtc-design.md`). Phases P1–P5 (server signal, desktop, mobile, UX, ops) get their own plans.

**Goal:** Build the transport-agnostic realtime core — message envelope, `Transport` interface, `ConnectionManager` (P2P-first/relay-fallback), `ReliableMessenger` (outbox/ack/dedupe/heartbeat), and ICE-server builder — as a pure-TS workspace package both apps consume.

**Architecture:** A standalone source-TS package `packages/realtime` (no build step, consumed directly like `@maestro/design-tokens`). Zero runtime dependencies; platform-agnostic (no DOM/Node/RN imports) so desktop (vite), mobile (metro), and tsc all consume the same source. Platform-specific `Transport` implementations (WebRTC, relay wrappers) live in the apps in later phases.

**Tech Stack:** TypeScript 5.6 (ESM, `moduleResolution: bundler`), vitest 4 for tests, pnpm workspace + turbo.

## Global Constraints

- Package name `@maestro/realtime`, `"private": true`, `"type": "module"`, `"version": "0.0.0"` (matches monorepo convention).
- **Zero runtime dependencies.** No `uuid`, no `crypto.randomUUID` (absent in RN/Hermes) — IDs via a dependency-free `genId()`.
- **Extensionless relative imports** (matches `@maestro/design-tokens`).
- No DOM/Node-only globals beyond timers (`setTimeout`/`setInterval`/`clearInterval`/`clearTimeout`) + `Date`/`Math`/`Map`/`Set`. Timer handles typed as `ReturnType<typeof setInterval>`.
- Tests import `{ describe, it, expect, vi }` explicitly from `vitest` (no reliance on globals).
- Test command: `pnpm --filter @maestro/realtime test`. Typecheck: `pnpm --filter @maestro/realtime typecheck`.

---

## File Structure

- `packages/realtime/package.json` — package manifest + scripts.
- `packages/realtime/tsconfig.json` — bundler-resolution, strict, noEmit.
- `packages/realtime/index.ts` — re-export barrel.
- `packages/realtime/src/envelope.ts` — `Envelope`, `EnvelopeKind`, `genId()`, `makeEnvelope()`.
- `packages/realtime/src/transport.ts` — `ConnState`, `Transport` interface (compile-time only).
- `packages/realtime/src/ice.ts` — `IceServer`, `TurnCreds`, `buildIceServers()`.
- `packages/realtime/src/connectionManager.ts` — `ConnectionManager`, `ActiveKind`.
- `packages/realtime/src/reliableMessenger.ts` — `ReliableMessenger`, `MessengerConn`.
- `packages/realtime/src/__tests__/*.test.ts` — vitest specs + a `FakeTransport`/`FakeConn` double.

---

### Task 1: Package scaffold + envelope

**Files:**
- Create: `packages/realtime/package.json`, `packages/realtime/tsconfig.json`, `packages/realtime/index.ts`
- Create: `packages/realtime/src/envelope.ts`
- Test: `packages/realtime/src/__tests__/envelope.test.ts`

**Produces:**
- `type EnvelopeKind = 'cmd' | 'result' | 'event' | 'ack' | 'ping' | 'pong' | 'hello'`
- `interface Envelope { id: string; kind: EnvelopeKind; ts: number; payload?: unknown }`
- `genId(): string`
- `makeEnvelope(kind: EnvelopeKind, payload?: unknown, id?: string): Envelope`

- [ ] **Step 1 — scaffold files.** `package.json`:
```json
{
  "name": "@maestro/realtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Transport-agnostic realtime core (envelope, Transport, ConnectionManager, ReliableMessenger, ICE) shared by desktop + mobile.",
  "main": "./index.ts",
  "types": "./index.ts",
  "exports": { ".": "./index.ts" },
  "files": ["index.ts", "src"],
  "scripts": { "test": "vitest run", "test:watch": "vitest", "typecheck": "tsc --noEmit -p tsconfig.json" },
  "devDependencies": { "typescript": "^5.6.3", "vitest": "^4.1.9" }
}
```
`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"], "strict": true, "noEmit": true,
    "esModuleInterop": true, "skipLibCheck": true, "verbatimModuleSyntax": true
  },
  "include": ["index.ts", "src"]
}
```
`index.ts`:
```ts
export * from './src/envelope';
export * from './src/transport';
export * from './src/ice';
export * from './src/connectionManager';
export * from './src/reliableMessenger';
```

- [ ] **Step 2 — write the failing test** (`src/__tests__/envelope.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { genId, makeEnvelope } from '../envelope';

describe('envelope', () => {
  it('genId returns unique non-empty strings', () => {
    const a = genId(); const b = genId();
    expect(a).toBeTruthy(); expect(typeof a).toBe('string'); expect(a).not.toBe(b);
  });
  it('makeEnvelope fills id/kind/ts and keeps payload', () => {
    const e = makeEnvelope('cmd', { method: 'ping' });
    expect(e.kind).toBe('cmd'); expect(e.id).toBeTruthy();
    expect(typeof e.ts).toBe('number'); expect(e.payload).toEqual({ method: 'ping' });
  });
  it('makeEnvelope honors an explicit id (for ack/pong echo)', () => {
    expect(makeEnvelope('ack', undefined, 'xyz').id).toBe('xyz');
  });
});
```

- [ ] **Step 3 — run it (expect fail: module not found).** `pnpm install` first (links the new package), then `pnpm --filter @maestro/realtime test`. Expected: FAIL (`Cannot find module '../envelope'`).

- [ ] **Step 4 — implement** `src/envelope.ts`:
```ts
export type EnvelopeKind = 'cmd' | 'result' | 'event' | 'ack' | 'ping' | 'pong' | 'hello';

export interface Envelope {
  id: string;
  kind: EnvelopeKind;
  ts: number;
  payload?: unknown;
}

/** Dependency-free, RN/Hermes-safe id (message correlation, not security). */
export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeEnvelope(kind: EnvelopeKind, payload?: unknown, id?: string): Envelope {
  return { id: id ?? genId(), kind, ts: Date.now(), payload };
}
```

- [ ] **Step 5 — run test (expect PASS).** `pnpm --filter @maestro/realtime test`
- [ ] **Step 6 — commit.** `git add packages/realtime && git commit -m "feat(realtime): scaffold @maestro/realtime + message envelope"`

---

### Task 2: Transport interface + ICE builder

**Files:**
- Create: `packages/realtime/src/transport.ts`, `packages/realtime/src/ice.ts`
- Test: `packages/realtime/src/__tests__/ice.test.ts`

**Produces:**
- `type ConnState = 'connecting' | 'connected' | 'unstable' | 'reconnecting' | 'disconnected'`
- `interface Transport { send(e: Envelope): void; isReady(): boolean; onMessage(cb): void; onStateChange(cb): void; close(): void }`
- `interface IceServer { urls: string | string[]; username?: string; credential?: string }`
- `interface TurnCreds { host: string; username: string; credential: string }`
- `buildIceServers(turn?: TurnCreds): IceServer[]`

- [ ] **Step 1 — `transport.ts`** (types only, no runtime test; covered by typecheck):
```ts
import type { Envelope } from './envelope';

export type ConnState =
  | 'connecting' | 'connected' | 'unstable' | 'reconnecting' | 'disconnected';

export interface Transport {
  send(env: Envelope): void;
  isReady(): boolean;
  onMessage(cb: (env: Envelope) => void): void;
  onStateChange(cb: (s: ConnState) => void): void;
  close(): void;
}
```

- [ ] **Step 2 — failing test** (`src/__tests__/ice.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { buildIceServers } from '../ice';

describe('buildIceServers', () => {
  it('returns public STUN only when no TURN creds', () => {
    const s = buildIceServers();
    expect(s).toHaveLength(1);
    expect(s[0].urls).toContain('stun:stun.l.google.com:19302');
    expect(s[0].username).toBeUndefined();
  });
  it('appends self-host STUN + TURN/TURNS with creds when provided', () => {
    const s = buildIceServers({ host: 'turn.example.com', username: 'u', credential: 'c' });
    const flat = JSON.stringify(s);
    expect(flat).toContain('stun:turn.example.com:3478');
    expect(flat).toContain('turn:turn.example.com:3478?transport=udp');
    expect(flat).toContain('turns:turn.example.com:443?transport=tcp');
    const turn = s.find((e) => e.username === 'u');
    expect(turn?.credential).toBe('c');
  });
});
```

- [ ] **Step 3 — run (expect fail).** `pnpm --filter @maestro/realtime test ice`

- [ ] **Step 4 — implement `src/ice.ts`:**
```ts
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnCreds {
  host: string;
  username: string;
  credential: string;
}

const PUBLIC_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/** Public STUN always; self-hosted STUN+TURN(+TURNS/443) appended when creds exist. */
export function buildIceServers(turn?: TurnCreds): IceServer[] {
  const servers: IceServer[] = [{ urls: [...PUBLIC_STUN] }];
  if (turn) {
    servers.push({ urls: `stun:${turn.host}:3478` });
    servers.push({
      urls: [`turn:${turn.host}:3478?transport=udp`, `turns:${turn.host}:443?transport=tcp`],
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}
```

- [ ] **Step 5 — run (expect PASS).** `pnpm --filter @maestro/realtime test`
- [ ] **Step 6 — commit.** `git add packages/realtime && git commit -m "feat(realtime): Transport interface + ICE server builder"`

---

### Task 3: ReliableMessenger (outbox/ack/dedupe/heartbeat)

**Files:**
- Create: `packages/realtime/src/reliableMessenger.ts`
- Test: `packages/realtime/src/__tests__/reliableMessenger.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `makeEnvelope`, `EnvelopeKind` (Task 1); `ConnState` (Task 2).
- Produces:
  - `interface MessengerConn { send(env: Envelope): void; onMessage(cb): void; onStateChange(cb): void }`
  - `class ReliableMessenger { constructor(conn: MessengerConn, opts?: ReliableOptions); send(env: Envelope): void; onDeliver(cb): void; dispose(): void }`
  - `interface ReliableOptions { heartbeatMs?: number; onDeliver?; onState? }`

**Behavior contract:** reliable kinds (`cmd`/`result`/`event`/`hello`) are queued in an outbox until an `ack` with matching id arrives; on `connected` the outbox flushes; incoming reliable messages are acked + deduped (by id) before delivery; `ping`→auto `pong`; heartbeat pings while connected.

- [ ] **Step 1 — failing test** (with a `FakeConn` double + fake timers):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReliableMessenger } from '../reliableMessenger';
import { makeEnvelope } from '../envelope';
import type { Envelope } from '../envelope';
import type { ConnState } from '../transport';

class FakeConn {
  sent: Envelope[] = [];
  private msgCb: (e: Envelope) => void = () => {};
  private stateCb: (s: ConnState) => void = () => {};
  send(e: Envelope) { this.sent.push(e); }
  onMessage(cb: (e: Envelope) => void) { this.msgCb = cb; }
  onStateChange(cb: (s: ConnState) => void) { this.stateCb = cb; }
  // helpers
  recv(e: Envelope) { this.msgCb(e); }
  state(s: ConnState) { this.stateCb(s); }
}

describe('ReliableMessenger', () => {
  let conn: FakeConn;
  beforeEach(() => { conn = new FakeConn(); });

  it('queues a reliable message and sends it when connected', () => {
    const m = new ReliableMessenger(conn, { heartbeatMs: 0 });
    conn.state('connected');
    m.send(makeEnvelope('cmd', { method: 'x' }));
    expect(conn.sent.filter((e) => e.kind === 'cmd')).toHaveLength(1);
  });

  it('flushes the outbox on reconnect until acked', () => {
    const m = new ReliableMessenger(conn, { heartbeatMs: 0 });
    const env = makeEnvelope('cmd', { method: 'x' });
    m.send(env);                       // not connected yet
    conn.state('connected'); conn.sent.length = 0;
    conn.state('disconnected'); conn.state('connected');
    expect(conn.sent.some((e) => e.id === env.id)).toBe(true);   // resent
    conn.recv(makeEnvelope('ack', undefined, env.id));           // ack clears it
    conn.sent.length = 0; conn.state('connected');
    expect(conn.sent.some((e) => e.id === env.id)).toBe(false);  // no longer queued
  });

  it('acks + delivers an inbound message once, dedupes a repeat', () => {
    const delivered: Envelope[] = [];
    const m = new ReliableMessenger(conn, { heartbeatMs: 0, onDeliver: (e) => delivered.push(e) });
    conn.state('connected');
    const inbound = makeEnvelope('event', { name: 'job' });
    conn.recv(inbound); conn.recv(inbound);     // duplicate
    expect(delivered).toHaveLength(1);
    expect(conn.sent.filter((e) => e.kind === 'ack' && e.id === inbound.id)).toHaveLength(2);
  });

  it('replies to ping with pong', () => {
    const m = new ReliableMessenger(conn, { heartbeatMs: 0 });
    conn.state('connected');
    conn.recv(makeEnvelope('ping', undefined, 'p1'));
    expect(conn.sent.find((e) => e.kind === 'pong')?.id).toBe('p1');
  });

  it('emits heartbeat pings while connected', () => {
    vi.useFakeTimers();
    const m = new ReliableMessenger(conn, { heartbeatMs: 1000 });
    conn.state('connected');
    vi.advanceTimersByTime(2500);
    expect(conn.sent.filter((e) => e.kind === 'ping').length).toBeGreaterThanOrEqual(2);
    m.dispose(); vi.useRealTimers();
  });
});
```

- [ ] **Step 2 — run (expect fail).** `pnpm --filter @maestro/realtime test reliableMessenger`

- [ ] **Step 3 — implement `src/reliableMessenger.ts`:**
```ts
import { makeEnvelope } from './envelope';
import type { Envelope, EnvelopeKind } from './envelope';
import type { ConnState } from './transport';

export interface MessengerConn {
  send(env: Envelope): void;
  onMessage(cb: (env: Envelope) => void): void;
  onStateChange(cb: (s: ConnState) => void): void;
}

export interface ReliableOptions {
  heartbeatMs?: number;
  onDeliver?: (env: Envelope) => void;
  onState?: (s: ConnState) => void;
}

const RELIABLE: ReadonlySet<EnvelopeKind> = new Set<EnvelopeKind>(['cmd', 'result', 'event', 'hello']);

export class ReliableMessenger {
  private outbox = new Map<string, Envelope>();
  private seen = new Set<string>();
  private ready = false;
  private heartbeatMs: number;
  private hb: ReturnType<typeof setInterval> | null = null;
  private onDeliverCb: (env: Envelope) => void;
  private onStateCb: (s: ConnState) => void;

  constructor(private conn: MessengerConn, opts: ReliableOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    this.onDeliverCb = opts.onDeliver ?? (() => {});
    this.onStateCb = opts.onState ?? (() => {});
    this.conn.onStateChange((s) => this.onState(s));
    this.conn.onMessage((env) => this.receive(env));
  }

  send(env: Envelope): void {
    if (RELIABLE.has(env.kind)) this.outbox.set(env.id, env);
    this.trySend(env);
  }

  onDeliver(cb: (env: Envelope) => void): void { this.onDeliverCb = cb; }
  dispose(): void { this.stopHeartbeat(); }

  private onState(s: ConnState): void {
    this.ready = s === 'connected';
    this.onStateCb(s);
    if (this.ready) { this.flush(); this.startHeartbeat(); }
    else this.stopHeartbeat();
  }

  private receive(env: Envelope): void {
    if (env.kind === 'ack') { this.outbox.delete(env.id); return; }
    if (env.kind === 'ping') { this.trySend(makeEnvelope('pong', undefined, env.id)); return; }
    if (env.kind === 'pong') return;
    this.trySend(makeEnvelope('ack', undefined, env.id));   // acknowledge every reliable msg
    if (this.seen.has(env.id)) return;                      // dedupe
    this.seen.add(env.id);
    this.onDeliverCb(env);
  }

  private flush(): void {
    if (!this.ready) return;
    for (const env of this.outbox.values()) this.trySend(env);
  }
  private trySend(env: Envelope): void {
    try { this.conn.send(env); } catch { /* stays in outbox; flush on reconnect */ }
  }
  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.hb) return;
    this.hb = setInterval(() => this.trySend(makeEnvelope('ping')), this.heartbeatMs);
  }
  private stopHeartbeat(): void {
    if (this.hb) { clearInterval(this.hb); this.hb = null; }
  }
}
```

- [ ] **Step 4 — run (expect PASS).** `pnpm --filter @maestro/realtime test`
- [ ] **Step 5 — commit.** `git add packages/realtime && git commit -m "feat(realtime): ReliableMessenger (outbox/ack/dedupe/heartbeat)"`

---

### Task 4: ConnectionManager (P2P-first, relay-fallback)

**Files:**
- Create: `packages/realtime/src/connectionManager.ts`
- Test: `packages/realtime/src/__tests__/connectionManager.test.ts`

**Interfaces:**
- Consumes: `Transport`, `ConnState` (Task 2); `Envelope` (Task 1).
- Produces:
  - `type ActiveKind = 'p2p' | 'relay' | null`
  - `interface ConnectionManagerOptions { makeP2P: () => Transport; makeRelay: () => Transport; p2pTimeoutMs?: number }`
  - `class ConnectionManager { constructor(opts); connect(): Promise<ActiveKind>; send(env): void; isReady(): boolean; onMessage(cb): void; onStateChange(cb): void; get kind(): ActiveKind; close(): void }`

**Contract:** factories return already-started transports. `connect()` attaches listeners to the P2P transport and resolves `'p2p'` if it reaches `connected` (or is already `isReady()`) within `p2pTimeoutMs`; otherwise closes P2P, adopts relay, resolves `'relay'`. The active transport's messages/state forward to the manager's subscribers.

- [ ] **Step 1 — failing test** (shared `FakeTransport` double + fake timers):
```ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectionManager } from '../connectionManager';
import { makeEnvelope } from '../envelope';
import type { Transport, ConnState } from '../transport';
import type { Envelope } from '../envelope';

class FakeTransport implements Transport {
  ready = false; closed = false; sent: Envelope[] = [];
  private msgCb: (e: Envelope) => void = () => {};
  private stateCb: (s: ConnState) => void = () => {};
  send(e: Envelope) { this.sent.push(e); }
  isReady() { return this.ready; }
  onMessage(cb: (e: Envelope) => void) { this.msgCb = cb; }
  onStateChange(cb: (s: ConnState) => void) { this.stateCb = cb; }
  close() { this.closed = true; }
  emit(e: Envelope) { this.msgCb(e); }
  setState(s: ConnState) { this.ready = s === 'connected'; this.stateCb(s); }
}

describe('ConnectionManager', () => {
  it('adopts P2P when it connects before the timeout', async () => {
    const p2p = new FakeTransport(); const relay = new FakeTransport();
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => relay, p2pTimeoutMs: 8000 });
    const p = m.connect();
    p2p.setState('connected');
    expect(await p).toBe('p2p');
    expect(m.kind).toBe('p2p');
    expect(relay.closed).toBe(false);
  });

  it('falls back to relay when P2P never connects', async () => {
    vi.useFakeTimers();
    const p2p = new FakeTransport(); const relay = new FakeTransport();
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => relay, p2pTimeoutMs: 8000 });
    const p = m.connect();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await p).toBe('relay');
    expect(p2p.closed).toBe(true);
    expect(m.kind).toBe('relay');
    vi.useRealTimers();
  });

  it('adopts P2P immediately if already ready', async () => {
    const p2p = new FakeTransport(); p2p.ready = true;
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => new FakeTransport() });
    expect(await m.connect()).toBe('p2p');
  });

  it('routes send() to and forwards messages from the active transport', async () => {
    const p2p = new FakeTransport(); const got: Envelope[] = [];
    const m = new ConnectionManager({ makeP2P: () => p2p, makeRelay: () => new FakeTransport() });
    m.onMessage((e) => got.push(e));
    const p = m.connect(); p2p.setState('connected'); await p;
    m.send(makeEnvelope('cmd', { method: 'x' }));
    expect(p2p.sent).toHaveLength(1);
    p2p.emit(makeEnvelope('event', { name: 'job' }));
    expect(got).toHaveLength(1);
  });
});
```

- [ ] **Step 2 — run (expect fail).** `pnpm --filter @maestro/realtime test connectionManager`

- [ ] **Step 3 — implement `src/connectionManager.ts`:**
```ts
import type { Transport, ConnState } from './transport';
import type { Envelope } from './envelope';

export type ActiveKind = 'p2p' | 'relay' | null;

export interface ConnectionManagerOptions {
  makeP2P: () => Transport;
  makeRelay: () => Transport;
  p2pTimeoutMs?: number;
}

export class ConnectionManager {
  private makeP2P: () => Transport;
  private makeRelay: () => Transport;
  private p2pTimeoutMs: number;
  private active: Transport | null = null;
  private activeKind: ActiveKind = null;
  private onMessageCb: (env: Envelope) => void = () => {};
  private onStateCb: (s: ConnState) => void = () => {};

  constructor(opts: ConnectionManagerOptions) {
    this.makeP2P = opts.makeP2P;
    this.makeRelay = opts.makeRelay;
    this.p2pTimeoutMs = opts.p2pTimeoutMs ?? 8000;
  }

  async connect(): Promise<ActiveKind> {
    const p2p = this.makeP2P();
    if (await this.race(p2p)) { this.active = p2p; this.activeKind = 'p2p'; return 'p2p'; }
    try { p2p.close(); } catch { /* already gone */ }
    const relay = this.makeRelay();
    this.wire(relay);
    this.active = relay; this.activeKind = 'relay';
    return 'relay';
  }

  private wire(t: Transport): void {
    t.onMessage((m) => this.onMessageCb(m));
    t.onStateChange((s) => this.onStateCb(s));
  }

  /** Resolve true if t reaches `connected` (or already is) within the timeout. */
  private race(t: Transport): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(false), this.p2pTimeoutMs);
      t.onMessage((m) => this.onMessageCb(m));
      t.onStateChange((s) => {
        this.onStateCb(s);
        if (s === 'connected') { clearTimeout(timer); finish(true); }
      });
      if (t.isReady()) { clearTimeout(timer); finish(true); }
    });
  }

  send(env: Envelope): void { this.active?.send(env); }
  isReady(): boolean { return this.active?.isReady() ?? false; }
  onMessage(cb: (env: Envelope) => void): void { this.onMessageCb = cb; }
  onStateChange(cb: (s: ConnState) => void): void { this.onStateCb = cb; }
  get kind(): ActiveKind { return this.activeKind; }
  close(): void { try { this.active?.close(); } catch { /* */ } this.active = null; this.activeKind = null; }
}
```

- [ ] **Step 4 — run full suite (expect PASS).** `pnpm --filter @maestro/realtime test`
- [ ] **Step 5 — typecheck.** `pnpm --filter @maestro/realtime typecheck` → expect clean.
- [ ] **Step 6 — commit.** `git add packages/realtime && git commit -m "feat(realtime): ConnectionManager (P2P-first, relay-fallback)"`

---

## Self-Review

- **Spec coverage:** `Transport`/`ConnState` (spec §Transport abstraction) → Task 2. `ConnectionManager` race+fallback (spec §Transport abstraction) → Task 4. `ReliableMessenger` outbox/ack/dedupe/heartbeat (spec §Reliability) → Task 3. Envelope (spec §Wire contracts) → Task 1. `buildIceServers` STUN/TURN (spec §ICE/NAT) → Task 2. `RelayTransport` wrappers + `P2PTransport` impls are intentionally deferred to P2/P3 (platform-specific) — noted in plan header.
- **Placeholder scan:** none — every step has concrete code + commands.
- **Type consistency:** `Envelope`/`EnvelopeKind`/`ConnState`/`Transport`/`MessengerConn`/`TurnCreds` used identically across tasks; `makeEnvelope(kind,payload?,id?)` signature consistent; ack/pong reuse the source id via the 3rd arg.

## Verification gate (whole package)
- `pnpm --filter @maestro/realtime test` → all suites pass.
- `pnpm --filter @maestro/realtime typecheck` → no errors.
