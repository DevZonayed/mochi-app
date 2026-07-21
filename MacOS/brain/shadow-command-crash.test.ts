/**
 * Phase 3A2b1 §2 — durable command→authoritative-projection settlement crash matrix.
 * REAL Store (isolated userData) + real ShadowActionReceiptStore SQLite + real
 * ShadowHostCore SQLite + real intake store, driven through the production
 * ShadowHostDataService with an in-memory relay stub. For EACH of the six actions,
 * inject a crash at a processing boundary, CLOSE all local DBs, REOPEN the same paths
 * with a fresh production service, recover to completion, and assert the ACTUAL product
 * effect happened EXACTLY ONCE and the command-bound authoritative projection event is
 * durably delivered (so the controller settles) — not merely the ACK.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-crash-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store, type Job } from './store.js';
import { ShadowHostCore, StaticShadowKeyProvider } from './shadow-host.js';
import { ShadowHostDataService, defineShadowCommandRegistry, type HostCommandCrashPoint } from './shadow-host-service.js';
import { ShadowActionReceiptStore } from './shadow-action-receipt.js';
import { buildControllerActionRegistryEntries, type ControllerActionEngine } from './shadow-controller-actions.js';
import { createHash } from 'node:crypto';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { deriveScopeKeyring, sealCommandEnvelope, type ScopeKeyring } from '@maestro/realtime/shadowDataCodec';
import type { Fence, ShadowCapability } from '@maestro/realtime';

const now = 1_800_000_000_000;
const scopeKeyBytes = Buffer.alloc(32, 5);
const scopeKeyId = 'wk_crash';
const CTRL = 'ctrl_crash_1';
const fence: Fence = { accountId: 'acct_1', scopeId: 'account:acct_1', hostDeviceId: 'host_1', epoch: 1, leaseId: 'l' };
const ALL_CAPS: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'];

let receiptDir = '';
let hostDir = '';

/** In-memory relay: queued commands + published events + posted acks. */
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
      const body = JSON.parse(init.body ?? '{}');
      acks.set(id, body.ackDigest);
      return { status: 200, ok: true, text: async () => '{"ok":true}' };
    }
    if (u.pathname === '/api/shadow/events' && method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      for (const e of body.events ?? []) { if (!events.some((x) => x.eventId === e.eventId)) events.push(e); }
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

function fakeEngine(store: Store): { engine: ControllerActionEngine; launched: string[] } {
  const launched: string[] = [];
  const engine: ControllerActionEngine = {
    launchJob: (jobId) => { launched.push(jobId); },
    cancelJob: (jobId) => { const j = store.getJob(jobId); if (j) store.updateJob(jobId, { status: 'cancelled' }); return !!j; },
  };
  return { engine, launched };
}

function buildPlane(store: Store, relay: ReturnType<typeof makeRelay>, launched: { engine: ControllerActionEngine }, nowFn: () => number = () => now, crashAfterProductCommit?: (method: string) => void) {
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
    engine: launched.engine, receipts, crashAfterProductCommit,
  }));
  const svc = new ShadowHostDataService({
    host: core, keys: provider, scopeKeyId, fence, leaseExpiresAt: now + 3_600_000,
    session: async () => ({ accountId: fence.accountId, hostDeviceId: fence.hostDeviceId, sessionToken: 't', relayOrigin: 'http://127.0.0.1:1' }),
    signer: { keyId: 'sk', sign: async () => new Uint8Array(64) },
    transport: { fetch: relay.fetch as never, allowInsecureLoopback: true },
    commandRegistry: registry, capabilitiesFor: () => ALL_CAPS, now: nowFn,
  });
  return { core, receipts, svc };
}

/** Count command-bound projection events for a target entity in the durable relay stream. */
function boundEvents(relay: ReturnType<typeof makeRelay>, commandId: string): Record<string, unknown>[] {
  return relay.events.filter((e) => e.commandId === commandId);
}

