/**
 * shadowActionController.test.ts — Phase 3C3. Drives all six actions through the controller
 * with a fake ProductionShadowController + injected deps. Proves: correct method/params;
 * truthful lifecycle receipts reconciled from real command status (ACK≠done); fail-closed
 * preflight; at-most-one-in-flight + duplicate coalescing; retry = new command; ambiguity
 * timeout → unknown; generation reset discards stale attempts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShadowActionController, type ActionIntent } from './shadowActionController';
import type { ProductionShadowController } from './shadowProductionControllerCore';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import type { CommandLifecycleState, CommandLifecycleStatus } from '@maestro/realtime';

const FENCE = { accountId: 'a', scopeId: 's', hostDeviceId: 'h', epoch: 1, leaseId: 'l' };
function cmd(status: CommandLifecycleStatus): CommandLifecycleState { return { status, commandId: 'x', fence: FENCE, createdAt: 0, expiresAt: 0 }; }

class FakeController {
  calls: Array<{ method: string; args: unknown[] }> = [];
  private seq = 0;
  statuses = new Map<string, CommandLifecycleState>();
  private changeFns = new Set<() => void>();
  emitChange() { for (const f of [...this.changeFns]) f(); }
  private mk(method: string) {
    return async (...args: unknown[]) => { this.calls.push({ method, args }); const commandId = `cmd${++this.seq}`; this.statuses.set(commandId, cmd('sent')); return { ok: true as const, commandId }; };
  }
  actions = {
    startJob: this.mk('startJob'), cancelJob: this.mk('cancelJob'), respondApproval: this.mk('respondApproval'),
    answerQuestion: this.mk('answerQuestion'), sendMessage: this.mk('sendMessage'), setAutopilot: this.mk('setAutopilot'),
  } as unknown as ProductionShadowController['actions'];
  projection = {
    listProjects: () => [{ id: 'p1', name: 'P1' }],
    projectJobs: (id: string) => (id === 'p1' ? [{ id: 'j1', projectId: 'p1', status: 'running' }, { id: 'jDone', projectId: 'p1', status: 'completed' }] : []),
    projectSessions: (id: string) => (id === 'p1' ? [{ id: 's1', projectId: 'p1', archived: false }] : []),
    pendingApprovals: () => [{ id: 'a1', status: 'pending' }],
    pendingQuestions: () => [{ id: 'q1', sessionId: 's1', sourceJobId: 'j1', status: 'pending' }],
  } as unknown as ProductionShadowController['projection'];
  commandStatus = (id: string) => this.statuses.get(id);
  onChange = (fn: () => void) => { this.changeFns.add(fn); return () => this.changeFns.delete(fn); };
  status = () => ({}) as never; snapshot = () => ({}) as never; connect = async () => 0; close = () => {};
}

const ALL: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'];

interface H { ctrl: ShadowActionController; fake: FakeController; setGranted: (g: ShadowCapability[] | null) => void; setOnline: (b: boolean) => void; setLocked: (b: boolean) => void; fireTimers: () => void; keys: () => string[]; keysFor: (method: string) => string[]; }
/** The idempotency key is always the LAST argument the controller passes to an action method. */
const keyOf = (c: { args: unknown[] }): string => c.args[c.args.length - 1] as string;
function harness(over: { granted?: ShadowCapability[] | null; online?: boolean; locked?: boolean } = {}): H {
  const fake = new FakeController();
  let granted: ShadowCapability[] | null = over.granted === undefined ? ALL : over.granted;
  let online = over.online ?? true;
  let locked = over.locked ?? false;
  const timers: Array<() => void> = [];
  let keySeq = 0;
  const ctrl = new ShadowActionController({
    getController: () => fake as unknown as ProductionShadowController,
    getGranted: async () => granted,
    isOnline: () => online,
    isLocked: () => locked,
    ambiguityMs: 100,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    // Deterministic, strict-format keys so tests can assert stable-vs-new.
    newIdempotencyKey: () => `idem_${String(++keySeq).padStart(16, '0')}`,
  });
  return {
    ctrl, fake,
    setGranted: (g) => { granted = g; }, setOnline: (b) => { online = b; }, setLocked: (b) => { locked = b; },
    fireTimers: () => { for (const t of timers.splice(0)) t(); },
    keys: () => fake.calls.map(keyOf), keysFor: (method) => fake.calls.filter((c) => c.method === method).map(keyOf),
  };
}

