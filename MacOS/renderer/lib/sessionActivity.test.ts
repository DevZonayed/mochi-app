/* The exact ordering the screenshot exposed (OpenMontage session 2cd82d09…):

     Turn A (real agent job cd155c9c…)  status=running   createdAt=13:26
     Turn B (injected monitor 52eda17a…) status=done      createdAt=13:29  ← latest

   Selected/latest turn = B (complete), yet the session MUST report active, the
   control/abort target MUST be A, and A must be flagged as a stranded active job
   so the UI shows an unmistakable session-level indicator + working Abort. */
import { describe, test, expect } from 'vitest';
import type { Job } from './api';
import { deriveSessionControl } from './sessionActivity.js';

function job(p: Partial<Job> & { id: string; createdAt: number }): Job {
  return {
    projectId: 'p', sessionId: 's1', title: '', status: 'running', phase: '', progress: 0,
    input: '', output: null, error: null, effort: 'balanced', cost: 0, tokens: 0, stage: '',
    updatedAt: p.createdAt, ...p,
  } as Job;
}

// turns are stored oldest-first by createdAt (compareTurnsOldestFirst).
const A = job({ id: 'A', status: 'running', createdAt: 100 });
const B_done = job({ id: 'B', status: 'done', createdAt: 200 });

describe('deriveSessionControl — session activity ≠ latest turn', () => {
  test('THE regression: older running A + newer done B (latest=B)', () => {
    const c = deriveSessionControl([A, B_done], ['A']);
    expect(c.sessionActive).toBe(true);          // NOT idle
    expect(c.activeJobIds).toEqual(['A']);
    expect(c.controlJobId).toBe('A');            // Abort targets A, not B
    expect(c.latestActive).toBe(false);          // latest turn (B) is complete
    expect(c.strandedActiveId).toBe('A');        // banner shows, linked to A
  });

  test('normal case: the latest turn is itself the active run', () => {
    const c = deriveSessionControl([B_done, A /* A newest+running */], ['A']);
    // Here A is the latest turn and it is running.
    expect(c.sessionActive).toBe(true);
    expect(c.controlJobId).toBe('A');
    expect(c.latestActive).toBe(true);
    expect(c.strandedActiveId).toBe(null);       // no banner — inline Stop covers it
  });

  test('fully idle: latest complete, nothing running', () => {
    const c = deriveSessionControl([A2done(), B_done], []);
    expect(c.sessionActive).toBe(false);
    expect(c.controlJobId).toBe(null);
    expect(c.strandedActiveId).toBe(null);
  });

  test('completion of A transitions to idle', () => {
    const Adone = job({ id: 'A', status: 'done', createdAt: 100, updatedAt: 300 });
    const c = deriveSessionControl([Adone, B_done], []);
    expect(c.sessionActive).toBe(false);
    expect(c.activeJobIds).toEqual([]);
  });

  test('reload/reconciliation: active job known only to the cache (out of page)', () => {
    // The transcript page doesn't include the running job, but the cache does.
    const c = deriveSessionControl([B_done], ['A']);
    expect(c.sessionActive).toBe(true);
    expect(c.activeJobIds).toEqual(['A']);
    expect(c.controlJobId).toBe('A');
    expect(c.strandedActiveId).toBe('A');
  });

  test('active job visible in turns even if cache lags (empty cacheActiveIds)', () => {
    const c = deriveSessionControl([A, B_done], []);
    expect(c.sessionActive).toBe(true);
    expect(c.activeJobIds).toEqual(['A']);
    expect(c.controlJobId).toBe('A');
  });

  test('multiple concurrent active jobs: oldest is the control/stranded one', () => {
    const B_run = job({ id: 'B', status: 'running', createdAt: 200 });
    const c = deriveSessionControl([A, B_run], ['A', 'B']);
    expect(c.activeJobIds).toEqual(['A', 'B']);
    expect(c.latestActive).toBe(true);           // latest (B) is active…
    expect(c.controlJobId).toBe('B');            // …so inline control targets it
    expect(c.strandedActiveId).toBe('A');        // …but A is also active → banner for A
  });

  test('paused (wakeup) latest turn is NOT active', () => {
    const paused = job({ id: 'B', status: 'running', createdAt: 200, pausedUntil: Date.now() + 60_000 });
    const c = deriveSessionControl([job({ id: 'A', status: 'done', createdAt: 100 }), paused], []);
    expect(c.sessionActive).toBe(false);
    expect(c.controlJobId).toBe(null);
  });

  test('empty session', () => {
    const c = deriveSessionControl([], []);
    expect(c.sessionActive).toBe(false);
    expect(c.controlJobId).toBe(null);
    expect(c.strandedActiveId).toBe(null);
  });
});

function A2done(): Job {
  return job({ id: 'A', status: 'done', createdAt: 100, updatedAt: 250 });
}
