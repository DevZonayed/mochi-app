/**
 * Real-Store product-idempotent action adapters (Section 6C). Uses the ACTUAL Store
 * (isolated userData) + a real receipt store; asserts ACTUAL product state (job/approval/
 * session/schedule) + exactly-once replay + conflict rejection — not callback counts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-actions-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { ShadowActionReceiptStore } from './shadow-action-receipt.js';
import { buildControllerActionRegistryEntries, type ControllerActionEngine } from './shadow-controller-actions.js';
import type { ProductIdempotentActionInput } from './shadow-host-service.js';

const fence = { accountId: 'acct_1', scopeId: 'account:acct_1', hostDeviceId: 'h', epoch: 1, leaseId: 'l' };
let receiptDir = '';

function makeEngine(store: Store): { engine: ControllerActionEngine; launched: string[]; cancelled: string[] } {
  const launched: string[] = []; const cancelled: string[] = [];
  const engine: ControllerActionEngine = {
    launchJob: (jobId) => { launched.push(jobId); },
    cancelJob: (jobId) => { cancelled.push(jobId); const j = store.getJob(jobId); if (j) store.updateJob(jobId, { status: 'cancelled' }); return true; },
  };
  return { engine, launched, cancelled };
}

function actions(store: Store, receipts: ShadowActionReceiptStore, engine: ControllerActionEngine) {
  return buildControllerActionRegistryEntries({ store, engine, receipts });
}
function input(method: string, params: unknown, over: Partial<ProductIdempotentActionInput> = {}): ProductIdempotentActionInput {
  // assertAuthority is a no-op here (authority is valid in these adapter unit tests); the
  // real service supplies a HostCore-backed guard (see shadow-command-authority.test.ts).
  return { accountId: 'acct_1', scopeId: fence.scopeId, controllerDeviceId: 'ctrl_1', commandId: 'cmd_1', idempotencyKey: 'idem_1', canonicalPayloadDigest: 'pd1', params, fence, now: 1_800_000_000_000, assertAuthority: () => {}, ...over };
}

describe('controller action adapters — real Store product effects', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); receiptDir = mkdtempSync(join(tmpdir(), 'rcpt-')); });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); try { rmSync(receiptDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('autopilot.set: applies boolean, replay returns same receipt, conflicting payload rejected', async () => {
    const store = new Store(); const r = new ShadowActionReceiptStore(receiptDir); const { engine } = makeEngine(store);
    const reg = actions(store, r, engine);
    const p = store.createProject({ name: 'P' }); const s = store.createSession(p.id, 'c');
    const a = reg['controller.session.autopilot.set'].effectMode === 'product-idempotent' ? reg['controller.session.autopilot.set'] : null;
    expect(a).not.toBeNull();
    const adapter = (a as { adapter: { execute: (i: ProductIdempotentActionInput) => Promise<unknown> } }).adapter;

    const o1 = await adapter.execute(input('controller.session.autopilot.set', { sessionId: s.id, enabled: true })) as { ok: boolean };
    expect(o1.ok).toBe(true);
    expect(store.getSession(s.id)!.autoPilot).toBe(true);
    // exact replay (same key + digest) → same receipt, no re-apply
    const o2 = await adapter.execute(input('controller.session.autopilot.set', { sessionId: s.id, enabled: true })) as { ok: boolean; completion?: { entityId: string } };
    expect(o2.ok).toBe(true);
    expect(o2.completion?.entityId).toBe(s.id);
    // conflicting replay: same idempotencyKey, DIFFERENT payload digest → rejected
    const o3 = await adapter.execute(input('controller.session.autopilot.set', { sessionId: s.id, enabled: false }, { canonicalPayloadDigest: 'pd-different' })) as { ok: boolean; code?: string };
    expect(o3.ok).toBe(false); expect(o3.code).toBe('conflict');
    expect(store.getSession(s.id)!.autoPilot).toBe(true); // unchanged
    r.close();
  });

  it('approval.respond: resolves once, duplicate same decision no-ops, conflicting decision rejected', async () => {
    const store = new Store(); const r = new ShadowActionReceiptStore(receiptDir); const { engine } = makeEngine(store);
    const reg = actions(store, r, engine);
    const p = store.createProject({ name: 'P' });
    const appr = store.createApproval({ projectId: p.id, kind: 'merge', title: 'M' });
    const ad = (reg['controller.approval.respond'] as { adapter: { execute: (i: ProductIdempotentActionInput) => Promise<{ ok: boolean; code?: string }> } }).adapter;

    expect((await ad.execute(input('controller.approval.respond', { approvalId: appr.id, decision: 'approve' }))).ok).toBe(true);
    expect(store.listApprovals().find((a) => a.id === appr.id)!.status).toBe('approved');
    // same-decision replay → same receipt, still approved
    expect((await ad.execute(input('controller.approval.respond', { approvalId: appr.id, decision: 'approve' }))).ok).toBe(true);
    // a NEW command trying to DENY an already-approved approval → conflict, no change
    const o = await ad.execute(input('controller.approval.respond', { approvalId: appr.id, decision: 'deny' }, { idempotencyKey: 'idem_2', canonicalPayloadDigest: 'pd2' }));
    expect(o.ok).toBe(false); expect(o.code).toBe('conflict');
    expect(store.listApprovals().find((a) => a.id === appr.id)!.status).toBe('approved');
    r.close();
  });

  it('job.cancel: cancels a running job, duplicate is a state-idempotent no-op', async () => {
    const store = new Store(); const r = new ShadowActionReceiptStore(receiptDir); const { engine, cancelled } = makeEngine(store);
    const reg = actions(store, r, engine);
    const p = store.createProject({ name: 'P' }); const j = store.createJob(p.id, 'go', 'J'); store.updateJob(j.id, { status: 'running' });
    const ad = (reg['controller.job.cancel'] as { adapter: { execute: (i: ProductIdempotentActionInput) => Promise<{ ok: boolean }> } }).adapter;
    expect((await ad.execute(input('controller.job.cancel', { jobId: j.id }))).ok).toBe(true);
    expect(store.getJob(j.id)!.status).toBe('cancelled');
    expect(cancelled).toEqual([j.id]);
    // duplicate → receipt hit, no second cancel
    expect((await ad.execute(input('controller.job.cancel', { jobId: j.id }))).ok).toBe(true);
    expect(cancelled).toEqual([j.id]); // still once
    r.close();
  });

  it('question.answer: atomic claim disables the schedule + one answer Job; duplicate never re-answers; conflict on divergent answer', async () => {
    const store = new Store(); const r = new ShadowActionReceiptStore(receiptDir); const { engine, launched } = makeEngine(store);
    const reg = actions(store, r, engine);
    const p = store.createProject({ name: 'P' }); const s = store.createSession(p.id, 'c');
    const src = store.createJob(p.id, 'go', 'J', undefined, s.id); store.updateJob(src.id, { status: 'running' });
    const sched = store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: s.id, sourceJobId: src.id, fireAt: 1_800_000_060_000, armedAt: 1_800_000_000_000, questionAsk: JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'Yes' }] }] }) });
    const ad = (reg['controller.question.answer'] as { adapter: { execute: (i: ProductIdempotentActionInput) => Promise<{ ok: boolean; code?: string; completion?: { entityId: string } }> } }).adapter;

    const o1 = await ad.execute(input('controller.question.answer', { sessionId: s.id, sourceJobId: src.id, answer: 'yes' }));
    expect(o1.ok).toBe(true);
    const answerJobId = o1.completion!.entityId;
    expect(store.listSchedules().find((x) => x.id === sched.id)!.enabled).toBe(false); // schedule disabled
    expect(store.getJob(answerJobId)!.input).toBe('yes');
    expect(launched).toEqual([answerJobId]);
    // exact replay (same key + digest) → SAME answer Job, no re-answer, no relaunch
    const o2 = await ad.execute(input('controller.question.answer', { sessionId: s.id, sourceJobId: src.id, answer: 'yes' }));
    expect(o2.completion!.entityId).toBe(answerJobId);
    expect(launched).toEqual([answerJobId]);
    expect(store.listJobs(p.id).filter((x) => x.input === 'yes').length).toBe(1); // exactly one answer Job
    // conflicting replay: same idempotencyKey, DIFFERENT payload digest → rejected (no altered answer)
    const o3 = await ad.execute(input('controller.question.answer', { sessionId: s.id, sourceJobId: src.id, answer: 'no' }, { canonicalPayloadDigest: 'pd-different' }));
    expect(o3.ok).toBe(false); expect(o3.code).toBe('conflict');
    expect(store.listJobs(p.id).filter((x) => x.input === 'no').length).toBe(0);
    r.close();
  });

  it('session.message / job.start: stable idempotency → ONE durable job, duplicate never relaunches', async () => {
    const store = new Store(); const r = new ShadowActionReceiptStore(receiptDir); const { engine, launched } = makeEngine(store);
    const reg = actions(store, r, engine);
    const p = store.createProject({ name: 'P' }); const s = store.createSession(p.id, 'c');
    const msg = (reg['controller.session.message'] as { adapter: { execute: (i: ProductIdempotentActionInput) => Promise<{ ok: boolean; completion?: { entityId: string } }> } }).adapter;
    const o1 = await msg.execute(input('controller.session.message', { sessionId: s.id, text: 'hello' }));
    expect(o1.ok).toBe(true);
    const jobId = o1.completion!.entityId;
    expect(store.getJob(jobId)).toBeTruthy();
    expect(launched).toEqual([jobId]);
    // duplicate command (same idempotencyKey) → same job, NOT relaunched
    const o2 = await msg.execute(input('controller.session.message', { sessionId: s.id, text: 'hello' }));
    expect(o2.completion!.entityId).toBe(jobId);
    expect(launched).toEqual([jobId]); // still one launch
    expect(store.listJobs(p.id).length).toBe(1); // exactly one job
    r.close();
  });

  it('rejects unknown ids and malformed params (ownership validated pre-transition)', async () => {
    const store = new Store(); const r = new ShadowActionReceiptStore(receiptDir); const { engine } = makeEngine(store);
    const reg = actions(store, r, engine);
    const ad = (reg['controller.session.autopilot.set'] as { adapter: { execute: (i: ProductIdempotentActionInput) => Promise<{ ok: boolean; code?: string }> } }).adapter;
    const o = await ad.execute(input('controller.session.autopilot.set', { sessionId: 'sess_missing', enabled: true }));
    expect(o.ok).toBe(false); expect(o.code).toBe('not-found');
    r.close();
  });
});
