/**
 * Phase 3B0 PRE-UI SECURITY HARDENING — host tiers of NOTE-2 (live revocation /
 * rotation propagation + read gate) and NOTE-3 (raw error disclosure).
 *
 * NOTE-2: the live `ShadowHostDataService` authority must carry the CURRENT
 * revoked-controller set + rotated scope-key id, so every command mode — read-only
 * enumeration included — denies a revoked controller and mismatched
 * epoch/account/expiry, WITHOUT waiting for an app restart. The enrollment runtime
 * now feeds that set into a freshly built plane and exposes it for the sidecar
 * refresh path.
 *
 * NOTE-3: a read-only command whose executor fails with a raw exception string
 * (path / SQL / connection detail) must NOT leak that text into the sealed command
 * ACK — the host sanitizes the ACK error at construction to a generic reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-preui-sec-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { ShadowHostCore, StaticShadowKeyProvider } from './shadow-host.js';
import { ShadowHostDataService, defineShadowCommandRegistry, type ShadowCommandRegistry } from './shadow-host-service.js';
import { SafeStorageVault, FileHostEnrollmentPersistence, type SafeStorageLike } from './shadow-host-adapters.js';
import { ShadowHostEnrollmentRuntime, type HostEnrollmentRecord } from './shadow-enrollment-host.js';
import { encryptWithKey, decryptWithKey } from '../sidecar/src/safe-storage-crypto.ts';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { deriveScopeKeyring, sealCommandEnvelope, openCommandAck, type ScopeKeyring } from '@maestro/realtime/shadowDataCodec';
import type { Fence, ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import type { HostCommandAck } from '@maestro/realtime';

const scopeKeyBytes = Buffer.alloc(32, 11);
const scopeKeyId = 'wk_preui';
const CTRL = 'ctrl_preui_1';
const fence: Fence = { accountId: 'acct_p', scopeId: 'account:acct_p', hostDeviceId: 'host_p', epoch: 3, leaseId: 'lease_p' };

let receiptDir = '';
let hostDir = '';
let keyring: ScopeKeyring;

/** A relay that queues one command and captures the host's posted ACK ciphertext. */
function makeRelay() {
  const queue = new Map<string, { commandId: string; controllerDeviceId: string; fence: Fence; envelopeCiphertext: string; payloadDigest: string }>();
  const acks = new Map<string, { ackCiphertext: string; ackDigest: string }>();
  const events: Array<Record<string, unknown>> = [];
  const fetch = async (url: string, init: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.pathname === '/api/shadow/commands' && method === 'GET') {
      const rows = [...queue.values()].filter((r) => !acks.has(r.commandId));
      return { status: 200, ok: true, text: async () => JSON.stringify(rows) };
    }
    if (u.pathname.endsWith('/ack') && method === 'POST') {
      const id = decodeURIComponent(u.pathname.split('/').slice(-2)[0]);
      const b = JSON.parse(init.body ?? '{}');
      acks.set(id, { ackCiphertext: b.ackCiphertext, ackDigest: b.ackDigest });
      return { status: 200, ok: true, text: async () => '{"ok":true}' };
    }
    if (u.pathname === '/api/shadow/events' && method === 'POST') {
      for (const e of JSON.parse(init.body ?? '{}').events ?? []) if (!events.some((x) => x.eventId === e.eventId)) events.push(e);
      return { status: 200, ok: true, text: async () => '{"accepted":1}' };
    }
    return { status: 404, ok: false, text: async () => '{"error":"no route"}' };
  };
  return { queue, acks, events, fetch };
}

async function enqueue(relay: ReturnType<typeof makeRelay>, commandId: string, method: string, params: unknown, controllerDeviceId = CTRL): Promise<void> {
  const envelopeCiphertext = await sealCommandEnvelope(node, keyring, fence, commandId, { method, params, idempotencyKey: `idem_${commandId}` });
  const payloadDigest = `sha256:${createHash('sha256').update(envelopeCiphertext, 'utf8').digest('hex')}`;
  relay.queue.set(commandId, { commandId, controllerDeviceId, fence, envelopeCiphertext, payloadDigest });
}

