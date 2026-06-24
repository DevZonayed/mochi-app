/* Unit-tests for plan-mode-gate. The contract this file pins down:

   - requestExit blocks until respondExit fires with the SAME toolUseID
   - respondExit returns false for an unknown id (idempotent — re-clicking
     "Approve" after the dialog closed is a silent no-op, not a crash)
   - aborting the supplied signal REJECTS the pending Promise so the agent's
     run unwinds with a clean Cancelled, not a hang
   - cancelAll fires the reject on EVERY in-flight request — used on app quit
   - the BG retry-hint string is non-empty and mentions the Maestro tool
     (the agent reads it; a typo here breaks the second bug's fix)

   No engine, no SDK, no IPC — the gate is a pure Promise queue and these
   tests run in isolation. */

import { describe, it, expect } from 'vitest';
import { createPlanModeGate, BG_RUN_IN_BACKGROUND_DENY } from './plan-mode-gate.js';

const req = (id: string, plan = 'do step 1') => ({
  toolUseID: id, plan, sessionId: 'sess-1', jobId: 'job-1',
});

describe('plan-mode-gate', () => {
  it('requestExit resolves with the operator\'s decision', async () => {
    const gate = createPlanModeGate();
    const p = gate.requestExit(req('t-1'));
    expect(gate.pendingCount()).toBe(1);
    const real = gate.respondExit('t-1', true);
    expect(real).toBe(true);
    expect(gate.pendingCount()).toBe(0);
    await expect(p).resolves.toBe(true);
  });

  it('routes by toolUseID — two parallel requests, two independent answers', async () => {
    const gate = createPlanModeGate();
    const a = gate.requestExit(req('t-a', 'plan A'));
    const b = gate.requestExit(req('t-b', 'plan B'));
    expect(gate.pendingCount()).toBe(2);
    gate.respondExit('t-b', false);
    gate.respondExit('t-a', true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
    expect(gate.pendingCount()).toBe(0);
  });

  it('respondExit on an unknown id is a silent no-op (returns false)', () => {
    const gate = createPlanModeGate();
    expect(gate.respondExit('nope', true)).toBe(false);
    // Same answer is also a no-op after the real one fired (double-click guard).
    void gate.requestExit(req('t-once'));
    expect(gate.respondExit('t-once', true)).toBe(true);
    expect(gate.respondExit('t-once', true)).toBe(false);
  });

  it('aborting the signal REJECTS the pending request (clean cancel path)', async () => {
    const gate = createPlanModeGate();
    const ac = new AbortController();
    const p = gate.requestExit(req('t-cancel'), { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(gate.pendingCount()).toBe(0);
  });

  it('an already-aborted signal short-circuits with a rejected Promise', async () => {
    const gate = createPlanModeGate();
    const ac = new AbortController();
    ac.abort();
    const p = gate.requestExit(req('t-pre-cancel'), { signal: ac.signal });
    await expect(p).rejects.toThrow(/cancelled/);
    expect(gate.pendingCount()).toBe(0);
  });

  it('cancelAll fires reject on EVERY in-flight request', async () => {
    const gate = createPlanModeGate();
    const a = gate.requestExit(req('t-x'));
    const b = gate.requestExit(req('t-y'));
    const c = gate.requestExit(req('t-z'));
    expect(gate.pendingCount()).toBe(3);
    gate.cancelAll('shutdown');
    await Promise.all([
      expect(a).rejects.toThrow(/shutdown/),
      expect(b).rejects.toThrow(/shutdown/),
      expect(c).rejects.toThrow(/shutdown/),
    ]);
    expect(gate.pendingCount()).toBe(0);
  });

  it('BG_RUN_IN_BACKGROUND_DENY mentions the Maestro tool the agent must retry with', () => {
    expect(BG_RUN_IN_BACKGROUND_DENY).toContain('mcp__maestro__run_in_background');
    // The deny text is meant for the agent — has to read like an instruction,
    // not an error. Just spot-check that it's non-empty and reasonably long.
    expect(BG_RUN_IN_BACKGROUND_DENY.length).toBeGreaterThan(80);
  });
});
