import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from './test-helpers.js';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-review-gate-api-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import { GitService } from './git-service.js';
import type { LocalEngine } from './engine.js';
import type { Providers } from './providers.js';
import { gitArtifactIdentity } from './review-gate.js';

function setup() {
  rmSync(hoisted.dir, { recursive: true, force: true });
  const store = new Store();
  const repo = makeTempRepo();
  const project = store.createProject({ name: 'P', path: repo });
  const session = store.createSession(project.id, 'S', 'lyon');
  session.branch = 'main';
  session.worktreePath = repo;
  store.updateSession(session.id, { branch: 'main', worktreePath: repo, reviewer: { engine: 'codex' }, reviewerEnabled: true });
  const job = store.createJob(project.id, 'x', 'x', undefined, session.id);
  store.updateJob(job.id, { status: 'failed', error: 'review blocked' });
  const providers = { getLocalKey: vi.fn(() => undefined) } as unknown as Providers;
  const git = new GitService(store, vi.fn(), providers);
  const engine = {
    run: vi.fn(),
    retryReviewGate: vi.fn(async () => {
      const artifactId = gitArtifactIdentity(repo);
      return store.completeReviewGate(
        { projectId: session.projectId, sessionId: session.id, jobId: job.id, artifactId },
        { schemaVersion: 1, verdict: 'PASS', findings: [] },
        '{"schemaVersion":1,"verdict":"PASS","findings":[]}',
      );
    }),
    isRunning: vi.fn(() => false),
    cancel: vi.fn(),
  } as unknown as LocalEngine;
  const stub = {} as never;
  const dispatch = createDispatch(store, engine, stub, stub, stub, stub, stub, stub, vi.fn(), '', git);
  return { store, repo, project, session: store.getSession(session.id)!, job, git, dispatch, engine: engine as unknown as { run: ReturnType<typeof vi.fn>; retryReviewGate: ReturnType<typeof vi.fn>; isRunning: ReturnType<typeof vi.fn> } };
}

