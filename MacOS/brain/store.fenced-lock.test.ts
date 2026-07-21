/**
 * MED-3 reviewer reproduction + fix proof.
 *
 * (a) The dedicated file lock is FENCED: a per-acquisition token gates release + steal, so a
 *     live owner is never stolen (even after a >stale stall), a stale DEAD owner is stolen
 *     race-safely, an old owner cannot delete a successor's lock, and a steal that races a
 *     fresh replacement restores it. Exercised via injected clock/liveness/stat seams — no
 *     >10s sleeps.
 * (b) `claimIdempotentQuestionAnswer` materializes the schedule-disable + deterministic Job
 *     SYNCHRONOUSLY DURABLE before flipping the ledger `materialized:true`: a deferred-save
 *     window throws retryable and leaves the ledger resumable, so a crash never strands an
 *     applied receipt against an absent Job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} } }));

import { Store } from './store.js';

type LockHandle = { fd: number; token: string; lock: string };
interface LockPriv {
  acquireFileLock(lock: string): LockHandle | null;
  releaseFileLock(held: LockHandle): void;
  stealStaleFileLock(lock: string, expected: string): boolean;
  debugSetLockSeamsForTest(seam: { now?: () => number; pidAlive?: (pid: number) => boolean; staleMs?: number }): void;
}
const priv = (s: Store) => s as unknown as LockPriv;
const ledgerOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'maestro-idempotency.json'), 'utf8')) as Array<{ key: string; jobId: string; materialized?: boolean; scheduleToDisable?: string }>;

describe('MED-3 (a) — fenced file lock', () => {
  let dir: string; let s: Store; let lock: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fl-')); hoisted.dir = dir; s = new Store(); lock = path.join(dir, 'x.lock'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a LIVE owner is NEVER stolen — even when the lock is older than the stale threshold', () => {
    const owner = priv(s).acquireFileLock(lock)!;
    expect(owner).not.toBeNull();
    // A second instance sees the owner as LIVE + stale; a fast-advancing clock ends the wait.
    const s2 = new Store();
    let t = 1_000_000; // advances well past LOCK_TIMEOUT_MS per read so we don't sleep for real
    priv(s2).debugSetLockSeamsForTest({ now: () => (t += 10_000), pidAlive: () => true, staleMs: 0 });
    expect(priv(s2).acquireFileLock(lock)).toBeNull(); // could not steal a live owner
    expect(readFileSync(lock, 'utf8')).toBe(owner.token); // owner's lock intact
    priv(s).releaseFileLock(owner);
    expect(existsSync(lock)).toBe(false); // owner released only its OWN lock
  });

  it('a stale DEAD owner IS stolen', () => {
    const dead = priv(s).acquireFileLock(lock)!; // simulates a crashed writer's lock content
    const s2 = new Store();
    priv(s2).debugSetLockSeamsForTest({ pidAlive: () => false, staleMs: 0 }); // owner dead + stale
    const stolen = priv(s2).acquireFileLock(lock);
    expect(stolen).not.toBeNull();
    expect(readFileSync(lock, 'utf8')).toBe(stolen!.token); // s2 now owns it
    // The original (dead) owner cannot delete the successor's lock — token mismatch.
    priv(s).releaseFileLock(dead);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe(stolen!.token);
    priv(s2).releaseFileLock(stolen!);
  });

  it('steal is race-safe: a fresh replacement (content mismatch) is RESTORED, never destroyed', () => {
    writeFileSync(lock, '999:1:successorNonce'); // a successor's fresh lock
    // We believed we were stealing a DIFFERENT (dead) lock content → must restore + fail.
    expect(priv(s).stealStaleFileLock(lock, '111:1:deadNonce')).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('999:1:successorNonce'); // untouched
    // Matching content → it really was the dead lock we inspected → removed.
    expect(priv(s).stealStaleFileLock(lock, '999:1:successorNonce')).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('two stealers: only one wins; the loser does not corrupt the winner', () => {
    priv(s).acquireFileLock(lock); // held (this-process token; we simulate it dead below)
    const content = readFileSync(lock, 'utf8');
    const a = new Store(); const b = new Store();
    priv(a).debugSetLockSeamsForTest({ pidAlive: () => false, staleMs: 0 });
    priv(b).debugSetLockSeamsForTest({ pidAlive: () => false, staleMs: 0 });
    const first = priv(a).stealStaleFileLock(lock, content);  // wins the rename
    const second = priv(b).stealStaleFileLock(lock, content); // lock already gone → cannot steal
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('MED-3 (b) — durable materialization of the question-answer claim', () => {
  let dir: string; let s: Store;
  const T = 1_800_000_000_000;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'dm-')); hoisted.dir = dir; s = new Store(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seed(store: Store) {
    const p = store.createProject({ name: 'Q' });
    const sess = store.createSession(p.id, 'chat');
    const src = store.createJob(p.id, 'go', 'J', 'balanced', sess.id); store.updateJob(src.id, { status: 'running' });
    const sched = store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: sess.id, sourceJobId: src.id, fireAt: T + 60000, armedAt: T, questionAsk: JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'Yes' }] }] }) });
    return { p: p.id, sess: sess.id, src: src.id, sched: sched.id };
  }

  it('a deferred main-store save THROWS retryable and leaves the ledger resumable (no strand)', () => {
    const ids = seed(s);
    // Force the main-store write to be un-acquirable → save() would defer (saveSoon) and the
    // durable flush must instead THROW rather than flip materialized:true.
    const spy = vi.spyOn(s as unknown as { acquireLock(): number | null }, 'acquireLock').mockReturnValue(null);
    expect(() => s.claimIdempotentQuestionAnswer('shadow:ctrl:k', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:d1' }))
      .toThrow(/store-write-lock-timeout/);
    // Ledger RESERVED but NOT flipped → resumable; nothing durably materialized.
    const entry = ledgerOf(dir).find((e) => e.key === 'shadow:ctrl:k')!;
    expect(entry).toBeTruthy();
    expect(entry.materialized).toBe(false);
    expect(entry.scheduleToDisable).toBe(ids.sched);
    spy.mockRestore();

    // Simulate a crash + restart: a fresh Store reads the disk (job absent, schedule still
    // enabled) and the retry re-materializes the SAME jobId + disables the SAME schedule, durable.
    const reloaded = new Store();
    const retry = reloaded.claimIdempotentQuestionAnswer('shadow:ctrl:k', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:d1' });
    expect('conflict' in retry).toBe(false);
    if ('conflict' in retry) return;
    expect(retry.job.id).toBe(entry.jobId);
    expect(reloaded.getJob(entry.jobId)!.input).toBe('yes');
    expect(reloaded.listSchedules().find((x) => x.id === ids.sched)!.enabled).toBe(false);
    expect(ledgerOf(dir).find((e) => e.key === 'shadow:ctrl:k')!.materialized).toBe(true);

    // A THIRD independent instance sees exactly ONE terminal Job + disabled schedule.
    const third = new Store();
    expect(third.listJobs(ids.p).filter((j) => j.input === 'yes').length).toBe(1);
    expect(third.listSchedules().find((x) => x.id === ids.sched)!.enabled).toBe(false);
  });

  it('the happy path is durable immediately (schedule disabled + one Job on a fresh reload)', () => {
    const ids = seed(s);
    const res = s.claimIdempotentQuestionAnswer('shadow:ctrl:k2', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:d2' });
    expect('conflict' in res).toBe(false);
    const reloaded = new Store();
    expect(reloaded.listJobs(ids.p).filter((j) => j.input === 'yes').length).toBe(1);
    expect(reloaded.listSchedules().find((x) => x.id === ids.sched)!.enabled).toBe(false);
  });
});
