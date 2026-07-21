/* Trigger-idempotency ledger: a duplicate trigger occurrence resolves to the
   ORIGINAL job and never creates/executes a second side effect — persisted across
   restart, bounded retention, and CRASH-SAFE at every boundary (the reservation is
   persisted with a deterministic jobId BEFORE the job row, so a crash between the two
   materializes the SAME id on retry — never a second job/side effect). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} } }));

import { Store } from './store.js';

const spec = (input: string, extra: Record<string, unknown> = {}) => ({ projectId: 'proj', input, title: input, ...extra });
const ledgerOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'maestro-idempotency.json'), 'utf8')) as Array<{ key: string; jobId: string; materialized?: boolean }>;

describe('claimIdempotentJob', () => {
  let store: Store;
  beforeEach(() => { hoisted.dir = mkdtempSync(path.join(tmpdir(), 'idem-')); store = new Store(); });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('a duplicate key resolves to the ORIGINAL job (no second job, no second side effect)', () => {
    const first = store.claimIdempotentJob('cron:sched-1:1000', spec('cron fire', { title: 'Scheduled' }));
    const before = store.listJobs?.().length ?? store['data'].jobs.length;
    const second = store.claimIdempotentJob('cron:sched-1:1000', spec('cron fire', { title: 'Scheduled' }));
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);   // same job
    expect(store['data'].jobs.length).toBe(before); // no second job row
  });

  it('distinct occurrences create distinct jobs', () => {
    const a = store.claimIdempotentJob('cron:sched-1:1000', spec('a'));
    const b = store.claimIdempotentJob('cron:sched-1:2000', spec('b'));
    expect(a.job.id).not.toBe(b.job.id);
    expect(a.duplicate).toBe(false); expect(b.duplicate).toBe(false);
  });

  it('is RESTART-SAFE: a duplicate after reload resolves to the original job', () => {
    const first = store.claimIdempotentJob('wa:msg-42', spec('inbound', { title: 'WA' }));
    const reloaded = new Store();                // process restart
    const before = reloaded['data'].jobs.length;
    const dup = reloaded.claimIdempotentJob('wa:msg-42', spec('inbound', { title: 'WA' }));
    expect(dup.duplicate).toBe(true);
    expect(dup.job.id).toBe(first.job.id);
    expect(reloaded['data'].jobs.length).toBe(before); // no second job across restart
  });

  it('CRASH after reservation, BEFORE the job row → retry materializes the SAME reserved id (no second job)', () => {
    // Force createJob to throw AFTER the reservation is persisted — the exact crash window.
    vi.spyOn(store, 'createJob').mockImplementationOnce(() => { throw new Error('crash between reserve and create'); });
    expect(() => store.claimIdempotentJob('cron:s:1', spec('fire'))).toThrow(/crash/);

    // The reservation is on disk with the deterministic jobId and materialized:false.
    const led = ledgerOf(hoisted.dir);
    const entry = led.find(e => e.key === 'cron:s:1');
    expect(entry).toBeTruthy();
    expect(entry!.materialized).toBe(false);
    const reservedId = entry!.jobId;
    expect(store.getJob(reservedId)).toBeUndefined(); // job row never got created

    // Restart: the retry MUST materialize the reserved id, run it (duplicate:false), NEVER a new id.
    const reloaded = new Store();
    const retry = reloaded.claimIdempotentJob('cron:s:1', spec('fire'));
    expect(retry.duplicate).toBe(false);            // never ran → the retry runs it
    expect(retry.job.id).toBe(reservedId);          // SAME id, no second job
    expect(ledgerOf(hoisted.dir).find(e => e.key === 'cron:s:1')!.materialized).toBe(true);
  });

  it('CRASH heal uses the RESERVED spec, not the retry caller\'s changed spec (stable reservation)', () => {
    // Reserve with the ORIGINAL creation data, then crash before the row is created.
    vi.spyOn(store, 'createJob').mockImplementationOnce(() => { throw new Error('crash after reserve'); });
    expect(() => store.claimIdempotentJob('chat:k', spec('ORIGINAL text', { sessionId: 'sess-A', title: 'Orig' }))).toThrow(/crash/);
    const reservedId = ledgerOf(hoisted.dir).find(e => e.key === 'chat:k')!.jobId;

    // Retry with the SAME key but DIFFERENT text/session — the reserved job must be
    // materialized from the ORIGINAL reserved spec, never the retry's divergent data.
    const reloaded = new Store();
    const retry = reloaded.claimIdempotentJob('chat:k', spec('DIFFERENT text', { sessionId: 'sess-B', title: 'Changed' }));
    expect(retry.job.id).toBe(reservedId);
    expect(retry.job.input).toBe('ORIGINAL text');   // reserved data wins
    expect(retry.job.sessionId).toBe('sess-A');
    expect(retry.job.title).toBe('Orig');
  });

  it('CRASH after job row, BEFORE run → a reserved-but-never-run job is recoverable (one job, one run)', () => {
    const { job } = store.claimIdempotentJob('api:k', spec('do it'));
    // The job exists and is pending; engine.run() never happened (the caller crashed).
    expect(store.getJob(job.id)?.status).toBe('pending');
    // A retry sees it as a duplicate (does NOT create/run a second one)…
    const retry = store.claimIdempotentJob('api:k', spec('do it'));
    expect(retry.duplicate).toBe(true);
    expect(retry.job.id).toBe(job.id);
    // …and boot recovery re-dispatches exactly this reserved pending job.
    expect(store.idempotentPendingJobIds()).toContain(job.id);
    // settleOrphanedRuns must SPARE it (recoverable), not fail it.
    const swept = store.settleOrphanedRuns();
    expect(swept.failed.map(j => j.id)).not.toContain(job.id);
    expect(swept.recoverable.map(j => j.id)).toContain(job.id);
  });

  it('once the reserved job has actually run (terminal), it is NOT re-dispatched by recovery', () => {
    const { job } = store.claimIdempotentJob('api:done', spec('ran'));
    store.updateJob(job.id, { status: 'done' });
    expect(store.idempotentPendingJobIds()).not.toContain(job.id);
  });

  it('recreates when a MATERIALIZED job was explicitly deleted (stale key self-heals to a fresh id)', () => {
    const first = store.claimIdempotentJob('retry:job-9:1', spec('retry', { title: 'R' }));
    store.deleteJob(first.job.id); // explicit deletion (not a crash) → the reservation was materialized
    const again = store.claimIdempotentJob('retry:job-9:1', spec('retry', { title: 'R' }));
    expect(again.duplicate).toBe(false);         // stale mapping dropped → fresh job
    expect(again.job.id).not.toBe(first.job.id);
  });

  it('is ATOMIC across TWO Store instances: one job, the second resolves to the original', () => {
    const s2 = new Store(); // second process/instance on the SAME idempotency file+lock
    const r1 = store.claimIdempotentJob('cron:sched-9:1000', spec('x'));
    const r2 = s2.claimIdempotentJob('cron:sched-9:1000', spec('x'));
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.job.id).toBe(r1.job.id);
  });

  it('idempotentJobIdFor exposes the mapping', () => {
    const r = store.claimIdempotentJob('api:key-xyz', spec('api', { title: 'API' }));
    expect(store.idempotentJobIdFor('api:key-xyz')).toBe(r.job.id);
    expect(store.idempotentJobIdFor('api:nope')).toBeUndefined();
  });
});

/* Phase 3A2b1 §1 — the product-idempotent question-answer seam. ONE atomic claim binds a
   command idempotency key → the disabled auto-answer schedule + exactly one deterministic
   answer Job. This is the fix for the stranding defect: a crash AFTER the product effect
   (schedule disabled) but BEFORE the shadow receipt must replay to the SAME Job
   (duplicate:true) — never "question not pending". Divergent answers conflict; two processes
   serialize; the reservation→materialization window is crash-safe against a REAL Store. */
