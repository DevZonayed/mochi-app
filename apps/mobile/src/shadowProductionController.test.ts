/**
 * Phase 3A2b1 §4 — the PRODUCTION mobile controller surface. Proves the action API
 * derives capability authorization DYNAMICALLY from the verified provider on EVERY call
 * (never a snapshot), fails closed on revoke/downgrade/tamper/unavailable (sends nothing),
 * reflects a re-enrollment subset with no restart, isolates per account, and that close()
 * disposes every subscription + stops the renewal timer. NO UI.
 */
import { describe, it, expect } from 'vitest';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import { VerifiedShadowActionApi, type VerifiedCapabilityProvider } from './shadowActionBuilders';
import { assembleProductionShadowController } from './shadowProductionControllerCore';
import type { ShadowControllerService, ControllerServiceStatus } from './shadowControllerService';

const ALL: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'];

/** A verified provider whose current set can be mutated to model revoke/downgrade/re-enroll. */
function provider(initial: ShadowCapability[] | null): { p: VerifiedCapabilityProvider; set: (v: ShadowCapability[] | null) => void; calls: () => number } {
  let caps = initial;
  let calls = 0;
  return {
    p: { verifiedApprovedCapabilities: async () => { calls++; return caps; } },
    set: (v) => { caps = v; },
    calls: () => calls,
  };
}

function sender(): { send: (m: string, p: unknown) => Promise<{ commandId: string }>; sent: Array<{ method: string; params: unknown }> } {
  const sent: Array<{ method: string; params: unknown }> = [];
  return { sent, send: async (method, params) => { sent.push({ method, params }); return { commandId: `cmd_${sent.length}` }; } };
}

function fakeService(): { svc: ShadowControllerService; sent: Array<{ method: string; params: unknown }>; fire: () => void; listeners: () => number; stops: () => number; starts: () => number; locks: () => number; setLocked: (v: boolean) => void; setLeaseExpired: (v: boolean) => void } {
  const s = sender();
  const listeners = new Set<() => void>();
  let stops = 0; let starts = 0; let locks = 0; let locked = false; let leaseExpired = false;
  const status: ControllerServiceStatus = { state: 'online', online: true, lastSeq: 3, entities: 0, locked: false, leaseExpiresAt: 9_999_999_999_999 };
  const svc = {
    sendCommand: (m: string, p: unknown) => s.send(m, p),
    readEntities: () => [],
    status: () => status,
    getCommand: (id: string) => (id === 'cmd_1' ? { commandId: 'cmd_1', phase: 'sent' } : undefined),
    onProjectionChange: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    startAutoReconcile: () => { starts++; },
    stopAutoReconcile: () => { stops++; },
    isLocked: () => locked,
    leaseExpired: () => leaseExpired,
    lock: () => { locks++; locked = true; },
  } as unknown as ShadowControllerService;
  return { svc, sent: s.sent, fire: () => listeners.forEach((f) => f()), listeners: () => listeners.size, stops: () => stops, starts: () => starts, locks: () => locks, setLocked: (v) => { locked = v; }, setLeaseExpired: (v) => { leaseExpired = v; } };
}

describe('VerifiedShadowActionApi — dynamic, fail-closed capability gate (NO snapshot)', () => {
  it('full verified set → every method allowed and actually sent', async () => {
    const s = sender();
    const pr = provider(ALL);
    const api = new VerifiedShadowActionApi({ sendCommand: s.send }, pr.p);
    expect((await api.sendMessage('sess1', 'hi')).ok).toBe(true);
    expect((await api.startJob('proj1', 'go', { title: 'T' })).ok).toBe(true);
    expect((await api.cancelJob('job1')).ok).toBe(true);
    expect((await api.respondApproval('appr1', 'approve')).ok).toBe(true);
    expect((await api.answerQuestion('sess1', 'job1', 'yes')).ok).toBe(true);
    expect((await api.setAutopilot('sess1', true)).ok).toBe(true);
    expect(s.sent.map((x) => x.method)).toEqual([
      'controller.session.message', 'controller.job.start', 'controller.job.cancel',
      'controller.approval.respond', 'controller.question.answer', 'controller.session.autopilot.set',
    ]);
    expect(pr.calls()).toBe(6); // provider consulted on EACH call, not once
  });

  it('DYNAMIC downgrade → the removed capability is denied on the NEXT call, nothing sent', async () => {
    const s = sender();
    const pr = provider(ALL);
    const api = new VerifiedShadowActionApi({ sendCommand: s.send }, pr.p);
    expect((await api.cancelJob('job1')).ok).toBe(true);      // job.cancel allowed
    expect(s.sent.length).toBe(1);
    pr.set(['account.read', 'session.message']);              // host downgrades — no restart
    const denied = await api.cancelJob('job1');
    expect(denied).toEqual({ ok: false, reason: 'capability-missing:job.cancel' });
    expect(s.sent.length).toBe(1);                            // NOT sent
    expect((await api.sendMessage('sess1', 'hi')).ok).toBe(true); // still-approved cap works
    expect(s.sent.length).toBe(2);
  });

  it('REVOKE / lock / tamper (provider → null) → all methods fail closed, send nothing', async () => {
    const s = sender();
    const pr = provider(ALL);
    const api = new VerifiedShadowActionApi({ sendCommand: s.send }, pr.p);
    pr.set(null);                                             // grant revoked/locked/tampered
    for (const call of [
      () => api.sendMessage('sess1', 'hi'), () => api.startJob('proj1', 'go'), () => api.cancelJob('job1'),
      () => api.respondApproval('appr1', 'deny'), () => api.answerQuestion('sess1', 'job1', 'no'), () => api.setAutopilot('sess1', false),
    ]) {
      expect(await call()).toEqual({ ok: false, reason: 'capability-unavailable' });
    }
    expect(s.sent.length).toBe(0);                           // absolutely nothing sent
  });

  it('RE-ENROLLMENT to a new subset is reflected on the next call (no restart)', async () => {
    const s = sender();
    const pr = provider(null);                               // not yet enrolled
    const api = new VerifiedShadowActionApi({ sendCommand: s.send }, pr.p);
    expect((await api.setAutopilot('sess1', true)).ok).toBe(false); // no grant → denied
    pr.set(['account.read', 'session.autopilot.set']);       // re-enrolled with a subset
    expect((await api.setAutopilot('sess1', true)).ok).toBe(true);
    expect((await api.startJob('proj1', 'go')).ok).toBe(false); // job.start not in the subset
    expect(s.sent.map((x) => x.method)).toEqual(['controller.session.autopilot.set']);
  });

  it('malformed params are rejected before any capability check / send', async () => {
    const s = sender();
    const pr = provider(ALL);
    const api = new VerifiedShadowActionApi({ sendCommand: s.send }, pr.p);
    expect(await api.sendMessage('bad id!', 'hi')).toEqual({ ok: false, reason: 'bad-params' });
    expect(await api.setAutopilot('sess1', 'yes' as unknown as boolean)).toEqual({ ok: false, reason: 'bad-params' });
    expect(s.sent.length).toBe(0);
  });

  it('can(method) resolves the CURRENT verified set each call', async () => {
    const pr = provider(['account.read', 'job.cancel']);
    const api = new VerifiedShadowActionApi({ sendCommand: async () => ({ commandId: 'x' }) }, pr.p);
    expect(await api.can('controller.job.cancel')).toBe(true);
    expect(await api.can('controller.job.start')).toBe(false);
    pr.set(null);
    expect(await api.can('controller.job.cancel')).toBe(false);
  });
});