function buildService(
  registry: ShadowCommandRegistry,
  relay: ReturnType<typeof makeRelay>,
  opts: { leaseExpiresAt: number; revoked?: readonly string[]; nowFn?: () => number; svcFence?: Fence } = { leaseExpiresAt: Date.now() + 3_600_000 },
) {
  const provider = new StaticShadowKeyProvider(scopeKeyId, scopeKeyBytes);
  const core = new ShadowHostCore(hostDir, provider);
  const svc = new ShadowHostDataService({
    host: core, keys: provider, scopeKeyId, fence: opts.svcFence ?? fence, leaseExpiresAt: opts.leaseExpiresAt,
    revokedControllerDeviceIds: opts.revoked ?? [],
    session: async () => ({ accountId: fence.accountId, hostDeviceId: fence.hostDeviceId, sessionToken: 't', relayOrigin: 'http://127.0.0.1:1' }),
    signer: { keyId: 'sk', sign: async () => new Uint8Array(64) },
    transport: { fetch: relay.fetch as never, allowInsecureLoopback: true },
    commandRegistry: registry, capabilitiesFor: () => ['account.read'], now: opts.nowFn ?? Date.now,
  });
  return { core, svc };
}

async function decodeAck(relay: ReturnType<typeof makeRelay>, commandId: string): Promise<HostCommandAck | null> {
  const row = relay.acks.get(commandId);
  if (!row) return null;
  return openCommandAck(node, keyring, fence, commandId, row.ackCiphertext);
}

beforeEach(async () => {
  rmSync(hoisted.dir, { recursive: true, force: true });
  receiptDir = mkdtempSync(join(tmpdir(), 'preui-rcpt-'));
  hostDir = mkdtempSync(join(tmpdir(), 'preui-host-'));
  keyring = await deriveScopeKeyring(node, new Uint8Array(scopeKeyBytes), { accountId: fence.accountId, scopeId: fence.scopeId, keyId: scopeKeyId });
});
afterEach(() => {
  try { rmSync(hoisted.dir, { recursive: true, force: true }); rmSync(receiptDir, { recursive: true, force: true }); rmSync(hostDir, { recursive: true, force: true }); } catch { /* ignore */ }
  keyring?.dispose?.();
});

const CANARY = 'ENOENT open /Users/op/Library/maestro-shadow.db; connect postgres://u:p4ss@10.0.0.9:5432/db';

describe('NOTE-3 — host sanitizes a read-only command ACK error at construction', () => {
  it('never leaks a raw executor exception string into the sealed ACK', async () => {
    const relay = makeRelay();
    const registry = defineShadowCommandRegistry({
      // Mirrors headless `readOnlyControllerCommand`: a failing read-only executor
      // returns a raw message that would otherwise become the ACK reason.
      listProjects: { effectMode: 'read-only', execute: async () => ({ ok: false as const, code: 'exec-error', message: CANARY }) },
    });
    await enqueue(relay, 'cmd_ro_fail', 'listProjects', {});
    const { svc } = buildService(registry, relay);
    await svc.pollAndExecuteCommands();
    const ack = await decodeAck(relay, 'cmd_ro_fail');
    expect(ack).not.toBeNull();
    expect(ack!.status).toBe('rejected');
    expect(ack!.error?.message).toBe('command failed');            // generic
    expect(ack!.error?.message).not.toContain('/Users/');
    expect(ack!.error?.message).not.toContain('postgres');
    expect(ack!.error?.message).not.toContain('p4ss');
    svc.close();
  });
});

