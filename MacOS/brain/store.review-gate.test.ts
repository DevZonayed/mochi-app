import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-review-gate-store-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { projectReviewGateCheckForJob } from './review-gate.js';

function reset() {
  rmSync(hoisted.dir, { recursive: true, force: true });
  mkdirSync(hoisted.dir, { recursive: true });
}

describe('Store review gates', () => {
  beforeEach(reset);

  it('recovers pending gates after restart as failed-closed', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const session = s.createSession(p.id, 'S', 'lyon');
    const job = s.createJob(p.id, 'x', 'x', undefined, session.id);
    s.startReviewGate({ projectId: p.id, sessionId: session.id, jobId: job.id, artifactId: 'a1' }, 'codex:gpt');

    const reloaded = new Store();
    const gate = reloaded.latestSessionReviewGate(session.id);
    expect(gate?.status).toBe('failed-closed');
    expect(gate?.reason).toMatch(/pending.*restarted/i);
  });

  it('allows only exact-scope pass or override, and rejects stale artifacts', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const session = s.createSession(p.id, 'S', 'lyon');
    const job = s.createJob(p.id, 'x', 'x', undefined, session.id);
    const scope = { projectId: p.id, sessionId: session.id, jobId: job.id, artifactId: 'a1' };

    s.startReviewGate(scope, 'codex:gpt');
    s.completeReviewGate(scope, { schemaVersion: 1, verdict: 'PASS', findings: [] }, '{"schemaVersion":1,"verdict":"PASS","findings":[]}');
    expect(s.reviewGateCheck(scope, true).allowed).toBe(true);
    expect(s.reviewGateCheck({ ...scope, artifactId: 'a2' }, true).allowed).toBe(false);

    expect(() => s.overrideReviewGate({ ...scope, artifactId: 'a2' }, '  ')).toThrow(/reason/i);
    const overridden = s.overrideReviewGate({ ...scope, artifactId: 'a2' }, 'Operator accepted known risk');
    expect(overridden.status).toBe('overridden');
    expect(overridden.override).toMatchObject({ actor: 'operator', reason: 'Operator accepted known risk', scope: { artifactId: 'a2' } });
    expect(s.reviewGateCheck({ ...scope, artifactId: 'a2' }, true).allowed).toBe(true);
    expect(s.reviewGateCheck({ ...scope, artifactId: 'a3' }, true).allowed).toBe(false);
  });

  it('loads old stores without reviewGates safely', () => {
    const file = path.join(hoisted.dir, 'maestro-store.json');
    writeFileSync(file, JSON.stringify({
      deckId: 'd', deckSecret: 's', accessToken: 'a', extensionToken: 'e',
      routing: { master: 'claude', reviewer: 'off' }, settings: {},
      workspace: null, projects: [], jobs: [], sessions: [], approvals: [], schedules: [],
      skills: [], templates: [], assets: [], publishDrafts: [], publishLedger: [],
      briefs: [], researchRuns: [], events: [], chatBindings: [], pendingChats: [],
      commEvents: [], feedback: [], telegram: {}, whatsapp: {}, waChats: {}, providerKeys: {},
    }));
    const s = new Store();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { reviewGates?: unknown[] };
    expect(s.listReviewGates()).toEqual([]);
    expect(raw.reviewGates).toEqual([]);
  });

  it('does not let stale same-scope review completions overwrite newer authority', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const session = s.createSession(p.id, 'S', 'lyon');
    const job = s.createJob(p.id, 'x', 'x', undefined, session.id);
    const scope = { projectId: p.id, sessionId: session.id, jobId: job.id, artifactId: 'a1' };
    const pass = { schemaVersion: 1 as const, verdict: 'PASS' as const, findings: [] };
    const needs = { schemaVersion: 1 as const, verdict: 'NEEDS_WORK' as const, findings: [{ severity: 'high' as const, message: 'Bug' }] };

    const older = s.startReviewGate(scope, 'Codex');
    const newer = s.startReviewGate(scope, 'Codex');
    s.completeReviewGate(scope, needs, JSON.stringify(needs), newer.id);
    s.completeReviewGate(scope, pass, JSON.stringify(pass), older.id);

    expect(s.latestReviewGateFor(scope)).toMatchObject({ id: newer.id, status: 'needs-work' });
    expect(s.reviewGateCheck(scope, true).allowed).toBe(false);

    const pending = s.startReviewGate(scope, 'Codex');
    const overridden = s.overrideReviewGate(scope, 'Operator accepted risk');
    s.completeReviewGate(scope, pass, JSON.stringify(pass), pending.id);
    expect(s.latestReviewGateFor(scope)).toMatchObject({ id: overridden.id, status: 'overridden' });
  });

  it('never authorizes fail-closed inspection sentinel artifacts', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const job = s.createJob(p.id, 'x', 'x');
    const scope = { projectId: p.id, jobId: job.id, artifactId: 'review-error:abc123' };
    const pass = { schemaVersion: 1 as const, verdict: 'PASS' as const, findings: [] };

    s.startReviewGate(scope, 'Codex');
    s.completeReviewGate(scope, pass, JSON.stringify(pass));
    expect(s.reviewGateCheck(scope, true)).toMatchObject({ allowed: false, status: 'failed-closed' });
    expect(s.reviewGateCheck({ ...scope, artifactId: 'review-too-large:def456' }, true)).toMatchObject({ allowed: false, status: 'failed-closed' });
  });

  it('round-trips a defined synthetic failed-closed review for disallowed checks with no current gate', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const session = s.createSession(p.id, 'S', 'lyon');
    const job = s.createJob(p.id, 'x', 'x', undefined, session.id);
    const scope = { projectId: p.id, sessionId: session.id, jobId: job.id, artifactId: 'review-error:abc123' };
    const check = s.reviewGateCheck(scope, true);
    expect(check.allowed).toBe(false);

    const review = projectReviewGateCheckForJob(check, scope, 4242, 'Codex');
    expect(review.status).toBe('failed-closed');
    expect(review.gateId).toMatch(/^synthetic-review-gate:/);
    expect(review.findings).toEqual([]);
    s.updateJob(job.id, { status: 'gated', phase: 'Review could not complete safely', error: null, review });

    const reloaded = new Store();
    expect(reloaded.getJob(job.id)?.review).toEqual(review);
  });

  it('selects the latest session gate deterministically after merge-order shuffles', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const session = s.createSession(p.id, 'S', 'lyon');
    const j1 = s.createJob(p.id, 'x', 'x', undefined, session.id);
    const j2 = s.createJob(p.id, 'y', 'y', undefined, session.id);
    const older = s.startReviewGate({ projectId: p.id, sessionId: session.id, jobId: j1.id, artifactId: 'older' }, 'Codex');
    const newer = s.startReviewGate({ projectId: p.id, sessionId: session.id, jobId: j2.id, artifactId: 'newer' }, 'Codex');

    older.updatedAt = 10;
    older.createdAt = 10;
    newer.updatedAt = 20;
    newer.createdAt = 20;
    (s as unknown as { data: { reviewGates: unknown[] } }).data.reviewGates = [older, newer].reverse();

    expect(s.latestSessionReviewGate(session.id)?.id).toBe(newer.id);
    expect(s.listReviewGates({ sessionId: session.id }).map(g => g.id)).toEqual([newer.id, older.id]);
  });
});
