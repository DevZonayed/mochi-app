/* Store-level SessionRunQueue: proves the lease/queue is PERSISTED (survives a
   reload — not renderer/localStorage) and mutated through atomic compare-and-set. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} } }));

import { Store } from './store.js';
import { LEASE_STALE_MS } from './session-run-queue.js';

const T0 = 1_700_000_000_000;
const S1 = 'session-1', S2 = 'session-2';

describe('Store SessionRunQueue (persisted, atomic CAS)', () => {
  let store: Store;
  beforeEach(() => { hoisted.dir = mkdtempSync(path.join(tmpdir(), 'srq-store-')); store = new Store(); });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('max concurrency 1 per session: first acquires, second same-session queues', () => {
    expect(store.acquireSessionRun(S1, 'A', T0)).toBe('acquired');
    expect(store.acquireSessionRun(S1, 'B', T0 + 1)).toBe('queued');
    const lease = store.sessionRunLease(S1)!;
    expect(lease.owner).toBe('A');
    expect(lease.waiters).toEqual(['B']);
  });

  it('different sessions run concurrently (independent leases)', () => {
    expect(store.acquireSessionRun(S1, 'A', T0)).toBe('acquired');
    expect(store.acquireSessionRun(S2, 'X', T0)).toBe('acquired'); // not blocked by S1
    expect(store.sessionRunLease(S1)!.owner).toBe('A');
    expect(store.sessionRunLease(S2)!.owner).toBe('X');
  });

  it('re-acquire by the owner is idempotent (owned); duplicate waiter enqueues once', () => {
    store.acquireSessionRun(S1, 'A', T0);
    expect(store.acquireSessionRun(S1, 'A', T0 + 5)).toBe('owned');
    store.acquireSessionRun(S1, 'B', T0 + 6);
    expect(store.acquireSessionRun(S1, 'B', T0 + 7)).toBe('queued');
    expect(store.sessionRunLease(S1)!.waiters).toEqual(['B']);
  });

  it('release promotes the FIFO-earliest waiter and returns it', () => {
    store.acquireSessionRun(S1, 'A', T0);
    store.acquireSessionRun(S1, 'B', T0 + 1);
    store.acquireSessionRun(S1, 'C', T0 + 2);
    expect(store.releaseSessionRun(S1, 'A', T0 + 10)).toBe('B');
    expect(store.sessionRunLease(S1)).toMatchObject({ owner: 'B', waiters: ['C'] });
    expect(store.releaseSessionRun(S1, 'B', T0 + 20)).toBe('C');
    expect(store.releaseSessionRun(S1, 'C', T0 + 30)).toBeNull();
    expect(store.sessionRunLease(S1)).toBeUndefined(); // empty lease pruned
  });

  it('is PERSISTED: a fresh Store on the same file sees the lease (not renderer state)', () => {
    store.acquireSessionRun(S1, 'A', T0);
    store.acquireSessionRun(S1, 'B', T0 + 1);
    const reloaded = new Store();               // simulates a process restart
    const lease = reloaded.sessionRunLease(S1)!;
    expect(lease.owner).toBe('A');
    expect(lease.waiters).toEqual(['B']);
  });

  it('dequeue removes a queued waiter (cancel while queued), owner untouched', () => {
    store.acquireSessionRun(S1, 'A', T0);
    store.acquireSessionRun(S1, 'B', T0 + 1);
    store.acquireSessionRun(S1, 'C', T0 + 2);
    store.dequeueSessionRun(S1, 'B');
    expect(store.sessionRunLease(S1)).toMatchObject({ owner: 'A', waiters: ['C'] });
  });

  it('recovers a stale lease (crashed owner, no heartbeat) on next acquire', () => {
    store.acquireSessionRun(S1, 'A', T0);
    expect(store.acquireSessionRun(S1, 'B', T0 + LEASE_STALE_MS + 1)).toBe('acquired');
    expect(store.sessionRunLease(S1)!.owner).toBe('B');
  });

  it('recoverSessionRuns promotes the next waiter when the owner is terminal (exactly once)', () => {
    store.acquireSessionRun(S1, 'A', T0);
    store.acquireSessionRun(S1, 'B', T0 + 1);
    const terminal = new Set(['A']); // owner A crashed/terminalized
    const dispatch = store.recoverSessionRuns((j) => terminal.has(j), T0 + 100);
    expect(dispatch).toEqual(['B']);
    expect(store.sessionRunLease(S1)!.owner).toBe('B');
    // Once B has run to completion (terminal) a later recovery dispatches nothing.
    terminal.add('B');
    expect(store.recoverSessionRuns((j) => terminal.has(j), T0 + 200)).toEqual([]);
    expect(store.sessionRunLease(S1)).toBeUndefined();
  });

  it('finding-3: a promoted-but-never-started PENDING owner is recovered (not dropped/failed)', () => {
    const s = store.createSession('proj', 'chat');
    const owner = store.createJob('proj', 'promoted owner', '', undefined, s.id);
    // Simulate release() having promoted `owner` (still status pending, never ran) then a crash.
    store.acquireSessionRun(s.id, owner.id, T0);
    store.updateJob(owner.id, { status: 'pending' }); // never transitioned to running
    const { failed, recoverable } = store.settleOrphanedRuns();
    expect(failed.map(j => j.id)).not.toContain(owner.id);   // NOT failed
    expect(recoverable.map(j => j.id)).toContain(owner.id);  // recoverable
    const isTerminal = (id: string) => { const j = store.getJob(id); return !j || j.status === 'done' || j.status === 'failed' || j.status === 'cancelled' || j.status === 'gated'; };
    expect(store.recoverSessionRuns(isTerminal)).toEqual([owner.id]); // re-dispatched exactly once
  });

  it('TWO Store instances contend the SAME session file: exactly one owner, no lost waiter (finding 2)', () => {
    const s2 = new Store(); // a second process/instance on the SAME dedicated queue file
    expect(store.acquireSessionRun(S1, 'A', T0)).toBe('acquired');
    // s2 re-reads the file inside its CAS → sees A owns → B is FIFO-queued, not a 2nd owner.
    expect(s2.acquireSessionRun(S1, 'B', T0 + 1)).toBe('queued');
    expect(store.acquireSessionRun(S1, 'A', T0 + 2)).toBe('owned'); // A still the sole owner
    // s1 releases; the promote must see B (written by s2) — no lost waiter across instances.
    expect(store.releaseSessionRun(S1, 'A', T0 + 10)).toBe('B');
    expect(s2.acquireSessionRun(S1, 'B', T0 + 11)).toBe('owned'); // B claims ownership with s2's process token
    expect(store.acquireSessionRun(S1, 'B', T0 + 12)).toBe('contended'); // s1 cannot steal the promoted waiter
  });

  it('deleting a session clears its lease (no orphan)', () => {
    const s = store.createSession('proj', 'chat');
    store.acquireSessionRun(s.id, 'A', T0);
    expect(store.sessionRunLease(s.id)).toBeDefined();
    store.deleteSession(s.id);
    expect(store.sessionRunLease(s.id)).toBeUndefined();
  });

  it('settleOrphanedRuns fails a crashed OWNER but keeps a QUEUED waiter recoverable', () => {
    const s = store.createSession('proj', 'chat');
    const owner = store.createJob('proj', 'owner turn', '', undefined, s.id);
    const waiter = store.createJob('proj', 'queued turn', '', undefined, s.id);
    store.updateJob(owner.id, { status: 'running' });            // owner was mid-run at crash
    store.acquireSessionRun(s.id, owner.id, T0);
    store.acquireSessionRun(s.id, waiter.id, T0 + 1);            // waiter parked (status pending)
    const { failed, recoverable } = store.settleOrphanedRuns();
    expect(failed.map(j => j.id)).toContain(owner.id);
    expect(recoverable.map(j => j.id)).toEqual([waiter.id]);     // NOT failed
    expect(store.getJob(owner.id)!.status).toBe('failed');
    expect(store.getJob(waiter.id)!.status).toBe('pending');     // still queued
  });
});