describe('NOTE-2 — live authority gates EVERY mode (read-only included)', () => {
  const roRegistry = () => {
    const calls: string[] = [];
    const registry = defineShadowCommandRegistry({
      listProjects: { effectMode: 'read-only', execute: async ({ commandId }) => { calls.push(commandId); return { ok: true as const, completion: { collection: 'command', op: 'checkpoint', entityId: commandId, revision: 1, payload: { ok: true } } }; } },
    });
    return { registry, calls };
  };

  it('a VALID controller read executes (no over-blocking)', async () => {
    const relay = makeRelay();
    const { registry, calls } = roRegistry();
    await enqueue(relay, 'cmd_ok', 'listProjects', {});
    const { svc } = buildService(registry, relay);
    await svc.pollAndExecuteCommands();
    expect(calls).toEqual(['cmd_ok']);
    svc.close();
  });

  it('a REVOKED controller read is denied at execution — the read-only executor never runs', async () => {
    const relay = makeRelay();
    const { registry, calls } = roRegistry();
    await enqueue(relay, 'cmd_revoked_ro', 'listProjects', {});
    const { svc } = buildService(registry, relay, { leaseExpiresAt: Date.now() + 3_600_000, revoked: [CTRL] });
    await svc.pollAndExecuteCommands();
    expect(calls).toEqual([]);                                       // zero read effect
    svc.close();
  });

  it('an EXPIRED lease denies a read at execution', async () => {
    const relay = makeRelay();
    const { registry, calls } = roRegistry();
    const now = 2_000_000_000_000;
    await enqueue(relay, 'cmd_expired_ro', 'listProjects', {});
    const { svc } = buildService(registry, relay, { leaseExpiresAt: now - 1, nowFn: () => now });
    await svc.pollAndExecuteCommands();
    expect(calls).toEqual([]);
    svc.close();
  });

  it('an ACCOUNT/epoch-mismatched service fence denies a read at execution', async () => {
    const relay = makeRelay();
    const { registry, calls } = roRegistry();
    await enqueue(relay, 'cmd_mismatch_ro', 'listProjects', {});
    // The command envelope is bound to `fence`; the service runs under a different epoch.
    const { svc } = buildService(registry, relay, { leaseExpiresAt: Date.now() + 3_600_000, svcFence: { ...fence, epoch: 99 } });
    await svc.pollAndExecuteCommands();
    expect(calls).toEqual([]);
    svc.close();
  });

  it('setAuthority feeds the revoked set + rotated scope-key id into the live authority snapshot', () => {
    const relay = makeRelay();
    const { registry } = roRegistry();
    const { svc } = buildService(registry, relay);
    expect(svc.authoritySnapshot().revokedControllerDeviceIds).toEqual([]);
    svc.setAuthority({ ...fence, epoch: 4 }, Date.now() + 60_000, [CTRL, 'ctrl_other'], 'wk_rotated');
    const snap = svc.authoritySnapshot();
    expect(snap.revokedControllerDeviceIds.sort()).toEqual([CTRL, 'ctrl_other'].sort());
    expect(snap.scopeKeyId).toBe('wk_rotated');
    expect(snap.epoch).toBe(4);
    svc.close();
  });
});

// ── NOTE-2 plumbing: the enrollment runtime feeds the revoked set into a freshly
//    built plane, and exposes the current live-authority inputs for the sidecar. ──
function mockSafeStorage(): SafeStorageLike & { key: Buffer } {
  const key = randomBytes(32);
  return { key, isEncryptionAvailable() { return true; }, encryptString(s: string) { return new Uint8Array(encryptWithKey(key, s)); }, decryptString(b: Uint8Array) { return decryptWithKey(key, Buffer.from(b)); } };
}

async function runningRuntimeWithControllers(persistFile: string, hostDeviceId: string, accountId: string) {
  const vault = new SafeStorageVault(mockSafeStorage());
  // Seed a persisted record whose controllers include one ACTIVE + one REVOKED.
  const seeded: Partial<HostEnrollmentRecord> = {
    version: 1, hostDeviceId, registered: false, revocationSeq: 1, controllers: [
      { controllerDeviceId: 'ctrl_active', grantId: 'g_active', keyId: 'wk_active', agreementPublicKey: 'a', transcriptHash: 't', status: 'active' },
      { controllerDeviceId: 'ctrl_gone', grantId: 'g_gone', keyId: 'wk_old', agreementPublicKey: 'a', transcriptHash: 't', status: 'revoked' },
    ], sessions: [],
  };
  writeFileSync(persistFile, JSON.stringify(seeded), { mode: 0o600 });
  const persistence = new FileHostEnrollmentPersistence(persistFile);
  const stub: ShadowFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
    if (path === '/api/shadow/lease') return { status: 200, ok: true, text: async () => JSON.stringify({ fence: { accountId, scopeId: `account:${accountId}`, hostDeviceId, epoch: 5, leaseId: 'lease_run' }, expiresAt: Date.now() + 120_000 }) };
    return { status: 404, ok: false, text: async () => '{"error":"no"}' };
  };
  const rt = new ShadowHostEnrollmentRuntime({ vault, persistence, session: { get: async () => ({ accountId, hostDeviceId, sessionToken: 'tok', relayOrigin: 'https://relay.test' }) }, transport: { fetch: stub } });
  const status = await rt.start();
  expect(status.state).toBe('running');
  return rt;
}