const intents: Record<string, ActionIntent> = {
  start: { family: 'start-job', projectId: 'p1', input: 'do it' },
  cancel: { family: 'cancel-job', jobId: 'j1' },
  approve: { family: 'respond-approval', approvalId: 'a1', decision: 'approve' },
  answer: { family: 'answer-question', sessionId: 's1', sourceJobId: 'j1', answer: 'yes' },
  message: { family: 'send-message', sessionId: 's1', text: 'hello' },
  autopilot: { family: 'set-autopilot', sessionId: 's1', enabled: true },
};

describe('all six actions dispatch the correct method', () => {
  const map: Array<[keyof typeof intents, string]> = [['start', 'startJob'], ['cancel', 'cancelJob'], ['approve', 'respondApproval'], ['answer', 'answerQuestion'], ['message', 'sendMessage'], ['autopilot', 'setAutopilot']];
  for (const [k, method] of map) {
    it(`${k} → ${method}`, async () => {
      const h = harness();
      const r = await h.ctrl.run(intents[k]);
      expect(r.ok).toBe(true);
      expect(h.fake.calls.map((c) => c.method)).toEqual([method]);
    });
  }
});

describe('truthful lifecycle receipts (ACK ≠ done)', () => {
  it('sent → working (accepted) → done (applied), reconciled from real status', async () => {
    const h = harness();
    await h.ctrl.run(intents.start);
    expect(h.ctrl.receiptFor(intents.start).phase).toBe('sent');
    const id = (h.fake.calls, [...h.fake.statuses.keys()][0]);
    h.fake.statuses.set(id, cmd('accepted')); h.fake.emitChange();
    expect(h.ctrl.receiptFor(intents.start).phase).toBe('working');
    h.fake.statuses.set(id, cmd('applied')); h.fake.emitChange();
    expect(h.ctrl.receiptFor(intents.start).phase).toBe('done');
  });
  it('a rejected command is failed + retryable (reason not surfaced)', async () => {
    const h = harness();
    await h.ctrl.run(intents.cancel);
    const id = [...h.fake.statuses.keys()][0];
    h.fake.statuses.set(id, { ...cmd('rejected'), rejectReason: '/secret' }); h.fake.emitChange();
    const rc = h.ctrl.receiptFor(intents.cancel);
    expect(rc.phase).toBe('failed'); expect(rc.retryable).toBe(true); expect(rc.message).not.toContain('/secret');
  });
  it('ambiguity timeout → unknown (never success)', async () => {
    const h = harness();
    await h.ctrl.run(intents.message);
    expect(h.ctrl.receiptFor(intents.message).phase).toBe('sent');
    h.fireTimers();
    expect(h.ctrl.receiptFor(intents.message).phase).toBe('unknown');
  });
});

describe('fail-closed preflight (no enqueue)', () => {
  it('offline refuses + sends nothing', async () => {
    const h = harness({ online: false });
    expect(await h.ctrl.run(intents.start)).toEqual({ ok: false, reason: 'offline' });
    expect(h.fake.calls.length).toBe(0);
  });
  it('locked refuses', async () => {
    const h = harness({ locked: true });
    expect(await h.ctrl.run(intents.start)).toEqual({ ok: false, reason: 'locked' });
  });
  it('missing capability refuses (read-only grant)', async () => {
    const h = harness({ granted: ['account.read'] });
    expect(await h.ctrl.run(intents.start)).toEqual({ ok: false, reason: 'capability' });
    expect(h.fake.calls.length).toBe(0);
  });
  it('no grant refuses', async () => {
    const h = harness({ granted: null });
    expect(await h.ctrl.run(intents.approve)).toEqual({ ok: false, reason: 'no-grant' });
  });
  it('ineligible target refuses (completed job / non-pending)', async () => {
    const h = harness();
    expect(await h.ctrl.run({ family: 'cancel-job', jobId: 'jDone' })).toEqual({ ok: false, reason: 'target' });
    expect(await h.ctrl.run({ family: 'cancel-job', jobId: 'nope' })).toEqual({ ok: false, reason: 'target' });
  });
  it('check() mirrors preflight for rendering decisions', async () => {
    const h = harness({ granted: ['account.read'] });
    expect((await h.ctrl.check(intents.start))).toEqual({ ok: false, reason: 'capability' });
    const h2 = harness();
    expect((await h2.ctrl.check(intents.start))).toEqual({ ok: true });
  });
});

