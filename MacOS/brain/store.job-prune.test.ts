/* Store.pruneOldJobs — the jobs ledger never trimmed itself, so a multi-week
   uptime would carry every job's structured transcript in memory and on disk
   forever. The retention sweep runs on every createJob (and once at boot via
   loadStore) and is the fix for the 38 GB / 3.5 h V8 OOM crash on 0.1.18.

   Contract:
   1. Up to JOB_TRANSCRIPT_RETAIN finished jobs keep their transcript intact.
   2. Beyond that, finished jobs have their transcript stripped (length 0) but
      the job row + tokens/cost/title survive for stats.
   3. Beyond JOB_HARD_RETAIN total jobs, the oldest finished ones are deleted
      outright AND a tombstone is recorded so the relay learns of the drop.
   4. Running / pending jobs are NEVER pruned, even if older than retained ones. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-jobprune-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

// Mirror the constants in store.ts. If those change the test should change with them.
const JOB_TRANSCRIPT_RETAIN = 350;
const JOB_HARD_RETAIN = 1500;

type StoreInternals = {
  data: { jobs: { id: string; status: string; transcript?: unknown[]; createdAt: number }[]; tombstones?: { kind: string; id: string }[] };
};

describe('Store.pruneOldJobs', () => {
  let s: Store;
  let projectId: string;
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    s = new Store();
    projectId = s.createProject({ name: 'Proj' }).id;
  });

  /** Seed `count` finished jobs DIRECTLY into store.data (bypassing the prune-on-
      create hook) so we can drive a one-shot prune from a known starting state.
      Each job gets a non-empty transcript so we can see strip vs. delete. */
  const seedFinishedJobs = (count: number, transcriptLen = 5) => {
    const internals = s as unknown as StoreInternals;
    const t0 = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      internals.data.jobs.push({
        id: `seed-${i}`,
        status: 'done',
        // Older first so the natural sort-by-createdAt makes them prune-targets first.
        createdAt: t0 + i * 100,
        transcript: Array.from({ length: transcriptLen }, (_, k) => ({ kind: 'text', text: `t${k}`, ts: t0 })),
      });
    }
  };

  it('keeps every transcript when below the soft cap', () => {
    seedFinishedJobs(JOB_TRANSCRIPT_RETAIN - 50);
    // Trigger a prune by adding a fresh job (createJob calls pruneOldJobs)
    s.createJob(projectId, 'fresh');
    const internals = s as unknown as StoreInternals;
    const stripped = internals.data.jobs.filter(j => Array.isArray(j.transcript) && j.transcript.length === 0).length;
    expect(stripped).toBe(0);
  });

  it('strips transcripts of finished jobs beyond the soft cap, keeps the rows', () => {
    const seeded = JOB_TRANSCRIPT_RETAIN + 200;
    seedFinishedJobs(seeded);
    s.createJob(projectId, 'fresh'); // triggers prune
    const internals = s as unknown as StoreInternals;
    // Total rows unchanged (we're still under the hard cap)
    expect(internals.data.jobs.length).toBe(seeded + 1); // +1 for the fresh job
    const stripped = internals.data.jobs.filter(j => Array.isArray(j.transcript) && j.transcript.length === 0).length;
    // 200 oldest finished jobs should have empty transcripts
    expect(stripped).toBeGreaterThanOrEqual(200);
    expect(stripped).toBeLessThan(seeded);
  });

  it('deletes the oldest finished jobs beyond the hard cap and records tombstones', () => {
    const seeded = JOB_HARD_RETAIN + 100;
    seedFinishedJobs(seeded);
    s.createJob(projectId, 'fresh'); // triggers prune
    const internals = s as unknown as StoreInternals;
    // Hard cap honoured (plus the fresh job)
    expect(internals.data.jobs.length).toBeLessThanOrEqual(JOB_HARD_RETAIN + 1);
    // The oldest seeded jobs should be GONE
    expect(internals.data.jobs.find(j => j.id === 'seed-0')).toBeUndefined();
    // And tombstones for each deletion (so the relay sync learns)
    const tombs = internals.data.tombstones ?? [];
    const jobTombs = tombs.filter(t => t.kind === 'job').length;
    expect(jobTombs).toBeGreaterThanOrEqual(100);
  });

  it('NEVER prunes running or pending jobs, however old they are', () => {
    const internals = s as unknown as StoreInternals;
    // A single ancient running job — should survive any pressure
    internals.data.jobs.push({ id: 'ancient-running', status: 'running', createdAt: 1, transcript: [{ kind: 'text', text: 'live', ts: 1 }] });
    internals.data.jobs.push({ id: 'ancient-pending', status: 'pending', createdAt: 2, transcript: [{ kind: 'text', text: 'live', ts: 2 }] });
    seedFinishedJobs(JOB_HARD_RETAIN + 50);
    s.createJob(projectId, 'fresh'); // triggers prune
    const running = internals.data.jobs.find(j => j.id === 'ancient-running');
    const pending = internals.data.jobs.find(j => j.id === 'ancient-pending');
    expect(running).toBeDefined();
    expect(pending).toBeDefined();
    // And their transcripts must NOT be stripped — they're still in flight
    expect((running!.transcript as unknown[])?.length).toBeGreaterThan(0);
    expect((pending!.transcript as unknown[])?.length).toBeGreaterThan(0);
  });
});