describe('NOTE-2 — enrollment runtime propagation surface', () => {
  it('exposes the revoked set, the active scope-key id, and a liveAuthority bundle', async () => {
    const rt = await runningRuntimeWithControllers(join(mkdtempSync(join(tmpdir(), 'preui-rt-')), 'rec.json'), 'host_p', 'acct_p');
    expect(rt.revokedControllerDeviceIds()).toEqual(['ctrl_gone']);
    expect(rt.currentScopeKeyId()).toBe('wk_active');
    const la = rt.liveAuthority();
    expect(la).not.toBeNull();
    expect(la!.revokedControllerDeviceIds).toEqual(['ctrl_gone']);
    expect(la!.scopeKeyId).toBe('wk_active');
    expect(la!.fence.epoch).toBe(5);
  });

  it('buildDataService seeds the live plane authority with the current revoked set + active scope-key id', async () => {
    const rt = await runningRuntimeWithControllers(join(mkdtempSync(join(tmpdir(), 'preui-rt2-')), 'rec.json'), 'host_p', 'acct_p');
    const svc = rt.buildDataService({ rootDir: mkdtempSync(join(tmpdir(), 'preui-plane-')), transport: { fetch: (async () => ({ status: 404, ok: false, text: async () => '{}' })) as never }, commandRegistry: defineShadowCommandRegistry({ listProjects: { effectMode: 'read-only', execute: async () => ({ ok: true as const, completion: { collection: 'command', op: 'checkpoint', entityId: 'x', revision: 1, payload: {} } }) } }) });
    expect(svc).not.toBeNull();
    const snap = svc!.authoritySnapshot();
    expect(snap.revokedControllerDeviceIds).toEqual(['ctrl_gone']);  // RED before buildHostAndService fix: []
    expect(snap.scopeKeyId).toBe('wk_active');
    svc!.close();
  });
});

describe('NOTE-2 — sidecar production wiring pins the revoked-set/rotation propagation', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const headless = readFileSync(join(here, '../sidecar/src/headless-main.ts'), 'utf8');
  const dispatch = readFileSync(join(here, 'shadow-host-dispatch.ts'), 'utf8');

  it('renew/resume refresh the live authority from the runtime truth (revoked set + scope-key id)', () => {
    // The single refresh helper reads liveAuthority() (fence + expiry + revoked set + scopeKeyId).
    expect(headless).toContain('function applyLiveHostAuthority');
    expect(headless).toContain('const plane = shadowHostData');
    expect(headless).toContain('plane.svc.setAuthority');
    expect(headless).toContain('rt.liveAuthority()');
    expect(headless).toContain('a.revokedControllerDeviceIds, a.scopeKeyId');
    // The old 2-arg setAuthority(renewed.fence, renewed.leaseExpiresAt) shape is gone.
    expect(headless).not.toContain('setAuthority(resumed.fence, resumed.leaseExpiresAt)');
    expect(headless).not.toContain('setAuthority(renewed.fence, renewed.leaseExpiresAt)');
    expect(headless).toContain('if (resumed) applyLiveHostAuthority(rt)');
    expect(headless).toContain('if (renewed) applyLiveHostAuthority(rt)');
  });

  it('keeps the host enrollment lease alive before any controller data plane exists', () => {
    const renewFn = headless.slice(headless.indexOf('async function renewShadowHostLease'), headless.indexOf('async function onShadowControllerRevoked'));
    const loopFn = headless.slice(headless.indexOf('function startShadowHostDataLoop'), headless.indexOf('const WEB_ROOT'));
    expect(renewFn).not.toContain('if (!shadowHostData) return');
    expect(renewFn).not.toContain('shadowHostData?.svc.status()');
    expect(renewFn).toContain('const rt = await getShadowHostFor()');
    expect(renewFn).toContain('rt.liveAuthority()');
    expect(loopFn.indexOf('await renewShadowHostLease()')).toBeLessThan(loopFn.indexOf('if (!svc) return'));
    expect(loopFn).toContain('await ensureShadowHostStarted(rt)');
  });

  it('a revoke tears down + rebuilds the live plane under the rotated scope key', () => {
    expect(headless).toContain('function onShadowControllerRevoked');
    expect(headless).toContain('afterRevoke: (rt) => onShadowControllerRevoked(rt)');
    // The dispatch invokes the hook after a successful revoke.
    expect(dispatch).toContain('await deps.afterRevoke?.(rt)');
  });
});
