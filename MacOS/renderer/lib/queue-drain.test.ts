import { describe, it, expect } from 'vitest';
import { canDrainQueue, type DrainState } from './queue-drain';

// A clean idle after a successful turn with one queued message — the ONLY state
// in which the next queued message may fire.
const ready: DrainState = {
  streaming: false,
  queueLength: 1,
  draining: false,
  awaitingLimitReset: false,
  lastTurnPaused: false,
  lastStatus: 'done',
};

describe('canDrainQueue', () => {
  it('drains when the last turn finished cleanly and a message is queued', () => {
    expect(canDrainQueue(ready)).toBe(true);
  });

  it('drains a fresh session (no prior turn) — e.g. a restored queue after a done turn', () => {
    expect(canDrainQueue({ ...ready, lastStatus: null })).toBe(true);
  });

  // ── Basic guards ─────────────────────────────────────────────────────────
  it('holds while the current turn is streaming', () => {
    expect(canDrainQueue({ ...ready, streaming: true })).toBe(false);
  });

  it('holds when the queue is empty', () => {
    expect(canDrainQueue({ ...ready, queueLength: 0 })).toBe(false);
  });

  it('holds while a drain is already in flight (no double-fire)', () => {
    expect(canDrainQueue({ ...ready, draining: true })).toBe(false);
  });

  // ── The reported bug: usage limit ────────────────────────────────────────
  it('HOLDS when blocked by a usage limit even though status is "done"', () => {
    // A limit-blocked turn ends as status:'done' (work + session intact). Without
    // this guard the queue would flush every message against the same limit.
    expect(canDrainQueue({ ...ready, lastStatus: 'done', awaitingLimitReset: true })).toBe(false);
  });

  it('resumes draining once the limit clears (blockedByLimit false again)', () => {
    expect(canDrainQueue({ ...ready, awaitingLimitReset: false, lastStatus: 'done' })).toBe(true);
  });

  // ── Paused / parked (ScheduleWakeup) ─────────────────────────────────────
  it('holds while the last turn is paused/parked', () => {
    expect(canDrainQueue({ ...ready, lastTurnPaused: true })).toBe(false);
  });

  // ── Failed / retry / cancelled ───────────────────────────────────────────
  it('holds on a failed turn (incl. auto-retry backoff windows)', () => {
    expect(canDrainQueue({ ...ready, lastStatus: 'failed' })).toBe(false);
  });

  it('holds on a cancelled turn (user stopped it)', () => {
    expect(canDrainQueue({ ...ready, lastStatus: 'cancelled' })).toBe(false);
  });

  it('holds on a running/pending turn', () => {
    expect(canDrainQueue({ ...ready, lastStatus: 'running', streaming: true })).toBe(false);
    expect(canDrainQueue({ ...ready, lastStatus: 'pending', streaming: true })).toBe(false);
  });

  // ── Never flush: only one clean state passes ─────────────────────────────
  it('never drains simultaneously — exactly one message fires per clean idle', () => {
    // Simulate the limit scenario end-to-end: 3 queued, limit hit → all HOLD.
    const blocked: DrainState = { ...ready, queueLength: 3, awaitingLimitReset: true };
    expect(canDrainQueue(blocked)).toBe(false);
    // Limit resets, auto-continue lands on 'done', queue still has 3 → drain ONE.
    const cleared: DrainState = { ...blocked, awaitingLimitReset: false };
    expect(canDrainQueue(cleared)).toBe(true);
    // That one is now in flight (draining) → the other two HOLD, not flushed.
    expect(canDrainQueue({ ...cleared, draining: true })).toBe(false);
  });
});
