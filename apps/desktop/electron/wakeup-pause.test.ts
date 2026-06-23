/* Pure tests for the ScheduleWakeup pause tracker — see wakeup-pause.ts for
   the contract. These cover the cases that produced the wedged 11-h job in
   the wild (model fires ScheduleWakeup → SDK iterator goes dormant) plus the
   defensive edges (malformed input, error tool_result, double-pause, lifecycle
   reset) so future stream changes can't quietly regress the "session closed,
   auto-resumes" UX. */
import { describe, it, expect } from 'vitest';
import {
  parseWakeupDelay, WakeupPauseTracker,
  MIN_WAKEUP_SECONDS, MAX_WAKEUP_SECONDS,
} from './wakeup-pause.js';

describe('parseWakeupDelay', () => {
  it('returns a clamped, floored, integer seconds for valid numeric input', () => {
    expect(parseWakeupDelay({ delaySeconds: 120 })).toBe(120);
    expect(parseWakeupDelay({ delaySeconds: 120.9 })).toBe(120);
  });

  it('mirrors the SDK clamp: [60, 3600]', () => {
    expect(parseWakeupDelay({ delaySeconds: 10 })).toBe(MIN_WAKEUP_SECONDS);
    expect(parseWakeupDelay({ delaySeconds: 60 })).toBe(60);
    expect(parseWakeupDelay({ delaySeconds: 3600 })).toBe(3600);
    expect(parseWakeupDelay({ delaySeconds: 10_000 })).toBe(MAX_WAKEUP_SECONDS);
  });

  it('coerces string numbers (the JSON tool input is sometimes stringified)', () => {
    expect(parseWakeupDelay({ delaySeconds: '900' })).toBe(900);
  });

  it('returns null for missing / malformed / non-positive input', () => {
    expect(parseWakeupDelay(null)).toBeNull();
    expect(parseWakeupDelay(undefined)).toBeNull();
    expect(parseWakeupDelay({})).toBeNull();
    expect(parseWakeupDelay({ delaySeconds: 'not a number' })).toBeNull();
    expect(parseWakeupDelay({ delaySeconds: NaN })).toBeNull();
    expect(parseWakeupDelay({ delaySeconds: Infinity })).toBeNull();
    expect(parseWakeupDelay({ delaySeconds: 0 })).toBeNull();
    expect(parseWakeupDelay({ delaySeconds: -10 })).toBeNull();
  });
});

describe('WakeupPauseTracker', () => {
  const NOW = 1_000_000_000_000;
  const make = () => new WakeupPauseTracker(() => NOW);

  it('emits `paused` with pausedUntil = now + clamped*1000 on a successful ScheduleWakeup result', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 120 });
    const ev = t.onToolResult('id1', false);
    expect(ev).toEqual({ kind: 'paused', until: NOW + 120_000, reason: 'wakeup' });
    expect(t.isPaused).toBe(true);
  });

  it('ignores non-ScheduleWakeup tool_use entirely', () => {
    const t = make();
    t.onToolUse('id1', 'Bash', { command: 'ls' });
    expect(t.onToolResult('id1', false)).toBeNull();
    expect(t.isPaused).toBe(false);
  });

  it('ignores a wakeup tool_use whose input is malformed (no pause armed)', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 'oops' });
    expect(t.onToolResult('id1', false)).toBeNull();
    expect(t.isPaused).toBe(false);
  });

  it('drops the pending entry — and does NOT pause — when the tool_result is an error', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 600 });
    expect(t.onToolResult('id1', true)).toBeNull();
    expect(t.isPaused).toBe(false);
    // A subsequent assistant message must NOT spuriously emit resumed —
    // we were never paused.
    expect(t.onAssistantContent()).toBeNull();
  });

  it('emits `resumed` the first time assistant content arrives after a pause', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 60 });
    t.onToolResult('id1', false);
    expect(t.isPaused).toBe(true);
    expect(t.onAssistantContent()).toEqual({ kind: 'resumed' });
    expect(t.isPaused).toBe(false);
    // Second call is a no-op (idempotent).
    expect(t.onAssistantContent()).toBeNull();
  });

  it('debounces back-to-back wakeups inside a single dormant window', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 60 });
    t.onToolUse('id2', 'ScheduleWakeup', { delaySeconds: 120 });
    const first = t.onToolResult('id1', false);
    expect(first?.kind).toBe('paused');
    // Second wakeup while still paused — no fresh `paused` emission.
    expect(t.onToolResult('id2', false)).toBeNull();
    expect(t.isPaused).toBe(true);
  });

  it('reset() emits `resumed` when still paused so terminal states never carry a stale countdown', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 60 });
    t.onToolResult('id1', false);
    expect(t.reset()).toEqual({ kind: 'resumed' });
    // Second reset is a no-op (idempotent — runClaude's catch + post-loop
    // both call reset() and we don't want a double emission).
    expect(t.reset()).toBeNull();
  });

  it('reset() is a no-op when not paused (and clears any orphan pending entries silently)', () => {
    const t = make();
    t.onToolUse('id1', 'ScheduleWakeup', { delaySeconds: 60 });
    // No tool_result lands — the iterator simply ends.
    expect(t.reset()).toBeNull();
    // And after reset the previously-pending id no longer arms a pause.
    expect(t.onToolResult('id1', false)).toBeNull();
  });

  it('a tool_result whose id was never registered is a no-op (no false pause)', () => {
    const t = make();
    expect(t.onToolResult('unknown', false)).toBeNull();
    expect(t.isPaused).toBe(false);
  });

  it('uses the injected clock so pausedUntil is deterministic across calls', () => {
    let nowVal = NOW;
    const t = new WakeupPauseTracker(() => nowVal);
    t.onToolUse('a', 'ScheduleWakeup', { delaySeconds: 600 });
    const ev1 = t.onToolResult('a', false);
    expect(ev1).toEqual({ kind: 'paused', until: NOW + 600_000, reason: 'wakeup' });
    // Advance, resume, and the next pause uses the NEW clock.
    nowVal = NOW + 1_000_000;
    expect(t.onAssistantContent()).toEqual({ kind: 'resumed' });
    t.onToolUse('b', 'ScheduleWakeup', { delaySeconds: 60 });
    const ev2 = t.onToolResult('b', false);
    expect(ev2).toEqual({ kind: 'paused', until: NOW + 1_000_000 + 60_000, reason: 'wakeup' });
  });
});
