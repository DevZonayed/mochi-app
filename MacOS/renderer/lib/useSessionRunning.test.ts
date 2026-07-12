/* Per-session "is the agent running?" cache.

   Two regressions are pinned here:

   1. OpenMontage "running forever" (job 4ef47145…): a stale `running` snapshot
      for a job — the async listJobs seed captured mid-run, or a relay/bridge
      reorder — delivered AFTER the terminal frame must NOT re-spin the ring.
      Encoded as a per-job terminal latch + updatedAt ordering in `reduceRun`.

   2. "session idle while an earlier job still runs" (job cd155c9c… running while
      a LATER injected monitor turn 52eda17a… completed): session activity is
      ANY live job, not the newest one. The cache tracks a per-jobId map and the
      pill/active-id list reflect every live job.

   Pure state-machine tests — no React, no DOM, no api plumbing. */
import { describe, test, expect, beforeEach } from 'vitest';
import type { Job } from './api';
import {
  reduceRun,
  isLiveRun,
  isTerminalStatus,
  applyJobEvent,
  getSessionRunning,
  getSessionActiveJobIds,
  getProjectRunning,
  _resetRunningCacheForTests,
  type RunEntry,
} from './useSessionRunning.js';

function job(p: Partial<Job> & { sessionId: string }): Job {
  const createdAt = p.createdAt ?? 500;
  return {
    id: p.id ?? `job_${p.sessionId}_${createdAt}`,
    projectId: p.projectId ?? 'proj1',
    title: '', status: p.status ?? 'running', phase: '', progress: 0,
    input: '', output: null, error: null, effort: 'balanced', cost: 0, tokens: 0, stage: '',
    createdAt,
    updatedAt: p.updatedAt ?? createdAt,
    ...p,
  } as Job;
}

describe('reduceRun — pure per-job terminal-latch + updatedAt ordering', () => {
  test('classifies live vs terminal', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isLiveRun(job({ sessionId: 's', status: 'running' }))).toBe(true);
    expect(isLiveRun(job({ sessionId: 's', status: 'pending' }))).toBe(true);
    expect(isLiveRun(job({ sessionId: 's', status: 'done' }))).toBe(false);
  });

  test('running → done flips to not-running and latches terminal', () => {
    let e: RunEntry | undefined;
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 10 }));
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'done', updatedAt: 20 }));
    expect(e.running).toBe(false);
    expect(e.terminal).toBe(true);
  });

  test('a stale running frame after done cannot regress the terminal verdict', () => {
    let e: RunEntry | undefined;
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 30 }));
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'done', updatedAt: 40 }));
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 35 })); // late seed snapshot
    expect(e.running).toBe(false);
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 99 })); // even a "newer" one
    expect(e.running).toBe(false);
  });

  test('failed and cancelled latch identically', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      let e: RunEntry | undefined;
      e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 10 }));
      e = reduceRun(e, job({ sessionId: 's', id: 'j1', status, updatedAt: 20 }));
      e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 15 }));
      expect(e.running).toBe(false);
    }
  });

  test('out-of-order older frame for the same job is dropped', () => {
    let e: RunEntry | undefined;
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 50 }));
    const before = e;
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 20 }));
    expect(e).toBe(before);
  });

  test('a paused (wakeup) job is not running; resume brings it back', () => {
    let e: RunEntry | undefined;
    const future = Date.now() + 60_000;
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 10 }));
    expect(e.running).toBe(true);
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 20, pausedUntil: future }));
    expect(e.running).toBe(false);
    expect(e.terminal).toBe(false);
    e = reduceRun(e, job({ sessionId: 's', id: 'j1', status: 'running', updatedAt: 30, pausedUntil: null }));
    expect(e.running).toBe(true);
  });
});

