/* Per-session turn serialization. The invariant: a session runs AT MOST one
   agent turn at a time; extra turns (an injected monitor/scheduled check landing
   while a real job is live) are parked and drained FIFO — never run concurrently
   against the same worktree/SDK session. */
import { describe, test, expect } from 'vitest';
import { SessionRunQueue } from './session-run-queue.js';

const pending = () => true; // "every parked job is still waiting"

describe('SessionRunQueue', () => {
  test('parks and drains FIFO within a session', () => {
    const q = new SessionRunQueue();
    q.park('s1', 'A', { effort: 'deep' });
    q.park('s1', 'B', { goal: true });
    expect(q.size()).toBe(2);
    const first = q.next('s1', pending);
    expect(first?.jobId).toBe('A');
    expect(first?.opts).toEqual({ effort: 'deep' }); // opts replayed verbatim
    const second = q.next('s1', pending);
    expect(second?.jobId).toBe('B');
    expect(q.next('s1', pending)).toBeNull();
    expect(q.size()).toBe(0);
  });

  test('dedupes a re-parked job id', () => {
    const q = new SessionRunQueue();
    q.park('s1', 'A', {});
    q.park('s1', 'A', {});
    expect(q.size()).toBe(1);
  });

  test('queues are independent per session', () => {
    const q = new SessionRunQueue();
    q.park('s1', 'A', {});
    q.park('s2', 'X', {});
    expect(q.next('s1', pending)?.jobId).toBe('A');
    expect(q.next('s2', pending)?.jobId).toBe('X');
  });

  test('unpark removes a job cancelled while waiting', () => {
    const q = new SessionRunQueue();
    q.park('s1', 'A', {});
    q.park('s1', 'B', {});
    expect(q.unpark('A')).toBe(true);
    expect(q.isParked('A')).toBe(false);
    expect(q.next('s1', pending)?.jobId).toBe('B'); // A skipped, B runs
  });

  test('unpark of an unknown job is a no-op', () => {
    const q = new SessionRunQueue();
    expect(q.unpark('nope')).toBe(false);
  });

  test('drain skips jobs that settled (no longer pending) while parked', () => {
    const q = new SessionRunQueue();
    q.park('s1', 'A', {});
    q.park('s1', 'B', {});
    // A was cancelled in the store while parked → not pending anymore.
    const settled = new Set(['A']);
    const isPending = (id: string) => !settled.has(id);
    const next = q.next('s1', isPending);
    expect(next?.jobId).toBe('B');
    expect(q.isParked('A')).toBe(false); // forgotten
  });

  test('next on an empty/unknown session is null', () => {
    const q = new SessionRunQueue();
    expect(q.next('nobody', pending)).toBeNull();
  });

  test('a fully-cancelled queue drains to null', () => {
    const q = new SessionRunQueue();
    q.park('s1', 'A', {});
    q.park('s1', 'B', {});
    const isPending = () => false; // both cancelled
    expect(q.next('s1', isPending)).toBeNull();
    expect(q.size()).toBe(0);
  });
});