describe('idempotency / at-most-one-in-flight / retry / reset', () => {
  it('duplicate taps while in-flight COALESCE onto ONE command with ONE idempotency key', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.ctrl.run(intents.cancel), h.ctrl.run(intents.cancel)]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.fake.calls.filter((c) => c.method === 'cancelJob').length).toBe(1);
    expect(h.keysFor('cancelJob').length).toBe(1); // one send → one key
  });
  it('every action carries an opaque idempotency key as the last argument', async () => {
    const h = harness();
    await h.ctrl.run(intents.start);
    const k = h.keysFor('startJob')[0];
    expect(k).toMatch(/^idem_[A-Za-z0-9_-]{16,64}$/);
  });

  // F1 CORE: an `unknown` (possibly-applied) result is NOT retryable — no fresh-key resend
  // that could double a create.
  it('retry after `unknown` (ambiguous) is REFUSED — no second command, no new key', async () => {
    const h = harness();
    await h.ctrl.run(intents.start);
    expect(h.ctrl.receiptFor(intents.start).phase).toBe('sent');
    h.fireTimers(); // ambiguity window → unknown
    expect(h.ctrl.receiptFor(intents.start).phase).toBe('unknown');
    expect(await h.ctrl.retry(intents.start)).toEqual({ ok: false, reason: 'not-retryable' });
    expect(h.fake.calls.filter((c) => c.method === 'startJob').length).toBe(1); // still ONE effect
    expect(new Set(h.keysFor('startJob')).size).toBe(1);
  });
  it('retry after `applied` (done) is REFUSED — a completed action is never resent', async () => {
    const h = harness();
    await h.ctrl.run(intents.cancel);
    const id1 = [...h.fake.statuses.keys()][0];
    h.fake.statuses.set(id1, cmd('applied')); h.fake.emitChange();
    expect(await h.ctrl.retry(intents.cancel)).toEqual({ ok: false, reason: 'not-retryable' });
    expect(h.fake.calls.filter((c) => c.method === 'cancelJob').length).toBe(1);
  });
  it('retry after a PROVEN no-effect `rejected` starts a NEW attempt with a DIFFERENT key', async () => {
    const h = harness();
    await h.ctrl.run(intents.cancel);
    const id1 = [...h.fake.statuses.keys()][0];
    h.fake.statuses.set(id1, cmd('rejected')); h.fake.emitChange();
    expect(h.ctrl.receiptFor(intents.cancel).phase).toBe('failed');
    expect(await h.ctrl.retry(intents.cancel)).toMatchObject({ ok: true });
    const keys = h.keysFor('cancelJob');
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]); // a genuinely new intentional attempt → new key
  });
  it('permission/fence failures (unauthorized/revoked/expired/stale-epoch/conflict) are NOT retryable', async () => {
    for (const status of ['unauthorized', 'revoked', 'expired', 'stale-epoch', 'conflict'] as const) {
      const h = harness();
      await h.ctrl.run(intents.cancel);
      const id = [...h.fake.statuses.keys()][0];
      h.fake.statuses.set(id, cmd(status)); h.fake.emitChange();
      expect(h.ctrl.receiptFor(intents.cancel).retryable, status).toBe(false);
      expect(await h.ctrl.retry(intents.cancel), status).toEqual({ ok: false, reason: 'not-retryable' });
      expect(h.fake.calls.filter((c) => c.method === 'cancelJob').length, status).toBe(1);
    }
  });
  it('reset discards in-flight attempts (revoke/expiry/switch)', async () => {
    const h = harness();
    await h.ctrl.run(intents.message);
    expect(h.ctrl.receiptFor(intents.message).phase).toBe('sent');
    h.ctrl.reset();
    expect(h.ctrl.receiptFor(intents.message).phase).toBe('idle');
  });
  it('a stale (superseded by reset) send is dropped, not tracked', async () => {
    const h = harness();
    // Reset mid-run: the invoke resolves after gen bumped → attempt discarded.
    const p = h.ctrl.run(intents.start);
    h.ctrl.reset();
    const r = await p;
    expect(r.ok).toBe(false); // stale
    expect(h.ctrl.receiptFor(intents.start).phase).toBe('idle');
  });
});