describe('cache — session activity is ANY live job', () => {
  beforeEach(() => _resetRunningCacheForTests());

  test('single job: running then done', () => {
    applyJobEvent(job({ sessionId: 's1', id: 'j1', status: 'running', createdAt: 100, updatedAt: 10 }));
    expect(getSessionRunning('s1')).toBe(true);
    expect(getSessionActiveJobIds('s1')).toEqual(['j1']);
    applyJobEvent(job({ sessionId: 's1', id: 'j1', status: 'done', createdAt: 100, updatedAt: 20 }));
    expect(getSessionRunning('s1')).toBe(false);
    expect(getSessionActiveJobIds('s1')).toEqual([]);
  });

  // THE cd155c9c REGRESSION: an OLDER job is still running while a LATER injected
  // monitor turn completes. Session MUST read running, and the active id is the
  // older (stranded) job — the one Abort must target.
  test('older running + newer done → session running, active = the older job', () => {
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'running', createdAt: 100, updatedAt: 10 }));
    applyJobEvent(job({ sessionId: 's1', id: 'B', status: 'running', createdAt: 200, updatedAt: 11 }));
    applyJobEvent(job({ sessionId: 's1', id: 'B', status: 'done', createdAt: 200, updatedAt: 20 })); // monitor completes
    expect(getSessionRunning('s1')).toBe(true);
    expect(getSessionActiveJobIds('s1')).toEqual(['A']); // A still running, oldest first
  });

  test('event order independence: monitor B arrives+completes BEFORE A is seen', () => {
    // Reload/reconciliation: listJobs seed can deliver B (done) first.
    applyJobEvent(job({ sessionId: 's1', id: 'B', status: 'done', createdAt: 200, updatedAt: 20 }));
    expect(getSessionRunning('s1')).toBe(false);
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'running', createdAt: 100, updatedAt: 10 }));
    expect(getSessionRunning('s1')).toBe(true);
    expect(getSessionActiveJobIds('s1')).toEqual(['A']);
  });

  test('completion of A transitions cleanly to idle', () => {
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'running', createdAt: 100, updatedAt: 10 }));
    applyJobEvent(job({ sessionId: 's1', id: 'B', status: 'done', createdAt: 200, updatedAt: 20 }));
    expect(getSessionRunning('s1')).toBe(true);
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'done', createdAt: 100, updatedAt: 30 }));
    expect(getSessionRunning('s1')).toBe(false);
    expect(getSessionActiveJobIds('s1')).toEqual([]);
  });

  test('multiple concurrent active jobs are all represented, oldest first', () => {
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'running', createdAt: 100, updatedAt: 10 }));
    applyJobEvent(job({ sessionId: 's1', id: 'B', status: 'running', createdAt: 200, updatedAt: 11 }));
    expect(getSessionActiveJobIds('s1')).toEqual(['A', 'B']);
  });

  test('a stale running snapshot after done cannot resurrect activity', () => {
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'done', createdAt: 100, updatedAt: 40 }));
    applyJobEvent(job({ sessionId: 's1', id: 'A', status: 'running', createdAt: 100, updatedAt: 25 })); // stale seed
    expect(getSessionRunning('s1')).toBe(false);
    expect(getSessionActiveJobIds('s1')).toEqual([]);
  });

  test('project rollup: running iff ANY session has a live job', () => {
    applyJobEvent(job({ sessionId: 's1', projectId: 'p', id: 'a', status: 'running', createdAt: 100, updatedAt: 10 }));
    applyJobEvent(job({ sessionId: 's2', projectId: 'p', id: 'b', status: 'done', createdAt: 100, updatedAt: 11 }));
    expect(getProjectRunning(['s1', 's2'])).toBe(true);
    applyJobEvent(job({ sessionId: 's1', projectId: 'p', id: 'a', status: 'done', createdAt: 100, updatedAt: 20 }));
    expect(getProjectRunning(['s1', 's2'])).toBe(false);
  });

  test('reset clears all state', () => {
    applyJobEvent(job({ sessionId: 's1', id: 'j1', status: 'running', createdAt: 100, updatedAt: 10 }));
    expect(getSessionRunning('s1')).toBe(true);
    _resetRunningCacheForTests();
    expect(getSessionRunning('s1')).toBe(false);
    expect(getSessionActiveJobIds('s1')).toEqual([]);
  });
});
