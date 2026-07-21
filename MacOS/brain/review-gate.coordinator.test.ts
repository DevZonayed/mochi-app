import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-review-gate-coordinator-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { executeReviewGate, type ReviewRunner } from './engine.js';
import { CancelledError } from './engine.js';

const pass = JSON.stringify({ schemaVersion: 1, verdict: 'PASS', findings: [] });
const needs = JSON.stringify({ schemaVersion: 1, verdict: 'NEEDS_WORK', findings: [{ severity: 'high', message: 'Bug', file: 'a.ts' }] });

function setup() {
  rmSync(hoisted.dir, { recursive: true, force: true });
  const store = new Store();
  const project = store.createProject({ name: 'P' });
  const session = store.createSession(project.id, 'S', 'lyon');
  const job = store.createJob(project.id, 'x', 'x', undefined, session.id);
  const scope = { projectId: project.id, sessionId: session.id, jobId: job.id, artifactId: 'artifact-1' };
  return { store, project, session, job, scope };
}

async function runWith(textOrError: string | Error) {
  const ctx = setup();
  const runner: ReviewRunner = vi.fn(async () => {
    if (textOrError instanceof Error) throw textOrError;
    return { text: textOrError, transcript: [], tokens: 1, cost: 0 };
  });
  const result = await executeReviewGate({
    store: ctx.store,
    scope: ctx.scope,
    reviewerIdentity: 'Codex:gpt-test',
    prompt: 'review this',
    runReviewer: runner,
  });
  return { ...ctx, result, gate: result.gate, runner };
}

describe('executeReviewGate', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('starts pending then persists PASS or NEEDS_WORK for the exact scope', async () => {
    await expect(runWith(pass)).resolves.toMatchObject({ gate: { status: 'pass' } });
    const needsCtx = await runWith(needs);
    expect(needsCtx.gate.status).toBe('needs-work');
    expect(needsCtx.store.reviewGateCheck(needsCtx.scope, true).allowed).toBe(false);
  });

  it('fails closed on malformed output, reviewer error, and cancellation before control exits', async () => {
    await expect(runWith('Verdict: APPROVED')).resolves.toMatchObject({ gate: { status: 'failed-closed' } });
    await expect(runWith(new Error('reviewer exploded'))).resolves.toMatchObject({ gate: { status: 'failed-closed', reason: 'reviewer exploded' } });

    const cancelled = await runWith(new CancelledError());
    expect(cancelled.gate.status).toBe('failed-closed');
    expect(cancelled.store.latestReviewGateFor(cancelled.scope)?.status).toBe('failed-closed');
  });

  it('emits review-gate events for pending and terminal transitions', async () => {
    const { store, scope } = setup();
    const onGate = vi.fn();
    await executeReviewGate({
      store,
      scope,
      reviewerIdentity: 'Codex',
      prompt: 'review',
      onGate,
      runReviewer: async () => ({ text: needs, transcript: [], tokens: 1, cost: 0 }),
    });

    expect(onGate).toHaveBeenCalledTimes(2);
    expect(onGate.mock.calls.map(([gate]) => gate.status)).toEqual(['pending', 'needs-work']);
  });

  it('does not let an older same-session PASS authorize a newer pending artifact scope', async () => {
    const { store, project, session, job } = setup();
    const oldScope = { projectId: project.id, sessionId: session.id, jobId: job.id, artifactId: 'old-artifact' };
    const newScope = { ...oldScope, artifactId: 'new-artifact' };
    let finishOld!: (value: { text: string; transcript: never[]; tokens: number; cost: number }) => void;
    const oldReview = new Promise<{ text: string; transcript: never[]; tokens: number; cost: number }>(resolve => { finishOld = resolve; });

    const older = executeReviewGate({
      store,
      scope: oldScope,
      reviewerIdentity: 'Codex',
      prompt: 'old review starts first',
      runReviewer: async () => oldReview,
    });
    await Promise.resolve();
    store.startReviewGate(newScope, 'Codex');
    finishOld({ text: pass, transcript: [], tokens: 1, cost: 0 });
    await older;

    expect(store.reviewGateCheck(oldScope, true).allowed).toBe(true);
    expect(store.reviewGateCheck(newScope, true)).toMatchObject({ allowed: false, status: 'pending' });
    expect(store.latestSessionReviewGate(session.id)?.artifactId).toBe('new-artifact');
  });

  it('performs automatic repository checkpoint writes before the final review-gate check and done state', () => {
    const source = readFileSync(path.join(process.cwd(), 'brain', 'engine.ts'), 'utf8');
    const checkpointIdx = source.indexOf('appendCheckpoint(cwd');
    const reviewIdx = source.indexOf('const reviewResult = await executeReviewGate');
    const finalGateIdx = source.indexOf('const gate = this.store.reviewGateCheck(gateScope, true);');
    const projectionIdx = source.indexOf('const review = projectReviewGateCheckForJob(gate, gateScope');
    const doneIdx = source.indexOf("status: 'done', phase: 'Done'");

    expect(checkpointIdx).toBeGreaterThan(0);
    expect(reviewIdx).toBeGreaterThan(0);
    expect(finalGateIdx).toBeGreaterThan(0);
    expect(projectionIdx).toBeGreaterThan(finalGateIdx);
    expect(doneIdx).toBeGreaterThan(0);
    expect(checkpointIdx).toBeLessThan(reviewIdx);
    expect(checkpointIdx).toBeLessThan(finalGateIdx);
    expect(projectionIdx).toBeLessThan(doneIdx);
    expect(checkpointIdx).toBeLessThan(doneIdx);
    expect(source).not.toContain('const review = gate.gate ? projectReviewGateForJob(gate.gate) : undefined;');
  });

  it('performs first-turn branch rename before reviewer artifact identity and keeps auto-push after final pass', () => {
    const source = readFileSync(path.join(process.cwd(), 'brain', 'engine.ts'), 'utf8');
    const preReviewRenameIdx = source.indexOf('renameSessionBranch(fresh, slugOverride)');
    const reviewIdx = source.indexOf('const reviewResult = await executeReviewGate');
    const finalGateIdx = source.indexOf('const gate = this.store.reviewGateCheck(gateScope, true);');
    const doneIdx = source.indexOf("status: 'done', phase: 'Done'");
    const autoPushIdx = source.indexOf('autoPushSession(fresh)');

    expect(preReviewRenameIdx).toBeGreaterThan(0);
    expect(reviewIdx).toBeGreaterThan(0);
    expect(finalGateIdx).toBeGreaterThan(0);
    expect(doneIdx).toBeGreaterThan(0);
    expect(autoPushIdx).toBeGreaterThan(0);
    expect(preReviewRenameIdx).toBeLessThan(reviewIdx);
    expect(preReviewRenameIdx).toBeLessThan(finalGateIdx);
    expect(finalGateIdx).toBeLessThan(doneIdx);
    expect(doneIdx).toBeLessThan(autoPushIdx);
  });
});