describe('assembleProductionShadowController — headless surface (NO array injection)', () => {
  it('exposes a dynamic action API bound to the provider (not a snapshot)', async () => {
    const { svc, sent } = fakeService();
    const pr = provider(ALL);
    const c = assembleProductionShadowController(svc, pr.p);
    expect((await c.actions.setAutopilot('sess1', true)).ok).toBe(true);
    expect(sent.length).toBe(1);
    pr.set(null); // revoke reflected immediately through the same surface
    expect((await c.actions.setAutopilot('sess1', false)).ok).toBe(false);
    expect(sent.length).toBe(1);
  });

  it('projection view + status + command status delegate to the durable service', async () => {
    const { svc } = fakeService();
    const c = assembleProductionShadowController(svc, provider(ALL).p);
    expect(c.status().online).toBe(true);
    expect(c.snapshot().connection.online).toBe(true);
    expect(c.snapshot().connection.offlineReadonly).toBe(false);
    expect(c.commandStatus('cmd_1')?.commandId).toBe('cmd_1');
    expect(c.commandStatus('nope')).toBeUndefined();
  });

  it('drives the service authority reconcile (so a host revoke reaches the gate)', () => {
    const f = fakeService();
    assembleProductionShadowController(f.svc, provider(ALL).p);
    expect(f.starts()).toBe(1); // auto-reconcile started → the lock signal is actively driven
  });

  it('gate flips to UNAVAILABLE when the SERVICE locks (host revoke / 401 / 403), even if the grant still verifies', async () => {
    const f = fakeService();
    const c = assembleProductionShadowController(f.svc, provider(ALL).p); // provider still returns full caps
    expect((await c.actions.cancelJob('job1')).ok).toBe(true);
    f.setLocked(true); // the actively-driven service locked after a revoke
    const denied = await c.actions.cancelJob('job1');
    expect(denied).toEqual({ ok: false, reason: 'capability-unavailable' });
    expect(f.sent.length).toBe(1); // nothing sent while locked
  });

  it('gate flips to UNAVAILABLE when the lease has EXPIRED (fail-closed read-only)', async () => {
    const f = fakeService();
    const c = assembleProductionShadowController(f.svc, provider(ALL).p);
    f.setLeaseExpired(true);
    expect((await c.actions.setAutopilot('sess1', true)).ok).toBe(false);
    expect(f.sent.length).toBe(0);
  });

  it('close() disposes every subscription, stops the renewal timer, AND locks (wipes the scope key)', async () => {
    const f = fakeService();
    const { svc, fire, listeners, stops, locks } = f;
    const c = assembleProductionShadowController(svc, provider(ALL).p);
    let hits = 0;
    c.onChange(() => { hits++; });
    c.onChange(() => { hits++; });
    fire();
    expect(hits).toBe(2);
    expect(listeners()).toBe(2);
    c.close();
    expect(listeners()).toBe(0); // all unsubscribed
    expect(stops()).toBe(1);     // renewal timer stopped
    expect(locks()).toBe(1);     // scope key wiped on close (sign-out / account switch)
    fire();
    expect(hits).toBe(2);        // no further notifications after close
    // onChange after close is inert.
    const un = c.onChange(() => { hits++; });
    fire(); un();
    expect(hits).toBe(2);
  });

  it('two controllers are isolated: a revoke on one never affects the other', async () => {
    const a = fakeService(); const pa = provider(ALL);
    const b = fakeService(); const pb = provider(ALL);
    const ca = assembleProductionShadowController(a.svc, pa.p);
    const cb = assembleProductionShadowController(b.svc, pb.p);
    pa.set(null); // account A revoked
    expect((await ca.actions.cancelJob('job1')).ok).toBe(false);
    expect((await cb.actions.cancelJob('job1')).ok).toBe(true); // account B unaffected
    expect(a.sent.length).toBe(0);
    expect(b.sent.length).toBe(1);
  });
});
