/**
 * shadowActionModel.test.ts — Phase 3C3. Truthful receipt mapping (ACK ≠ done; ambiguity →
 * unknown), per-target eligibility, and the fail-closed preflight matrix.
 */
import { describe, it, expect } from 'vitest';
import type { CommandLifecycleState, CommandLifecycleStatus } from '@maestro/realtime';
import {
  receiptPhaseForStatus, deriveReceipt, isTerminalReceipt,
  jobCancellable, approvalActionable, questionActionable, projectStartable, sessionMessageable,
  preflight, blockedMessage,
} from './shadowActionModel';

function state(status: CommandLifecycleStatus): CommandLifecycleState {
  return { status, commandId: 'c', fence: { accountId: 'a', scopeId: 's', hostDeviceId: 'h', epoch: 1, leaseId: 'l' }, createdAt: 0, expiresAt: 0 };
}

describe('receipt phase mapping (transport ACK is not success)', () => {
  const cases: Array<[CommandLifecycleStatus, string]> = [
    ['pending-local', 'sent'], ['sent', 'sent'],
    ['accepted', 'working'], ['executing', 'working'], ['awaiting-state-event', 'working'],
    ['applied', 'done'],
    ['rejected', 'failed'], ['unauthorized', 'failed'], ['conflict', 'failed'], ['stale-epoch', 'failed'],
    ['expired', 'failed'], ['cancelled', 'failed'], ['revoked', 'failed'],
  ];
  for (const [status, phase] of cases) it(`${status} → ${phase}`, () => expect(receiptPhaseForStatus(status)).toBe(phase));
  it('undefined → idle', () => expect(receiptPhaseForStatus(undefined)).toBe('idle'));
  it('accepted is WORKING, never done (ACK is not proof of effect)', () => {
    expect(deriveReceipt(state('accepted')).phase).toBe('working');
  });
  it('only an applied state event is done', () => {
    expect(deriveReceipt(state('applied')).phase).toBe('done');
  });
  it('a timed-out in-flight command becomes unknown, never success', () => {
    expect(deriveReceipt(state('sent'), { timedOut: true }).phase).toBe('unknown');
    expect(deriveReceipt(state('accepted'), { timedOut: true }).phase).toBe('unknown'); // working → unknown
    expect(deriveReceipt(state('applied'), { timedOut: true }).phase).toBe('done'); // terminal not overridden
    expect(deriveReceipt(state('rejected'), { timedOut: true }).phase).toBe('failed'); // terminal not overridden
  });
  it('preparing shows preparing only before a command lands', () => {
    expect(deriveReceipt(undefined, { preparing: true }).phase).toBe('preparing');
  });
  it('failed/unknown/done are all TERMINAL', () => {
    expect(isTerminalReceipt(deriveReceipt(state('rejected')).phase)).toBe(true);
    expect(isTerminalReceipt('done')).toBe(true);
    expect(isTerminalReceipt('unknown')).toBe(true);
  });

  // F1 retry-safety matrix: a retry is ONLY a fresh-key intentional attempt, so it is offered
  // ONLY for proven-not-applied failures. `unknown` (possibly-applied) and permission/fence
  // failures are NOT retryable — there is no fresh-key ambiguous resend that could double a create.
  it('retryable ONLY for proven-not-applied failures (rejected/cancelled)', () => {
    expect(deriveReceipt(state('rejected')).retryable).toBe(true);
    expect(deriveReceipt(state('cancelled')).retryable).toBe(true);
  });
  it('unknown is NEVER retryable (possibly applied → no resend)', () => {
    expect(deriveReceipt(state('sent'), { timedOut: true }).phase).toBe('unknown');
    expect(deriveReceipt(state('sent'), { timedOut: true }).retryable).toBe(false);
    expect(deriveReceipt(state('accepted'), { timedOut: true }).retryable).toBe(false);
  });
  it('done and in-flight are not retryable', () => {
    expect(deriveReceipt(state('applied')).retryable).toBe(false);
    expect(deriveReceipt(state('sent')).retryable).toBe(false);
    expect(deriveReceipt(state('accepted')).retryable).toBe(false);
  });
  it('permission/fence failures are NOT retryable (need authority refresh)', () => {
    for (const s of ['unauthorized', 'revoked', 'expired', 'stale-epoch', 'conflict'] as const) {
      expect(deriveReceipt(state(s)).phase, s).toBe('failed');
      expect(deriveReceipt(state(s)).retryable, s).toBe(false);
    }
  });
  it('the reject reason is NEVER surfaced verbatim (bounded generic copy)', () => {
    const s = { ...state('rejected'), rejectReason: '/Users/x/.secret leaked' };
    expect(deriveReceipt(s).message).not.toContain('/Users/');
    expect(deriveReceipt(s).message).toBe('Your Mac couldn’t complete it');
  });
});

describe('target eligibility', () => {
  it('jobCancellable only for live statuses', () => {
    expect(jobCancellable({ status: 'running' })).toBe(true);
    expect(jobCancellable({ status: 'pending' })).toBe(true);
    expect(jobCancellable({ status: 'completed' })).toBe(false);
    expect(jobCancellable({ status: 'failed' })).toBe(false);
    expect(jobCancellable(undefined)).toBe(false);
  });
  it('approvalActionable only when pending', () => {
    expect(approvalActionable({ status: 'pending' })).toBe(true);
    expect(approvalActionable({ status: 'resolved' })).toBe(false);
  });
  it('questionActionable requires pending AND a source job id (else no action)', () => {
    expect(questionActionable({ status: 'pending', sourceJobId: 'j1' })).toBe(true);
    expect(questionActionable({ status: 'pending', sourceJobId: undefined })).toBe(false);
    expect(questionActionable({ status: 'answered', sourceJobId: 'j1' })).toBe(false);
  });
  it('project/session eligibility', () => {
    expect(projectStartable({ id: 'p1' })).toBe(true);
    expect(sessionMessageable({ id: 's1', archived: false })).toBe(true);
    expect(sessionMessageable({ id: 's1', archived: true })).toBe(false);
  });
});

describe('preflight matrix (fail closed)', () => {
  const base = { online: true, locked: false, granted: ['account.read', 'job.start'] as const, family: 'start-job' as const, targetEligible: true };
  it('passes only when online + granted + eligible + not locked', () => {
    expect(preflight(base)).toEqual({ ok: true });
  });
  it('locked beats everything', () => {
    expect(preflight({ ...base, locked: true })).toEqual({ ok: false, reason: 'locked' });
  });
  it('offline blocks (read-only, no enqueue)', () => {
    expect(preflight({ ...base, online: false })).toEqual({ ok: false, reason: 'offline' });
  });
  it('no grant / missing capability blocks', () => {
    expect(preflight({ ...base, granted: null })).toEqual({ ok: false, reason: 'no-grant' });
    expect(preflight({ ...base, granted: ['account.read'] })).toEqual({ ok: false, reason: 'capability' });
  });
  it('ineligible target blocks', () => {
    expect(preflight({ ...base, targetEligible: false })).toEqual({ ok: false, reason: 'target' });
  });
  it('blocked messages are bounded + generic', () => {
    for (const r of ['offline', 'locked', 'no-grant', 'capability', 'target'] as const) {
      expect(blockedMessage(r).length).toBeGreaterThan(0);
      expect(blockedMessage(r)).not.toMatch(/\//); // no paths
    }
  });
});
