import { describe, it, expect } from 'vitest';
import {
  emptyLease, isOwnerLive, acquire, release, dequeue, heartbeat, recover, isEmpty,
  LEASE_STALE_MS, type SessionLeaseRecord,
} from './session-run-queue.js';

const T0 = 1_700_000_000_000;

describe('acquire', () => {
  it('acquires a free lease', () => {
    const r = acquire(undefined, 'A', T0);
    expect(r.outcome).toBe('acquired');
    expect(r.rec.owner).toBe('A');
    expect(r.rec.waiters).toEqual([]);
  });

  it('re-acquiring as the same owner is idempotent (owned, heartbeat refreshed)', () => {
    const first = acquire(undefined, 'A', T0, undefined, 'proc-1').rec;
    const r = acquire(first, 'A', T0 + 5_000, undefined, 'proc-1');
    expect(r.outcome).toBe('owned');
    expect(r.rec.owner).toBe('A');
    expect(r.rec.heartbeatAt).toBe(T0 + 5_000);
    expect(r.rec.waiters).toEqual([]);
  });

  it('RED: the same jobId from a different live process is not local ownership', () => {
    const first = acquire(undefined, 'A', T0, undefined, 'proc-1').rec;
    const r = acquire(first, 'A', T0 + 5_000, undefined, 'proc-2');
    expect(r.outcome).toBe('contended');
    expect(r.rec.owner).toBe('A');
    expect(r.rec.heartbeatAt).toBe(T0);
    expect(r.rec.waiters).toEqual([]);
  });

  it('a second job queues behind a live owner (max concurrency 1)', () => {
    const owned = acquire(undefined, 'A', T0).rec;
    const r = acquire(owned, 'B', T0 + 1);
    expect(r.outcome).toBe('queued');
    expect(r.rec.owner).toBe('A');
    expect(r.rec.waiters).toEqual(['B']);
  });

  it('duplicate enqueue does NOT double-queue (idempotency)', () => {
    let rec = acquire(undefined, 'A', T0).rec;
    rec = acquire(rec, 'B', T0 + 1).rec;
    const r = acquire(rec, 'B', T0 + 2);
    expect(r.outcome).toBe('queued');
    expect(r.rec.waiters).toEqual(['B']); // still one B
  });

  it('preserves FIFO order across multiple waiters', () => {
    let rec = acquire(undefined, 'A', T0).rec;
    rec = acquire(rec, 'B', T0 + 1).rec;
    rec = acquire(rec, 'C', T0 + 2).rec;
    rec = acquire(rec, 'D', T0 + 3).rec;
    expect(rec.waiters).toEqual(['B', 'C', 'D']);
  });

  it('reclaims a STALE lease (crashed owner) and clears it from the wait list', () => {
    const owned: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B'] };
    const r = acquire(owned, 'B', T0 + LEASE_STALE_MS + 1);
    expect(r.outcome).toBe('acquired');
    expect(r.rec.owner).toBe('B');
    expect(r.rec.waiters).toEqual([]);
  });

  it('preserves FIFO when a new job arrives after the owner lease is stale', () => {
    const owned: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C'] };
    const r = acquire(owned, 'D', T0 + LEASE_STALE_MS + 1);
    expect(r.outcome).toBe('queued');
    expect(r.promoted).toBe('B');
    expect(r.rec.owner).toBe('B');
    expect(r.rec.waiters).toEqual(['C', 'D']);
  });
});

describe('release', () => {
  it('promotes the FIFO-earliest waiter to owner (no gap)', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C'] };
    const r = release(rec, 'A', T0 + 10);
    expect(r.next).toBe('B');
    expect(r.rec.owner).toBe('B');
    expect(r.rec.waiters).toEqual(['C']);
    expect(r.rec.heartbeatAt).toBe(T0 + 10);
  });

  it('does not stamp the releasing process token onto a promoted waiter', () => {
    const rec: SessionLeaseRecord = { owner: 'A', ownerToken: 'proc-a', acquiredAt: T0, heartbeatAt: T0, waiters: ['B'] };
    const promoted = release(rec, 'A', T0 + 10, 'proc-a').rec;
    expect(promoted.owner).toBe('B');
    expect(promoted.ownerToken).toBeNull();

    const claimedByWaiterProcess = acquire(promoted, 'B', T0 + 11, undefined, 'proc-b');
    expect(claimedByWaiterProcess.outcome).toBe('owned');
    expect(claimedByWaiterProcess.rec.ownerToken).toBe('proc-b');
  });

  it('clears the lease when the queue is empty', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: [] };
    const r = release(rec, 'A', T0 + 10);
    expect(r.next).toBeNull();
    expect(isEmpty(r.rec)).toBe(true);
  });

  it('a non-owner release only removes it from the wait list (owner keeps running)', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C'] };
    const r = release(rec, 'B', T0 + 10);
    expect(r.next).toBeNull();
    expect(r.rec.owner).toBe('A');
    expect(r.rec.waiters).toEqual(['C']);
  });
});

