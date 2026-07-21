/**
 * HIGH-2 reviewer reproduction + fix proof — execution-time AUTHORITY (lease/fence/epoch/
 * revoke) enforcement at the product-mutation linearization point.
 *
 * Exploit: a command ingested + CLAIMED while the lease is valid, then a crash BEFORE
 * execute, then a restart AFTER `leaseExpiresAt` (still within the 10-min command deadline).
 * The recovered command must produce ZERO product effect for ALL SIX actions — the fix adds
 * `ShadowHostCore.assertCurrentAuthority` (fail-closed before execute) + a host-supplied
 * synchronous in-adapter guard immediately before the first durable Store mutation. Also
 * covers controller revoke (revokedControllerDeviceIds) and a matching VALID control that
 * still applies (no over-blocking).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-authz-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { ShadowHostCore, StaticShadowKeyProvider } from './shadow-host.js';
import { ShadowHostDataService, defineShadowCommandRegistry } from './shadow-host-service.js';
import { ShadowActionReceiptStore } from './shadow-action-receipt.js';
import { buildControllerActionRegistryEntries, type ControllerActionEngine } from './shadow-controller-actions.js';
import { createHash } from 'node:crypto';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { deriveScopeKeyring, sealCommandEnvelope, type ScopeKeyring } from '@maestro/realtime/shadowDataCodec';
import type { Fence, ShadowCapability } from '@maestro/realtime';

const now = 1_800_000_000_000;
const LEASE = now + 60_000;          // lease valid until now+60s
const AFTER_EXPIRY = now + 120_000;  // restart past expiry, still < 10-min deadline
const scopeKeyBytes = Buffer.alloc(32, 7);
const scopeKeyId = 'wk_authz';
const CTRL = 'ctrl_authz_1';
const fence: Fence = { accountId: 'acct_1', scopeId: 'account:acct_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'l' };
const ALL_CAPS: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'];

let receiptDir = '';
let hostDir = '';

function makeRelay() {
  const queue = new Map<string, { commandId: string; controllerDeviceId: string; fence: Fence; envelopeCiphertext: string; payloadDigest: string }>();
  const events: Array<Record<string, unknown>> = [];
  const acks = new Map<string, string>();
  const fetch = async (url: string, init: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (u.pathname === '/api/shadow/commands' && method === 'GET') {
      const rows = [...queue.values()].filter((r) => !acks.has(r.commandId));
      return { status: 200, ok: true, text: async () => JSON.stringify(rows) };
    }
    if (u.pathname.endsWith('/ack') && method === 'POST') {
      const id = decodeURIComponent(u.pathname.split('/').slice(-2)[0]);
      acks.set(id, JSON.parse(init.body ?? '{}').ackDigest);
      return { status: 200, ok: true, text: async () => '{"ok":true}' };
    }
    if (u.pathname === '/api/shadow/events' && method === 'POST') {
      for (const e of JSON.parse(init.body ?? '{}').events ?? []) if (!events.some((x) => x.eventId === e.eventId)) events.push(e);
      return { status: 200, ok: true, text: async () => '{"accepted":1}' };
    }
    return { status: 404, ok: false, text: async () => '{"error":"no route"}' };
  };
  return { queue, events, acks, fetch };
}

let keyring: ScopeKeyring;
async function enqueue(relay: ReturnType<typeof makeRelay>, commandId: string, method: string, params: unknown, idempotencyKey: string): Promise<void> {
  const envelopeCiphertext = await sealCommandEnvelope(node, keyring, fence, commandId, { method, params, idempotencyKey });
  const payloadDigest = `sha256:${createHash('sha256').update(envelopeCiphertext, 'utf8').digest('hex')}`;
  relay.queue.set(commandId, { commandId, controllerDeviceId: CTRL, fence, envelopeCiphertext, payloadDigest });
}

function fakeEngine(store: Store): { engine: ControllerActionEngine; launched: string[]; cancelled: string[] } {
  const launched: string[] = []; const cancelled: string[] = [];
  const engine: ControllerActionEngine = {
    launchJob: (jobId) => { launched.push(jobId); },
    cancelJob: (jobId) => { cancelled.push(jobId); const j = store.getJob(jobId); if (j) store.updateJob(jobId, { status: 'cancelled' }); return !!j; },
  };
  return { engine, launched, cancelled };
}

function buildPlane(store: Store, relay: ReturnType<typeof makeRelay>, eng: { engine: ControllerActionEngine }, nowFn: () => number, leaseExpiresAt: number, revoked: readonly string[] = []) {
  const provider = new StaticShadowKeyProvider(scopeKeyId, scopeKeyBytes);
  const core = new ShadowHostCore(hostDir, provider);
  const receipts = new ShadowActionReceiptStore(receiptDir);
  const registry = defineShadowCommandRegistry(buildControllerActionRegistryEntries({
    store: {
      getProject: (id) => store.getProject(id), getSession: (id) => store.getSession(id), getJob: (id) => store.getJob(id),
      listApprovals: () => store.listApprovals(), listSchedules: () => store.listSchedules(),
      claimIdempotentJob: (k, s) => store.claimIdempotentJob(k, s as Parameters<typeof store.claimIdempotentJob>[1]),
      claimIdempotentQuestionAnswer: (k, i) => store.claimIdempotentQuestionAnswer(k, i),
      resolveApproval: (id, st) => store.resolveApproval(id, st), updateSession: (id, patch) => store.updateSession(id, patch),
    },
    engine: eng.engine, receipts,
  }));
  const svc = new ShadowHostDataService({
    host: core, keys: provider, scopeKeyId, fence, leaseExpiresAt,
    session: async () => ({ accountId: fence.accountId, hostDeviceId: fence.hostDeviceId, sessionToken: 't', relayOrigin: 'http://127.0.0.1:1' }),
    signer: { keyId: 'sk', sign: async () => new Uint8Array(64) },
    transport: { fetch: relay.fetch as never, allowInsecureLoopback: true },
    commandRegistry: registry, capabilitiesFor: () => ALL_CAPS, now: nowFn,
  });
  if (revoked.length) svc.setAuthority(fence, leaseExpiresAt, revoked);
  return { core, receipts, svc };
}

interface Ids { p: string; s: string; j: string; a: string }
async function seed(store: Store): Promise<Ids> {
  const p = store.createProject({ name: 'Authz' });
  const s = store.createSession(p.id, 'chat');
  const j = store.createJob(p.id, 'go', 'J', 'balanced', s.id); store.updateJob(j.id, { status: 'running' });
  const a = store.createApproval({ projectId: p.id, kind: 'merge', title: 'M' });
  store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: s.id, sourceJobId: j.id, fireAt: now + 60000, armedAt: now, questionAsk: JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'Yes' }] }] }) });
  return { p: p.id, s: s.id, j: j.id, a: a.id };
}

const ACTIONS: Array<{ method: string; params: (ids: Ids) => unknown; noEffect: (store: Store, ids: Ids, eng: ReturnType<typeof fakeEngine>) => void; didEffect: (store: Store, ids: Ids, eng: ReturnType<typeof fakeEngine>) => void }> = [
  { method: 'controller.session.autopilot.set', params: (ids) => ({ sessionId: ids.s, enabled: true }),
    noEffect: (store, ids) => expect(store.getSession(ids.s)!.autoPilot).not.toBe(true),
    didEffect: (store, ids) => expect(store.getSession(ids.s)!.autoPilot).toBe(true) },
  { method: 'controller.approval.respond', params: (ids) => ({ approvalId: ids.a, decision: 'approve' }),
    noEffect: (store, ids) => expect(store.listApprovals().find((x) => x.id === ids.a)!.status).toBe('pending'),
    didEffect: (store, ids) => expect(store.listApprovals().find((x) => x.id === ids.a)!.status).toBe('approved') },
  { method: 'controller.job.cancel', params: (ids) => ({ jobId: ids.j }),
    noEffect: (store, ids, eng) => { expect(store.getJob(ids.j)!.status).toBe('running'); expect(eng.cancelled.length).toBe(0); },
    didEffect: (store, ids) => expect(store.getJob(ids.j)!.status).toBe('cancelled') },
  { method: 'controller.session.message', params: (ids) => ({ sessionId: ids.s, text: 'hi' }),
    noEffect: (store, ids, eng) => { expect(store.listJobs(ids.p).filter((x) => x.input === 'hi').length).toBe(0); expect(eng.launched.length).toBe(0); },
    didEffect: (store, ids) => expect(store.listJobs(ids.p).filter((x) => x.input === 'hi').length).toBe(1) },
  { method: 'controller.job.start', params: (ids) => ({ projectId: ids.p, input: 'run', title: 'T' }),
    noEffect: (store, ids, eng) => { expect(store.listJobs(ids.p).filter((x) => x.input === 'run').length).toBe(0); expect(eng.launched.length).toBe(0); },
    didEffect: (store, ids) => expect(store.listJobs(ids.p).filter((x) => x.input === 'run').length).toBe(1) },
  { method: 'controller.question.answer', params: (ids) => ({ sessionId: ids.s, sourceJobId: ids.j, answer: 'yes' }),
    noEffect: (store) => expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).not.toBe(false),
    didEffect: (store) => expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).toBe(false) },
];

describe('HIGH-2 — no product effect after lease/fence invalidation', () => {
  beforeEach(async () => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    receiptDir = mkdtempSync(join(tmpdir(), 'rcpt-')); hostDir = mkdtempSync(join(tmpdir(), 'host-'));
    keyring = await deriveScopeKeyring(node, new Uint8Array(scopeKeyBytes), { accountId: fence.accountId, scopeId: fence.scopeId, keyId: scopeKeyId });
  });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); try { rmSync(receiptDir, { recursive: true, force: true }); rmSync(hostDir, { recursive: true, force: true }); } catch { /* ignore */ } keyring?.dispose?.(); });

  for (const action of ACTIONS) {
    it(`${action.method}: claimed valid → crash before execute → restart AFTER lease expiry → ZERO effect`, async () => {
      const relay = makeRelay();
      const cmd = `cmd_${action.method.replace(/[^a-z]/gi, '')}`;
      // ── instance 1: lease valid; ingest + claim; crash BEFORE execute (durable ledger row) ──
      {
        const store = new Store();
        const eng = fakeEngine(store);
        const ids = await seed(store);
        await enqueue(relay, cmd, action.method, action.params(ids), `idem_${action.method}`);
        const plane = buildPlane(store, relay, eng, () => now, LEASE);
        plane.svc.debugSetCrashPointForTest('after-claim-before-execute');
        await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/after-claim-before-execute/);
        action.noEffect(store, ids, eng);            // nothing executed yet
        plane.svc.close(); plane.receipts.close();
      }
      // ── instance 2: reopen SAME paths; clock is PAST leaseExpiresAt → recovery must NOT execute ──
      const store2 = new Store();
      const eng2 = fakeEngine(store2);
      const p = store2.listProjects()[0].id;
      const ids2: Ids = { p, s: store2.listSessions(p)[0].id, j: store2.listJobs(p)[0]!.id, a: store2.listApprovals()[0]!.id };
      const plane2 = buildPlane(store2, relay, eng2, () => AFTER_EXPIRY, LEASE);
      await plane2.svc.pollAndExecuteCommands();      // recovery under EXPIRED lease → fail-closed
      action.noEffect(store2, ids2, eng2);            // ZERO product effect
      expect(relay.events.filter((e) => e.commandId === cmd).length).toBe(0); // nothing published under expired authority
      // Not re-claimed hot: a second recovery pass still applies NO effect (the command is
      // terminalized in the ledger; the launcher/cancel engine seam is never invoked).
      await plane2.svc.pollAndExecuteCommands();
      action.noEffect(store2, ids2, eng2);
      expect(eng2.launched.length).toBe(0);
      expect(eng2.cancelled.length).toBe(0);
      plane2.svc.close(); plane2.receipts.close();
    });

    it(`${action.method}: VALID lease at execute → effect DOES apply (no over-blocking)`, async () => {
      const relay = makeRelay();
      const store = new Store();
      const eng = fakeEngine(store);
      const ids = await seed(store);
      await enqueue(relay, `okc_${action.method.replace(/[^a-z]/gi, '')}`, action.method, action.params(ids), `idemok_${action.method}`);
      const plane = buildPlane(store, relay, eng, () => now, now + 3_600_000);
      await plane.svc.pollAndExecuteCommands();
      action.didEffect(store, ids, eng);
      plane.svc.close(); plane.receipts.close();
    });
  }

  it('controller.approval.respond: REVOKED controller → zero effect (revokedControllerDeviceIds fence set)', async () => {
    const relay = makeRelay();
    const store = new Store();
    const eng = fakeEngine(store);
    const ids = await seed(store);
    await enqueue(relay, 'cmd_revoked', 'controller.approval.respond', { approvalId: ids.a, decision: 'approve' }, 'idem_revoked');
    // Lease valid but THIS controller is revoked → assertCurrentAuthority must fail closed.
    const plane = buildPlane(store, relay, eng, () => now, now + 3_600_000, [CTRL]);
    await plane.svc.pollAndExecuteCommands();
    expect(store.listApprovals().find((x) => x.id === ids.a)!.status).toBe('pending'); // no effect
    plane.svc.close(); plane.receipts.close();
  });
});
