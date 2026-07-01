import { describe, it, expect } from 'vitest';
import { computeHoldState, DEFAULT_LIMIT_HOLD_GRACE_MS, type TurnLike } from './queueHold';

const NOW = 1_700_000_000_000;
const mk = (t: Partial<TurnLike>): TurnLike => ({ status: 'done', ...t });

describe('computeHoldState', () => {
  it('idle session (last turn done, nothing pending) is not held — queue drains', () => {
    const s = computeHoldState({ lastTurn: mk({ status: 'done' }), hasPendingAutoContinue: false, now: NOW });
    expect(s).toEqual({ streaming: false, limitPaused: false, held: false });
  });

  it('no turns yet is not held', () => {
    expect(computeHoldState({ lastTurn: null, hasPendingAutoContinue: false, now: NOW }).held).toBe(false);
  });

  it('a live (running/pending) turn is streaming and held', () => {
    for (const status of ['running', 'pending'] as const) {
      const s = computeHoldState({ lastTurn: mk({ status }), hasPendingAutoContinue: false, now: NOW });
      expect(s.streaming).toBe(true);
      expect(s.held).toBe(true);
    }
  });

  it('a wakeup-parked turn (future countdown) is NOT streaming and (alone) not held', () => {
    // Parked on ScheduleWakeup: session is "closed, auto-resumes" — the queue may
    // send straight through (unlike a limit hold).
    const s = computeHoldState({
      lastTurn: mk({ status: 'running', pausedReason: 'wakeup', pausedUntil: NOW + 60_000 }),
      hasPendingAutoContinue: false, now: NOW,
    });
    expect(s.streaming).toBe(false);
    expect(s.limitPaused).toBe(false);
    expect(s.held).toBe(false);
  });

  it('a usage-limit turn holds the queue (the burst-bug guard)', () => {
    const s = computeHoldState({
      lastTurn: mk({ status: 'done', pausedReason: 'limit', pausedUntil: NOW + 5 * 60_000 }),
      hasPendingAutoContinue: true, now: NOW,
    });
    expect(s.streaming).toBe(false);
    expect(s.limitPaused).toBe(true);
    expect(s.held).toBe(true);
  });

  it('limit hold persists through the grace window past the countdown (no drain/auto-continue race)', () => {
    const base = mk({ status: 'done', pausedReason: 'limit', pausedUntil: NOW });
    // Just after the countdown but within grace → still held.
    expect(computeHoldState({ lastTurn: base, hasPendingAutoContinue: false, now: NOW + 30_000 }).held).toBe(true);
    // Past the grace window with nothing pending → released (cancelled schedule: no deadlock).
    expect(computeHoldState({ lastTurn: base, hasPendingAutoContinue: false, now: NOW + DEFAULT_LIMIT_HOLD_GRACE_MS + 1 }).held).toBe(false);
  });

  it('a pending auto-continue holds even if the limit turn was pruned/replaced', () => {
    const s = computeHoldState({ lastTurn: mk({ status: 'done' }), hasPendingAutoContinue: true, now: NOW });
    expect(s.held).toBe(true);
  });

  it('a limit cap with NO reported reset (pausedUntil null) holds indefinitely rather than bursting', () => {
    const s = computeHoldState({
      lastTurn: mk({ status: 'done', pausedReason: 'limit', pausedUntil: null }),
      hasPendingAutoContinue: false, now: NOW + 10 * 60 * 60_000,
    });
    expect(s.held).toBe(true);
  });

  it('the auto-continue turn going live re-holds via streaming (sequential, not burst)', () => {
    // Auto-continue fired → its fresh turn is running → held again while it works.
    const s = computeHoldState({ lastTurn: mk({ status: 'running' }), hasPendingAutoContinue: false, now: NOW });
    expect(s.streaming).toBe(true);
    expect(s.held).toBe(true);
  });

  it('after the auto-continue completes cleanly, the hold releases and the queue drains', () => {
    const s = computeHoldState({ lastTurn: mk({ status: 'done', pausedReason: null, pausedUntil: null }), hasPendingAutoContinue: false, now: NOW });
    expect(s.held).toBe(false);
  });
});