describe('ShadowHostDataService — six-action crash → settlement recovery (§2)', () => {
  beforeEach(async () => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    receiptDir = mkdtempSync(join(tmpdir(), 'rcpt-')); hostDir = mkdtempSync(join(tmpdir(), 'host-'));
    keyring = await deriveScopeKeyring(node, new Uint8Array(scopeKeyBytes), { accountId: fence.accountId, scopeId: fence.scopeId, keyId: scopeKeyId });
  });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); try { rmSync(receiptDir, { recursive: true, force: true }); rmSync(hostDir, { recursive: true, force: true }); } catch { /* ignore */ } keyring?.dispose?.(); });

  /** Seed the Store, enqueue the action command, then return the target-entity assertion. */
  async function seed(store: Store, method: string, makeParams: (ids: { p: string; s: string; j: string; a: string }) => { params: unknown; idem: string }): Promise<{ commandId: string; params: unknown; idem: string; ids: { p: string; s: string; j: string; a: string } }> {
    const p = store.createProject({ name: 'Crash' });
    const s = store.createSession(p.id, 'chat');
    const j = store.createJob(p.id, 'go', 'J', 'balanced', s.id); store.updateJob(j.id, { status: 'running' });
    const a = store.createApproval({ projectId: p.id, kind: 'merge', title: 'M' });
    store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: s.id, sourceJobId: j.id, fireAt: now + 60000, armedAt: now, questionAsk: JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'Yes' }] }] }) });
    const ids = { p: p.id, s: s.id, j: j.id, a: a.id };
    const { params, idem } = makeParams(ids);
    const commandId = `cmd_${method.replace(/[^a-z]/gi, '')}`;
    return { commandId, params, idem, ids };
  }

  const ACTIONS: Array<{ method: string; params: (ids: { p: string; s: string; j: string; a: string }) => unknown; assert: (store: Store, ids: { p: string; s: string; j: string; a: string }, launched: string[]) => void }> = [
    { method: 'controller.session.autopilot.set', params: (ids) => ({ sessionId: ids.s, enabled: true }), assert: (store, ids) => expect(store.getSession(ids.s)!.autoPilot).toBe(true) },
    { method: 'controller.approval.respond', params: (ids) => ({ approvalId: ids.a, decision: 'approve' }), assert: (store, ids) => expect(store.listApprovals().find((x) => x.id === ids.a)!.status).toBe('approved') },
    { method: 'controller.job.cancel', params: (ids) => ({ jobId: ids.j }), assert: (store, ids) => expect(store.getJob(ids.j)!.status).toBe('cancelled') },
    { method: 'controller.session.message', params: (ids) => ({ sessionId: ids.s, text: 'hi' }), assert: (store, ids, launched) => { expect(store.listJobs(ids.p).filter((x) => x.input === 'hi').length).toBe(1); expect(launched.length).toBeLessThanOrEqual(1); } },
    { method: 'controller.job.start', params: (ids) => ({ projectId: ids.p, input: 'run', title: 'T' }), assert: (store, ids, launched) => { expect(store.listJobs(ids.p).filter((x) => x.input === 'run').length).toBe(1); expect(launched.length).toBeLessThanOrEqual(1); } },
    { method: 'controller.question.answer', params: (ids) => ({ sessionId: ids.s, sourceJobId: ids.j, answer: 'yes' }), assert: (store, ids) => expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).toBe(false) },
  ];

  const BOUNDARIES: HostCommandCrashPoint[] = ['after-ack-before-append', 'after-append-before-relay-ack', 'after-relay-ack-before-publish'];

  for (const action of ACTIONS) {
    for (const boundary of BOUNDARIES) {
      it(`${action.method} recovers from crash @ ${boundary}: effect once + command-bound event`, async () => {
        const relay = makeRelay();
        // ── instance 1: drive to the crash boundary ──
        {
          const store = new Store();
          const eng = fakeEngine(store);
          const seeded = await seed(store, action.method, (ids) => ({ params: action.params(ids), idem: `idem_${action.method}` }));
          await enqueue(relay, seeded.commandId, action.method, seeded.params, seeded.idem);
          const plane = buildPlane(store, relay, eng);
          plane.svc.debugSetCrashPointForTest(boundary);
          await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(new RegExp(`crash-${boundary}`));
          plane.svc.close(); plane.receipts.close();
        }
        // ── instance 2: reopen SAME durable paths, recover to completion ──
        const store2 = new Store();
        const eng2 = fakeEngine(store2);
        const plane2 = buildPlane(store2, relay, eng2);
        await plane2.svc.pollAndExecuteCommands(); // recovery re-drives settlement + publish
        // The product effect happened exactly once (asserted on the reopened Store).
        const p = store2.listProjects()[0].id;
        action.assert(store2, { p, s: store2.listSessions(p)[0].id, j: store2.listJobs(p)[0]?.id ?? 'j', a: store2.listApprovals()[0]?.id ?? 'a' }, eng2.launched);
        // The command-bound authoritative projection event is durably published (mobile settles).
        const cmdId = `cmd_${action.method.replace(/[^a-z]/gi, '')}`;
        expect(boundEvents(relay, cmdId).length).toBeGreaterThanOrEqual(1);
        // A further poll is a pure no-op (exactly once).
        expect(await plane2.svc.pollAndExecuteCommands()).toBe(0);
        plane2.svc.close(); plane2.receipts.close();
      });
    }
  }

  // Boundary A: crash AFTER the durable product commit but BEFORE the action receipt.
  // For message/job.start the product commit is `Store.claimIdempotentJob` (a durable
  // Job); a crash before the receipt must recover to EXACTLY ONE Job + one launch
  // eligibility — never a second Job or a second launch.
  for (const method of ['controller.session.message', 'controller.job.start'] as const) {
    it(`${method} boundary A (crash after durable Job commit before receipt): one Job, one launch eligibility`, async () => {
      const relay = makeRelay();
      const input = method === 'controller.session.message' ? 'hi' : 'run';
      let launchCount = 0;
      // ── instance 1: launcher throws AFTER the durable Job exists (crash pre-receipt) ──
      {
        const store = new Store();
        const eng = fakeEngine(store);
        eng.engine.launchJob = (jobId) => { launchCount++; if (store.getJob(jobId)) throw new Error('crash-after-job-commit-before-receipt'); };
        const seeded = await seed(store, method, (ids) => ({ params: method === 'controller.session.message' ? { sessionId: ids.s, text: input } : { projectId: ids.p, input, title: 'T' }, idem: `idem_${method}` }));
        await enqueue(relay, seeded.commandId, method, seeded.params, seeded.idem);
        const plane = buildPlane(store, relay, eng);
        await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/crash-after-job-commit-before-receipt/);
        // The durable Job already exists after the throw (product commit is durable).
        expect(store.listJobs(store.listProjects()[0].id).filter((x) => x.input === input).length).toBe(1);
        plane.svc.close(); plane.receipts.close();
      }
      // ── instance 2: reopen; recovery re-runs the adapter → claimIdempotentJob duplicate ──
      const store2 = new Store();
      const eng2 = fakeEngine(store2);
      // A restart advances the clock past the crashed instance's claim lease so recovery
      // can re-claim the un-applied command (a fresh process + fresh owner id).
      const plane2 = buildPlane(store2, relay, eng2, () => now + 120_000);
      await plane2.svc.pollAndExecuteCommands();
      const p = store2.listProjects()[0].id;
      // EXACTLY ONE durable Job (no second launch eligibility); recovery did not relaunch.
      expect(store2.listJobs(p).filter((x) => x.input === input).length).toBe(1);
      expect(eng2.launched.length).toBe(0); // duplicate claim → no relaunch on recovery
      // Command-bound projection event delivered so the controller can settle.
      const cmdId = `cmd_${method.replace(/[^a-z]/gi, '')}`;
      expect(boundEvents(relay, cmdId).length).toBeGreaterThanOrEqual(1);
      expect(await plane2.svc.pollAndExecuteCommands()).toBe(0);
      plane2.svc.close(); plane2.receipts.close();
    });
  }

  // Boundary A via the in-adapter crash hook (§2 correction): crash strictly AFTER apply()
  // returns a successful durable product completion but BEFORE `receipts.commit`. This is the
  // window the reviewer flagged — for state-idempotent actions (cancel/approval/autopilot) and
  // the atomic-claim question answer, recovery must re-derive the SAME terminal product state,
  // commit the receipt, publish the command-bound projection, and never apply a second effect.
  const BOUNDARY_A: Array<{
    method: string;
    params: (ids: { p: string; s: string; j: string; a: string }) => unknown;
    // assert the durable product effect exists after the instance-1 crash (pre-receipt)
    committed: (store: Store, ids: { p: string; s: string; j: string; a: string }) => void;
    // assert exactly-once terminal state after recovery (no second effect)
    recovered: (store: Store, ids: { p: string; s: string; j: string; a: string }, launched: string[]) => void;
  }> = [
    {
      method: 'controller.job.cancel',
      params: (ids) => ({ jobId: ids.j }),
      committed: (store, ids) => expect(store.getJob(ids.j)!.status).toBe('cancelled'),
      recovered: (store, ids) => expect(store.getJob(ids.j)!.status).toBe('cancelled'),
    },
    {
      method: 'controller.approval.respond',
      params: (ids) => ({ approvalId: ids.a, decision: 'approve' }),
      committed: (store, ids) => expect(store.listApprovals().find((x) => x.id === ids.a)!.status).toBe('approved'),
      recovered: (store, ids) => expect(store.listApprovals().find((x) => x.id === ids.a)!.status).toBe('approved'),
    },
    {
      method: 'controller.session.autopilot.set',
      params: (ids) => ({ sessionId: ids.s, enabled: true }),
      committed: (store, ids) => expect(store.getSession(ids.s)!.autoPilot).toBe(true),
      recovered: (store, ids) => expect(store.getSession(ids.s)!.autoPilot).toBe(true),
    },
    {
      method: 'controller.question.answer',
      params: (ids) => ({ sessionId: ids.s, sourceJobId: ids.j, answer: 'yes' }),
      committed: (store, ids) => {
        // The atomic claim already disabled the schedule and created exactly one answer Job.
        expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).toBe(false);
        expect(store.listJobs(ids.p).filter((x) => x.input === 'yes').length).toBe(1);
      },
      recovered: (store, ids, launched) => {
        expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).toBe(false);
        expect(store.listJobs(ids.p).filter((x) => x.input === 'yes').length).toBe(1); // no second answer Job
        expect(launched.length).toBe(0); // duplicate claim on recovery → no relaunch
      },
    },
  ];

  for (const action of BOUNDARY_A) {
    it(`${action.method} boundary A (crash in adapter after product commit before receipt): one effect, receipt + command-bound event on recovery`, async () => {
      const relay = makeRelay();
      // ── instance 1: crash hook throws AFTER the durable product op, BEFORE the receipt ──
      {
        const store = new Store();
        const eng = fakeEngine(store);
        const seeded = await seed(store, action.method, (ids) => ({ params: action.params(ids), idem: `idemA_${action.method}` }));
        await enqueue(relay, seeded.commandId, action.method, seeded.params, seeded.idem);
        const plane = buildPlane(store, relay, eng, () => now, (m) => {
          if (m === action.method) throw new Error(`crash-boundary-a-${action.method}`);
        });
        await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(new RegExp(`crash-boundary-a-${action.method.replace(/\./g, '\\.')}`));
        // The product effect is durable even though the receipt was never written.
        const p1 = store.listProjects()[0].id;
        action.committed(store, { p: p1, s: store.listSessions(p1)[0].id, j: store.listJobs(p1).find((x) => x.status === 'cancelled' || x.title === 'J')?.id ?? store.listJobs(p1)[0].id, a: store.listApprovals()[0].id });
        // No receipt yet: the boundary is strictly pre-commit.
        plane.svc.close(); plane.receipts.close();
      }
      // ── instance 2: reopen SAME paths, fresh service, NO crash hook, advanced lease clock ──
      const store2 = new Store();
      const eng2 = fakeEngine(store2);
      const plane2 = buildPlane(store2, relay, eng2, () => now + 120_000);
      await plane2.svc.pollAndExecuteCommands();
      const p = store2.listProjects()[0].id;
      const ids = { p, s: store2.listSessions(p)[0].id, j: store2.listJobs(p).find((x) => x.title === 'J')?.id ?? store2.listJobs(p)[0].id, a: store2.listApprovals()[0].id };
      action.recovered(store2, ids, eng2.launched);
      // Command-bound authoritative projection event delivered so the controller settles.
      const cmdId = `cmd_${action.method.replace(/[^a-z]/gi, '')}`;
      expect(boundEvents(relay, cmdId).length).toBeGreaterThanOrEqual(1);
      // Exactly once: a further poll is a pure no-op.
      expect(await plane2.svc.pollAndExecuteCommands()).toBe(0);
      plane2.svc.close(); plane2.receipts.close();
    });
  }

  // Boundary A + opposite decision: approve crashes pre-receipt, recovers to `approved`, then a
  // DISTINCT controller command tries to DENY the same approval. The already-terminal approval
  // must NOT flip — the conflicting decision is rejected and the product state is never revived.
  it('controller.approval.respond boundary A then conflicting deny: no revive, deny conflicts', async () => {
    const relay = makeRelay();
    let approvalId = '';
    // ── instance 1: approve crashes after the durable resolve, before the receipt ──
    {
      const store = new Store();
      const eng = fakeEngine(store);
      const seeded = await seed(store, 'controller.approval.respond', (ids) => ({ params: { approvalId: ids.a, decision: 'approve' }, idem: 'idemA_conflict_approve' }));
      approvalId = seeded.ids.a;
      await enqueue(relay, seeded.commandId, 'controller.approval.respond', seeded.params, seeded.idem);
      const plane = buildPlane(store, relay, eng, () => now, (m) => { if (m === 'controller.approval.respond') throw new Error('crash-approve-before-receipt'); });
      await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/crash-approve-before-receipt/);
      expect(store.listApprovals().find((x) => x.id === approvalId)!.status).toBe('approved');
      plane.svc.close(); plane.receipts.close();
    }
    // ── instance 2: recover the approve, then enqueue a conflicting deny (distinct command) ──
    const store2 = new Store();
    const eng2 = fakeEngine(store2);
    const plane2 = buildPlane(store2, relay, eng2, () => now + 120_000);
    await plane2.svc.pollAndExecuteCommands();
    expect(store2.listApprovals().find((x) => x.id === approvalId)!.status).toBe('approved');
    // A different controller command (distinct commandId + idempotencyKey) tries to DENY.
    await enqueue(relay, 'cmd_conflicting_deny', 'controller.approval.respond', { approvalId, decision: 'deny' }, 'idemA_conflict_deny');
    await plane2.svc.pollAndExecuteCommands();
    // The approval is STILL approved — the conflicting deny neither revived nor flipped it.
    expect(store2.listApprovals().find((x) => x.id === approvalId)!.status).toBe('approved');
    plane2.svc.close(); plane2.receipts.close();
  });

  // §4 — cancel side-effect ORDER audit: the durable product effect (job → terminal 'cancelled')
  // is committed inside `engine.cancelJob` BEFORE the shadow receipt. A crash in that window must
  // replay to the SAME terminal job WITHOUT issuing a SECOND external kill — the external cancel
  // fires EXACTLY ONCE across crash + recovery. (approval opposite-decision conflict is proven by
  // the boundary-A conflicting-deny case above; resolveApproval is a pure durable write, no
  // external effect, so its ordering is trivially crash-safe.)
  it('controller.job.cancel side-effect order: external cancel fires exactly once across crash + replay', async () => {
    const relay = makeRelay();
    let externalCancels = 0;
    let jobId = '';
    // ── instance 1: cancel commits durable 'cancelled', then the crash hook throws pre-receipt ──
    {
      const store = new Store();
      const eng = fakeEngine(store);
      eng.engine.cancelJob = (jid) => { externalCancels++; const j = store.getJob(jid); if (j && j.status === 'running') { store.updateJob(jid, { status: 'cancelled' }); return true; } return false; };
      const seeded = await seed(store, 'controller.job.cancel', (ids) => ({ params: { jobId: ids.j }, idem: 'idem4_cancel' }));
      jobId = seeded.ids.j;
      await enqueue(relay, seeded.commandId, 'controller.job.cancel', seeded.params, seeded.idem);
      const plane = buildPlane(store, relay, eng, () => now, (m) => { if (m === 'controller.job.cancel') throw new Error('crash-cancel-before-receipt'); });
      await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/crash-cancel-before-receipt/);
      expect(externalCancels).toBe(1);                       // external kill happened once
      expect(store.getJob(jobId)!.status).toBe('cancelled'); // durable BEFORE the receipt
      plane.svc.close(); plane.receipts.close();
    }
    // ── instance 2: reopen; recovery re-drives → job already terminal → NO second external kill ──
    const store2 = new Store();
    const eng2 = fakeEngine(store2);
    let externalCancels2 = 0;
    eng2.engine.cancelJob = (jid) => { externalCancels2++; const j = store2.getJob(jid); if (j && j.status === 'running') { store2.updateJob(jid, { status: 'cancelled' }); return true; } return false; };
    const plane2 = buildPlane(store2, relay, eng2, () => now + 120_000);
    await plane2.svc.pollAndExecuteCommands();
    expect(externalCancels2).toBe(0);                        // terminal job → adapter skips the kill
    expect(store2.getJob(jobId)!.status).toBe('cancelled');  // stable terminal state, no revive
    const cmdId = 'cmd_controllerjobcancel';
    expect(boundEvents(relay, cmdId).length).toBeGreaterThanOrEqual(1);
    expect(await plane2.svc.pollAndExecuteCommands()).toBe(0);
    plane2.svc.close(); plane2.receipts.close();
  });

  // §3 — message/job.start durable launch recovery proven through ACTUAL Store launch state
  // (idempotentPendingJobIds / session-run-queue / settleOrphanedRuns), not a callback count.
  // The controller adapter produces ONE durable pending Job BEFORE launch; a crash before the
  // launch leaves that Job launch-eligible EXACTLY ONCE via boot recovery — and the shadow
  // command path itself never relaunches (claim resolves to duplicate). Once actually launched
  // (leased + running) the Job drops out of the eligibility set — never a double launch.
  for (const scenario of [
    { method: 'controller.session.message', input: 'hi', withSession: true },
    { method: 'controller.job.start', input: 'run', withSession: false },
  ] as const) {
    it(`${scenario.method} durable launch recovery: exactly one launch-eligible Job (real state), no double-launch`, async () => {
      const relay = makeRelay();
      let jobId = '';
      // ── instance 1: launcher throws AFTER the durable pending Job (crash strictly before launch) ──
      {
        const store = new Store();
        const eng = fakeEngine(store);
        eng.engine.launchJob = () => { throw new Error('crash-before-launch'); };
        const seeded = await seed(store, scenario.method, (ids) => ({ params: scenario.method === 'controller.session.message' ? { sessionId: ids.s, text: scenario.input } : { projectId: ids.p, input: scenario.input, title: 'T' }, idem: `idem3_${scenario.method}` }));
        await enqueue(relay, seeded.commandId, scenario.method, seeded.params, seeded.idem);
        const plane = buildPlane(store, relay, eng);
        await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/crash-before-launch/);
        const p = store.listProjects()[0].id;
        const job = store.listJobs(p).find((j) => j.input === scenario.input)!;
        jobId = job.id;
        expect(job.status).toBe('pending');                                  // durable, never launched
        // Launch-eligible through ACTUAL boot-recovery state — the one durable Job, exactly once.
        expect(store.idempotentPendingJobIds().filter((x) => x === jobId)).toEqual([jobId]);
        // A crashed-never-run reserved Job is SPARED by the orphan sweep (recoverable, not failed).
        const swept = store.settleOrphanedRuns();
        expect(swept.failed.map((j) => j.id)).not.toContain(jobId);
        plane.svc.close(); plane.receipts.close();
      }
      // ── instance 2: reopen SAME paths; the same durable Job is still launch-eligible exactly once ──
      const store2 = new Store();
      const eng2 = fakeEngine(store2);
      const plane2 = buildPlane(store2, relay, eng2, () => now + 120_000);
      expect(store2.idempotentPendingJobIds().filter((x) => x === jobId)).toEqual([jobId]); // persisted, once
      // Shadow command recovery re-drives settlement/receipt but does NOT relaunch (claim → duplicate).
      await plane2.svc.pollAndExecuteCommands();
      expect(eng2.launched).not.toContain(jobId);
      const p = store2.listProjects()[0].id;
      expect(store2.listJobs(p).filter((j) => j.input === scenario.input).length).toBe(1); // exactly one Job
      expect(store2.idempotentPendingJobIds().filter((x) => x === jobId)).toEqual([jobId]); // still eligible once
      // Boot recovery is the SINGLE launcher: acquiring the run lease + running the Job removes it
      // from the eligibility set — proving a second launch is impossible.
      if (scenario.withSession) {
        const s = store2.listSessions(p)[0].id;
        expect(store2.acquireSessionRun(s, jobId, now + 130_000)).toBe('acquired');
      }
      store2.updateJob(jobId, { status: 'running' });
      expect(store2.idempotentPendingJobIds()).not.toContain(jobId);         // launched → no second eligibility
      plane2.svc.close(); plane2.receipts.close();
    });
  }
});