describe('review gate backend enforcement', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('manual push and PR creation reject blocked reviewer-enabled sessions', async () => {
    const { git, session } = setup();
    await expect(git.pushSession(session)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/review gate blocked/i) });
    await expect(git.createPr(session)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/review gate blocked/i) });
  });

  it('reviewer-disabled sessions are not blocked by missing gates', async () => {
    const { git, store, session } = setup();
    const disabled = store.updateSession(session.id, { reviewer: 'off', reviewerEnabled: false });
    await expect(git.createPr(disabled)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/connect GitHub|remote/i) });
  });

  it('Git actions check the newest terminal job gate, not an older terminal job', async () => {
    const { git, store, session, repo } = setup();
    const older = store.createJob(session.projectId, 'old', 'old', undefined, session.id);
    store.updateJob(older.id, { status: 'failed', error: 'old blocked' });
    store.failReviewGate({ projectId: session.projectId, sessionId: session.id, jobId: older.id, artifactId: 'old-artifact' }, 'old failed');
    const newer = store.createJob(session.projectId, 'new', 'new', undefined, session.id);
    store.updateJob(newer.id, { status: 'done', output: 'new done' });
    const artifactId = gitArtifactIdentity(repo);
    store.completeReviewGate(
      { projectId: session.projectId, sessionId: session.id, jobId: newer.id, artifactId },
      { schemaVersion: 1, verdict: 'PASS', findings: [] },
      '{"schemaVersion":1,"verdict":"PASS","findings":[]}',
    );

    await expect(git.createPr(session)).resolves.toMatchObject({ ok: false, reason: expect.not.stringMatching(/review gate blocked/i) });
  });

  it('override requires reason, records audit, and unblocks only current artifact scope', async () => {
    const { dispatch, store, repo, session, job } = setup();
    await expect(dispatch('overrideReviewGate', { sessionId: session.id, reason: '' })).rejects.toThrow(/reason/i);
    const gate = await dispatch('overrideReviewGate', { sessionId: session.id, reason: 'Known generated docs only' }) as { status?: string; override?: { actor?: string; reason?: string } };
    expect(gate.status).toBe('overridden');
    expect(gate.override).toMatchObject({ actor: 'operator', reason: 'Known generated docs only' });

    const current = store.latestSessionReviewGate(session.id)!;
    expect(store.reviewGateCheck({ projectId: session.projectId, sessionId: session.id, jobId: current.jobId, artifactId: current.artifactId }, true).allowed).toBe(true);
    writeFileSync(path.join(repo, 'changed.txt'), 'later material change');
    const laterArtifact = gitArtifactIdentity(repo);
    expect(laterArtifact).not.toBe(current.artifactId);
    expect(store.reviewGateCheck({ projectId: session.projectId, sessionId: session.id, jobId: current.jobId, artifactId: laterArtifact }, true).allowed).toBe(false);
  });

  it('getReviewGate and overrideReviewGate use project.path when session has no worktreePath', async () => {
    const { dispatch, store, repo, session, job } = setup();
    store.updateSession(session.id, { worktreePath: undefined });
    const artifactId = gitArtifactIdentity(repo);
    store.completeReviewGate(
      { projectId: session.projectId, sessionId: session.id, jobId: job.id, artifactId },
      { schemaVersion: 1, verdict: 'PASS', findings: [] },
      '{"schemaVersion":1,"verdict":"PASS","findings":[]}',
    );

    writeFileSync(path.join(repo, 'project-root-change.txt'), 'changed after pass');
    const gate = await dispatch('getReviewGate', { sessionId: session.id }) as { status?: string; artifactId?: string };
    expect(gate.status).toBe('failed-closed');
    expect(gate.artifactId).toBe(gitArtifactIdentity(repo));

    const overridden = await dispatch('overrideReviewGate', { sessionId: session.id, reason: 'Reviewed current project root' }) as { status?: string; artifactId?: string };
    expect(overridden.status).toBe('overridden');
    expect(overridden.artifactId).toBe(gitArtifactIdentity(repo));
  });

  it('retryReviewGate invokes the reviewer-only engine path without primary run or git side effects', async () => {
    const { dispatch, session, engine } = setup();
    const gate = await dispatch('retryReviewGate', { sessionId: session.id }) as { status?: string };
    expect(gate.status).toBe('pass');
    expect(engine.retryReviewGate).toHaveBeenCalledWith(session.id);
    expect(engine.run).not.toHaveBeenCalled();
  });

  it('retryReviewGate rejects while active and when reviewer is disabled', async () => {
    const active = setup();
    active.engine.isRunning.mockReturnValueOnce(true);
    await expect(active.dispatch('retryReviewGate', { sessionId: active.session.id })).rejects.toThrow(/active/i);
    expect(active.engine.retryReviewGate).not.toHaveBeenCalled();

    const disabled = setup();
    disabled.store.updateSession(disabled.session.id, { reviewer: 'off', reviewerEnabled: false });
    disabled.engine.retryReviewGate.mockRejectedValueOnce(Object.assign(new Error('reviewer is disabled for this session'), { statusCode: 400 }));
    await expect(disabled.dispatch('retryReviewGate', { sessionId: disabled.session.id })).rejects.toThrow(/disabled/i);
    expect(disabled.engine.run).not.toHaveBeenCalled();
  });

  it('retryReviewGate propagates NEEDS_WORK and failed-closed reviewer outcomes', async () => {
    const needs = setup();
    needs.engine.retryReviewGate.mockImplementationOnce(async () => {
      const artifactId = gitArtifactIdentity(needs.repo);
      return needs.store.completeReviewGate(
        { projectId: needs.session.projectId, sessionId: needs.session.id, jobId: needs.job.id, artifactId },
        { schemaVersion: 1, verdict: 'NEEDS_WORK', findings: [{ severity: 'high', message: 'Bug' }] },
        '{"schemaVersion":1,"verdict":"NEEDS_WORK","findings":[{"severity":"high","message":"Bug"}]}',
      );
    });
    await expect(needs.dispatch('retryReviewGate', { sessionId: needs.session.id })).resolves.toMatchObject({ status: 'needs-work' });

    const failed = setup();
    failed.engine.retryReviewGate.mockImplementationOnce(async () => {
      const artifactId = gitArtifactIdentity(failed.repo);
      return failed.store.failReviewGate(
        { projectId: failed.session.projectId, sessionId: failed.session.id, jobId: failed.job.id, artifactId },
        'review output is not valid JSON',
        'Verdict: APPROVED',
      );
    });
    await expect(failed.dispatch('retryReviewGate', { sessionId: failed.session.id })).resolves.toMatchObject({ status: 'failed-closed' });
  });
});