describe('claimIdempotentQuestionAnswer', () => {
  let store: Store;
  const T = 1_800_000_000_000;
  beforeEach(() => { hoisted.dir = mkdtempSync(path.join(tmpdir(), 'idemq-')); store = new Store(); });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  /** Seed a project/session/source-job + an armed auto-answer schedule (a pending question). */
  function seedQuestion(s: Store): { p: string; sess: string; src: string; sched: string } {
    const p = s.createProject({ name: 'Q' });
    const sess = s.createSession(p.id, 'chat');
    const src = s.createJob(p.id, 'go', 'J', 'balanced', sess.id); s.updateJob(src.id, { status: 'running' });
    const sched = s.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: sess.id, sourceJobId: src.id, fireAt: T + 60000, armedAt: T, questionAsk: JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'Yes' }] }] }) });
    return { p: p.id, sess: sess.id, src: src.id, sched: sched.id };
  }
  const answer = (s: Store, ids: { sess: string; src: string }, extra: { answer?: string; answerDigest?: string } = {}) =>
    s.claimIdempotentQuestionAnswer('shadow:ctrl:k1', { sessionId: ids.sess, sourceJobId: ids.src, answer: extra.answer ?? 'yes', answerDigest: extra.answerDigest ?? 'sha256:d1' });

  it('claims exactly one answer Job AND disables the pending schedule (atomic product effect)', () => {
    const ids = seedQuestion(store);
    const res = answer(store, ids);
    expect('conflict' in res).toBe(false);
    if ('conflict' in res) return;
    expect(res.duplicate).toBe(false);
    expect(res.job.input).toBe('yes');
    expect(store.listSchedules().find(x => x.id === ids.sched)!.enabled).toBe(false);           // schedule disabled
    expect(store.listJobs(ids.p).filter(j => j.input === 'yes').length).toBe(1);
  });

  it('SAME key + SAME answer → the ORIGINAL Job (duplicate:true), NOT "question not pending"', () => {
    const ids = seedQuestion(store);
    const first = answer(store, ids);
    if ('conflict' in first) throw new Error('unexpected conflict');
    // The schedule is now disabled — a NAIVE re-answer would see "not pending". The claim must
    // instead resolve the same key to the same Job.
    const dup = answer(store, ids);
    expect('conflict' in dup).toBe(false);
    if ('conflict' in dup) return;
    expect(dup.duplicate).toBe(true);
    expect(dup.job.id).toBe(first.job.id);          // same Job, no second answer
    expect(store.listJobs(ids.p).filter(j => j.input === 'yes').length).toBe(1);
  });

  it('SAME key + DIFFERENT answer digest → conflict (no second/altered effect)', () => {
    const ids = seedQuestion(store);
    const first = answer(store, ids, { answerDigest: 'sha256:d1' });
    if ('conflict' in first) throw new Error('unexpected conflict');
    const clash = answer(store, ids, { answer: 'no', answerDigest: 'sha256:d2' });
    expect('conflict' in clash).toBe(true);
    if ('conflict' in clash) expect(clash.conflict).toBe('answer-digest-mismatch');
    expect(store.listJobs(ids.p).filter(j => j.input === 'no').length).toBe(0);
  });

  it('a NEW key whose question is already answered (schedule disabled) → question-not-pending', () => {
    const ids = seedQuestion(store);
    const first = answer(store, ids);
    if ('conflict' in first) throw new Error('unexpected conflict');
    // A DISTINCT controller command (different key) tries to answer the same, now-resolved question.
    const other = store.claimIdempotentQuestionAnswer('shadow:ctrl:k2', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:d9' });
    expect('conflict' in other).toBe(true);
    if ('conflict' in other) expect(other.conflict).toBe('question-not-pending');
    expect(store.listJobs(ids.p).filter(j => j.input === 'yes').length).toBe(1); // still exactly one
  });

  it('unknown session → session-not-found (before any Job is created)', () => {
    const res = store.claimIdempotentQuestionAnswer('shadow:ctrl:kX', { sessionId: 'nope', sourceJobId: 'nope', answer: 'yes', answerDigest: 'sha256:dz' });
    expect('conflict' in res).toBe(true);
    if ('conflict' in res) expect(res.conflict).toBe('session-not-found');
  });

  it('no matching pending question for the source job → question-not-pending', () => {
    const ids = seedQuestion(store);
    const res = store.claimIdempotentQuestionAnswer('shadow:ctrl:kY', { sessionId: ids.sess, sourceJobId: 'other-job', answer: 'yes', answerDigest: 'sha256:dy' });
    expect('conflict' in res).toBe(true);
    if ('conflict' in res) expect(res.conflict).toBe('question-not-pending');
  });

  it('is RESTART-SAFE: a duplicate after reload resolves to the original answer Job', () => {
    const ids = seedQuestion(store);
    const first = answer(store, ids);
    if ('conflict' in first) throw new Error('unexpected conflict');
    const reloaded = new Store();                    // process restart on the SAME paths
    const dup = reloaded.claimIdempotentQuestionAnswer('shadow:ctrl:k1', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:d1' });
    expect('conflict' in dup).toBe(false);
    if ('conflict' in dup) return;
    expect(dup.duplicate).toBe(true);
    expect(dup.job.id).toBe(first.job.id);
    expect(reloaded.listSchedules().find(x => x.id === ids.sched)!.enabled).toBe(false);
  });

  it('CRASH after reservation, BEFORE materialize → retry re-materializes the SAME Job + disables the SAME schedule', () => {
    const ids = seedQuestion(store);
    // Force createJob to throw AFTER the reservation is persisted (reserve→materialize window).
    vi.spyOn(store, 'createJob').mockImplementationOnce(() => { throw new Error('crash between reserve and materialize'); });
    expect(() => answer(store, ids)).toThrow(/crash/);
    // The reservation is on disk with a deterministic jobId + the schedule to disable, materialized:false.
    const led = ledgerOf(hoisted.dir);
    const entry = led.find(e => e.key === 'shadow:ctrl:k1');
    expect(entry).toBeTruthy();
    expect(entry!.materialized).toBe(false);
    const reservedId = entry!.jobId;
    expect(store.getJob(reservedId)).toBeUndefined();          // job row never created
    // The schedule may still be enabled since the atomic createJob write never landed.
    // Restart: the retry materializes the SAME reserved id AND disables the schedule in one write.
    const reloaded = new Store();
    const retry = reloaded.claimIdempotentQuestionAnswer('shadow:ctrl:k1', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:d1' });
    expect('conflict' in retry).toBe(false);
    if ('conflict' in retry) return;
    expect(retry.duplicate).toBe(false);                        // never materialized → the retry runs it
    expect(retry.job.id).toBe(reservedId);                      // SAME id, no second Job
    expect(reloaded.listSchedules().find(x => x.id === ids.sched)!.enabled).toBe(false); // schedule now disabled
    expect(ledgerOf(hoisted.dir).find(e => e.key === 'shadow:ctrl:k1')!.materialized).toBe(true);
  });

  it('is ATOMIC across TWO Store instances: one answer Job, the second resolves to the original', () => {
    const ids = seedQuestion(store);
    const s2 = new Store(); // second process/instance on the SAME idempotency file+lock
    const r1 = store.claimIdempotentQuestionAnswer('shadow:ctrl:kc', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:dc' });
    const r2 = s2.claimIdempotentQuestionAnswer('shadow:ctrl:kc', { sessionId: ids.sess, sourceJobId: ids.src, answer: 'yes', answerDigest: 'sha256:dc' });
    expect('conflict' in r1).toBe(false); expect('conflict' in r2).toBe(false);
    if ('conflict' in r1 || 'conflict' in r2) return;
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.job.id).toBe(r1.job.id);
    expect(store.listJobs(ids.p).filter(j => j.input === 'yes').length).toBe(1);
  });
});
