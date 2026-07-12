/* Transcript precedence: a terminal turn must render terminal (composer
   re-enabled, no Stop button) even when a stale `running` frame for the SAME
   turn arrives afterwards — via the live channel OR the async seed snapshot.
   Mirrors the OpenMontage "done job, composer stuck streaming" failure. */
import { describe, test, expect } from 'vitest';
import type { Job } from './api';
import { upsertTurn, reconcileSeededTurns, mergeTurns, isTerminalTurn } from './turnState.js';

function job(p: Partial<Job> & { id: string }): Job {
  return {
    projectId: 'p', sessionId: 's1', title: '', status: 'running', phase: '', progress: 0,
    input: '', output: null, error: null, effort: 'balanced', cost: 0, tokens: 0, stage: '',
    createdAt: 100, updatedAt: 1,
    ...p,
  } as Job;
}

describe('upsertTurn — live-event precedence', () => {
  test('appends a new turn', () => {
    const out = upsertTurn([], job({ id: 'a', status: 'running', updatedAt: 1 }));
    expect(out.map(t => t.id)).toEqual(['a']);
  });

  test('applies newer frames of the same turn', () => {
    let ts: Job[] = [];
    ts = upsertTurn(ts, job({ id: 'a', status: 'running', updatedAt: 1 }));
    ts = upsertTurn(ts, job({ id: 'a', status: 'running', updatedAt: 2, progress: 50 }));
    ts = upsertTurn(ts, job({ id: 'a', status: 'done', updatedAt: 3 }));
    expect(ts[0].status).toBe('done');
  });

  test('a stale running frame after done does NOT re-open the turn', () => {
    let ts: Job[] = [job({ id: 'a', status: 'done', updatedAt: 5 })];
    ts = upsertTurn(ts, job({ id: 'a', status: 'running', updatedAt: 4 })); // late seed snapshot
    expect(ts[0].status).toBe('done');
    // Even a later-timestamped running frame can't un-finish a terminal turn.
    ts = upsertTurn(ts, job({ id: 'a', status: 'running', updatedAt: 9 }));
    expect(ts[0].status).toBe('done');
  });

  test('failed / cancelled are terminal too', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      let ts: Job[] = [job({ id: 'a', status, updatedAt: 5 })];
      ts = upsertTurn(ts, job({ id: 'a', status: 'running', updatedAt: 6 }));
      expect(ts[0].status).toBe(status);
    }
  });

  test('an out-of-order older frame is dropped (same reference back)', () => {
    const ts: Job[] = [job({ id: 'a', status: 'running', updatedAt: 5 })];
    const out = upsertTurn(ts, job({ id: 'a', status: 'running', updatedAt: 3 }));
    expect(out).toBe(ts);
  });
});

describe('reconcileSeededTurns — seed-vs-live race', () => {
  test('empty prev returns the page as-is', () => {
    const page = [job({ id: 'a', status: 'running', updatedAt: 1 })];
    expect(reconcileSeededTurns(page, [])).toBe(page);
  });

  test('keeps the live terminal copy when the page snapshot is still running', () => {
    // Live done already landed; the seed page captured the turn mid-run.
    const page = [job({ id: 'a', status: 'running', updatedAt: 2 })];
    const prev = [job({ id: 'a', status: 'done', updatedAt: 3 })];
    const out = reconcileSeededTurns(page, prev);
    expect(out[0].status).toBe('done');
  });

  test('never re-opens a terminal turn even if the page frame is newer', () => {
    const page = [job({ id: 'a', status: 'running', updatedAt: 9 })];
    const prev = [job({ id: 'a', status: 'done', updatedAt: 3 })];
    expect(reconcileSeededTurns(page, prev)[0].status).toBe('done');
  });

  test('does not leak turns from a different (previous) session', () => {
    // prev holds the OLD session's turns; only ids present in the page survive.
    const page = [job({ id: 'new', sessionId: 's2', status: 'done', updatedAt: 5 })];
    const prev = [job({ id: 'old', sessionId: 's1', status: 'running', updatedAt: 2 })];
    const out = reconcileSeededTurns(page, prev);
    expect(out.map(t => t.id)).toEqual(['new']);
  });

  test('prefers the page copy when it is the fresher one', () => {
    const page = [job({ id: 'a', status: 'done', updatedAt: 8 })];
    const prev = [job({ id: 'a', status: 'running', updatedAt: 4 })];
    expect(reconcileSeededTurns(page, prev)[0].status).toBe('done');
  });
});

describe('mergeTurns + isTerminalTurn', () => {
  test('later groups win for duplicate ids', () => {
    const older = [job({ id: 'a', status: 'running', updatedAt: 1 })];
    const current = [job({ id: 'a', status: 'done', updatedAt: 5 })];
    expect(mergeTurns(older, current)[0].status).toBe('done');
  });
  test('isTerminalTurn matches the union', () => {
    expect(isTerminalTurn('done')).toBe(true);
    expect(isTerminalTurn('failed')).toBe(true);
    expect(isTerminalTurn('cancelled')).toBe(true);
    expect(isTerminalTurn('running')).toBe(false);
    expect(isTerminalTurn('pending')).toBe(false);
  });
});