describe('dequeue (cancel while queued)', () => {
  it('removes a queued waiter without touching the owner', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C'] };
    const out = dequeue(rec, 'B');
    expect(out.owner).toBe('A');
    expect(out.waiters).toEqual(['C']);
  });
  it('is a no-op for the owner (owner cancel goes through release)', () => {
    const rec: SessionLeaseRecord = { owner: 'A', ownerToken: null, acquiredAt: T0, heartbeatAt: T0, waiters: ['B'] };
    expect(dequeue(rec, 'A')).toEqual(rec);
  });
});

describe('heartbeat', () => {
  it('refreshes only the owner heartbeat', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: [] };
    expect(heartbeat(rec, 'A', T0 + 50).heartbeatAt).toBe(T0 + 50);
    expect(heartbeat(rec, 'B', T0 + 50).heartbeatAt).toBe(T0); // B is not owner → no-op
  });
});

describe('isOwnerLive', () => {
  it('live within the window, dead after it', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: [] };
    expect(isOwnerLive(rec, T0 + LEASE_STALE_MS)).toBe(true);
    expect(isOwnerLive(rec, T0 + LEASE_STALE_MS + 1)).toBe(false);
    expect(isOwnerLive(emptyLease(), T0)).toBe(false);
  });
});

describe('recover (restart / orphan)', () => {
  const terminal = (ids: string[]) => (j: string) => ids.includes(j);

  it('releases a lease whose owner is terminal and promotes the next LIVE waiter (dispatch exactly once)', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C'] };
    const r = recover(rec, terminal(['A']), T0 + 1_000);
    expect(r.next).toBe('B');
    expect(r.rec.owner).toBe('B');
    expect(r.rec.waiters).toEqual(['C']);
    // Once B has RUN to completion (terminal), a later recovery promotes C — B is
    // never re-run. (The engine also guards re-dispatch with its running-map.)
    const after = recover(r.rec, terminal(['A', 'B']), T0 + 2_000);
    expect(after.next).toBe('C');
    expect(after.rec.owner).toBe('C');
  });

  it('drops terminal waiters during recovery', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C', 'D'] };
    const r = recover(rec, terminal(['A', 'B']), T0 + 1_000); // A dead owner, B a dead waiter
    expect(r.next).toBe('C'); // B skipped
    expect(r.rec.owner).toBe('C');
    expect(r.rec.waiters).toEqual(['D']);
  });

  it('re-dispatches a NON-terminal (promoted-but-never-started) owner as owner; waiters stay', () => {
    // Boot after the release→dispatch crash: A was promoted to owner (pending) but
    // never ran; A is non-terminal → re-dispatch A exactly once, B/C stay queued.
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B', 'C'] };
    const r = recover(rec, terminal([]), T0 + 1_000);
    expect(r.next).toBe('A');
    expect(r.rec.owner).toBe('A');
    expect(r.rec.waiters).toEqual(['B', 'C']);
    // idempotent while A stays non-terminal
    expect(recover(r.rec, terminal([]), T0 + 2_000).next).toBe('A');
    // once A is terminal (ran+finished) recovery does nothing new
    expect(recover(r.rec, terminal(['A']), T0 + 3_000).next).toBe('B');
  });

  it('finding-3 crash boundary: promoted owner with NO waiters is recovered, never dropped', () => {
    // release() promoted B to owner then the process died before run(B) dispatched.
    const rec: SessionLeaseRecord = { owner: 'B', acquiredAt: T0, heartbeatAt: T0, waiters: [] };
    const r = recover(rec, terminal([]), T0 + LEASE_STALE_MS + 5_000); // even long after (stale)
    expect(r.next).toBe('B');       // B is re-dispatched (it never ran)
    expect(r.rec.owner).toBe('B');
    expect(isEmpty(r.rec)).toBe(false);
  });

  it('clears a lease whose owner AND all waiters are terminal', () => {
    const rec: SessionLeaseRecord = { owner: 'A', acquiredAt: T0, heartbeatAt: T0, waiters: ['B'] };
    const r = recover(rec, terminal(['A', 'B']), T0 + 1_000);
    expect(r.next).toBeNull();
    expect(isEmpty(r.rec)).toBe(true);
  });
});

describe('end-to-end FIFO drain', () => {
  it('A→B→C run strictly one at a time in order', () => {
    let rec = acquire(undefined, 'A', T0).rec;          // A owns
    rec = acquire(rec, 'B', T0 + 1).rec;                // B queued
    rec = acquire(rec, 'C', T0 + 2).rec;                // C queued
    expect(rec).toMatchObject({ owner: 'A', waiters: ['B', 'C'] });

    let rel = release(rec, 'A', T0 + 10); rec = rel.rec; // A done → B owns
    expect(rel.next).toBe('B');
    expect(rec).toMatchObject({ owner: 'B', waiters: ['C'] });

    // A duplicate acquire from B (drain re-entry) stays 'owned', no double-run.
    expect(acquire(rec, 'B', T0 + 11).outcome).toBe('owned');

    rel = release(rec, 'B', T0 + 20); rec = rel.rec;    // B done → C owns
    expect(rel.next).toBe('C');
    expect(rec).toMatchObject({ owner: 'C', waiters: [] });

    rel = release(rec, 'C', T0 + 30); rec = rel.rec;    // C done → empty
    expect(rel.next).toBeNull();
    expect(isEmpty(rec)).toBe(true);
  });
});
