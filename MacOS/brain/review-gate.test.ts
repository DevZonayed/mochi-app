import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReviewArtifactBody, buildStructuredReviewPrompt, formatReviewContinuationPrompt, parseReviewResult, projectReviewGateCheckForJob, projectReviewGateForJob, sanitizeReviewDiagnostic, type ReviewGate, type ReviewGateCheck, type ReviewGateScope } from './review-gate.js';
import { gitArtifactIdentity } from './review-gate.js';
import { makeTempRepo } from './test-helpers.js';

const pass = JSON.stringify({ schemaVersion: 1, verdict: 'PASS', findings: [] });
const needs = JSON.stringify({ schemaVersion: 1, verdict: 'NEEDS_WORK', findings: [{ severity: 'high', message: 'Bug', file: 'a.ts' }] });

describe('parseReviewResult', () => {
  it('accepts exact PASS and NEEDS_WORK machine results', () => {
    expect(parseReviewResult(pass)).toMatchObject({ ok: true, result: { verdict: 'PASS', findings: [] } });
    expect(parseReviewResult(needs)).toMatchObject({ ok: true, result: { verdict: 'NEEDS_WORK', findings: [{ severity: 'high', message: 'Bug', file: 'a.ts' }] } });
  });

  it('rejects prose, malformed JSON, missing fields, accidental lowercase pass, non-array findings, and unknown fields', () => {
    for (const raw of [
      `Looks good.\n${pass}`,
      '{not json}',
      JSON.stringify({ schemaVersion: 1, verdict: 'PASS' }),
      JSON.stringify({ schemaVersion: 1, verdict: 'pass', findings: [] }),
      JSON.stringify({ schemaVersion: 1, verdict: 'PASS', findings: 'none' }),
      JSON.stringify({ schemaVersion: 1, verdict: 'PASS', findings: [], confidence: 0.99 }),
      JSON.stringify({ schemaVersion: 1, verdict: 'PASS', findings: [{ severity: 'low', message: 'x', extra: true }] }),
      JSON.stringify({ schemaVersion: 1, verdict: 'PASS', findings: [{ severity: 'critical', message: 'Remote code execution', file: 'app.ts' }] }),
    ]) {
      expect(parseReviewResult(raw).ok).toBe(false);
    }
  });

  it('redacts and caps persisted raw diagnostics', () => {
    const fakeToken = `gh${'p'}_${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
    const raw = `token=${fakeToken}\n${'x'.repeat(20_000)}`;
    const s = sanitizeReviewDiagnostic(raw);
    expect(s).not.toContain(fakeToken);
    expect(s.length).toBeLessThanOrEqual(16_384);
  });
});

describe('job review projection', () => {
  it('projects NEEDS_WORK as bounded relay-safe job.review and continuation prompt', () => {
    const gate: ReviewGate = {
      id: 'gate-1', projectId: 'p', sessionId: 's', jobId: 'j', artifactId: 'artifact-1',
      status: 'needs-work', reason: 'Reviewer returned NEEDS_WORK.', reviewerIdentity: 'Codex:gpt-5',
      schemaVersion: 1,
      parsedResult: {
        schemaVersion: 1,
        verdict: 'NEEDS_WORK',
        summary: 'Auth is broken',
        findings: Array.from({ length: 30 }, (_, i) => ({ severity: 'high' as const, message: `Bug ${i}`, file: `src/${i}.ts` })),
      },
      rawDiagnostic: `token=ghp_${'a'.repeat(30)}`,
      createdAt: 1, updatedAt: 2, completedAt: 2,
    };
    const review = projectReviewGateForJob(gate)!;
    expect(review).toMatchObject({ status: 'needs-work', verdict: 'NEEDS_WORK', gateId: 'gate-1', reviewer: 'Codex:gpt-5', summary: 'Auth is broken' });
    expect(review.findings).toHaveLength(20);
    expect(JSON.stringify(review)).not.toContain('rawDiagnostic');
    expect(JSON.stringify(review)).not.toContain('ghp_');
    const prompt = formatReviewContinuationPrompt('Original user task', review);
    expect(prompt).toContain('Original user task');
    expect(prompt).toContain('Auth is broken');
    expect(prompt).toContain('[high] src/0.ts: Bug 0');
    expect(prompt).toContain('[high] src/19.ts: Bug 19');
    expect(prompt).toContain('rerun the relevant tests');
  });

  it('projects failed-closed without fake findings', () => {
    const gate: ReviewGate = {
      id: 'gate-2', projectId: 'p', jobId: 'j', artifactId: 'artifact-2',
      status: 'failed-closed', reason: `malformed ${'x'.repeat(2000)}`, reviewerIdentity: 'Claude',
      schemaVersion: 1, rawDiagnostic: '{"secret":"sk-abcdefghijklmnop"}',
      createdAt: 1, updatedAt: 2, completedAt: 2,
    };
    const review = projectReviewGateForJob(gate)!;
    expect(review.status).toBe('failed-closed');
    expect(review.findings).toEqual([]);
    expect(review.reason.length).toBeLessThanOrEqual(700);
    expect(JSON.stringify(review)).not.toContain('sk-abcdefghijklmnop');
  });

  it('projects disallowed checks into deterministic failed-closed job.review when no gate can be projected', () => {
    const scope: ReviewGateScope = {
      projectId: 'project-secret-token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      sessionId: 'session-1',
      jobId: 'job-1',
      artifactId: '/Users/alice/private/repo review-error:abcdef',
    };
    const checks: ReviewGateCheck[] = [
      { allowed: false, status: 'failed-closed', reason: 'review-error: /Users/alice/private sk-abcdefghijklmnop' },
      { allowed: false, status: 'failed-closed', reason: 'No current review gate exists for this artifact.' },
      { allowed: false, status: 'pending', reason: 'Review is pending after restart.', gate: { id: 'gate-pending', projectId: 'p', jobId: 'j', artifactId: 'a', status: 'pending', reason: 'pending', reviewerIdentity: '/tmp/reviewer-token', schemaVersion: 1, createdAt: 1, updatedAt: 2 } },
      { allowed: false, status: 'pass', reason: 'Review gate is stale for this artifact.', gate: { id: 'gate-pass', projectId: 'p', jobId: 'j', artifactId: 'old-artifact', status: 'pass', reason: 'approved old artifact', reviewerIdentity: 'Codex', schemaVersion: 1, parsedResult: { schemaVersion: 1, verdict: 'PASS', findings: [] }, createdAt: 1, updatedAt: 2, completedAt: 2 } },
      { allowed: false, status: 'overridden', reason: 'Stale override cannot authorize this artifact.', gate: { id: 'gate-overridden', projectId: 'p', jobId: 'j', artifactId: 'old-artifact', status: 'overridden', reason: 'operator override', reviewerIdentity: 'operator', schemaVersion: 1, createdAt: 1, updatedAt: 2, completedAt: 2 } },
    ];

    for (const check of checks) {
      const first = projectReviewGateCheckForJob(check, scope, 1234, 'FallbackReviewer');
      const second = projectReviewGateCheckForJob(check, scope, 1234, 'FallbackReviewer');
      expect(first).toEqual(second);
      expect(first.status).toBe('failed-closed');
      expect(first.gateId).toMatch(/^synthetic-review-gate:/);
      expect(first.findings).toEqual([]);
      expect(first.completedAt).toBe(1234);
      expect(JSON.stringify(first)).not.toContain('sk-abcdefghijklmnop');
      expect(JSON.stringify(first)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(JSON.stringify(first)).not.toContain('/Users/alice');
      expect(JSON.stringify(first)).not.toContain('/tmp/reviewer-token');
    }
  });

  it('keeps exact NEEDS_WORK findings before falling back to synthetic failed-closed projections', () => {
    const gate: ReviewGate = {
      id: 'gate-needs', projectId: 'p', sessionId: 's', jobId: 'j', artifactId: 'artifact-1',
      status: 'needs-work', reason: 'Reviewer returned NEEDS_WORK.', reviewerIdentity: 'Codex',
      schemaVersion: 1,
      parsedResult: { schemaVersion: 1, verdict: 'NEEDS_WORK', summary: 'Fix auth', findings: [{ severity: 'critical', message: 'Do not accept stale session', file: 'auth.ts' }] },
      createdAt: 1, updatedAt: 2, completedAt: 2,
    };
    expect(projectReviewGateCheckForJob({ allowed: false, status: 'needs-work', reason: gate.reason, gate }, { projectId: 'p', sessionId: 's', jobId: 'j', artifactId: 'artifact-1' }, 99)).toMatchObject({
      status: 'needs-work',
      gateId: 'gate-needs',
      findings: [{ severity: 'critical', message: 'Do not accept stale session', file: 'auth.ts' }],
      completedAt: 2,
    });
  });
});

describe('buildStructuredReviewPrompt', () => {
  it('requires schema-v1 JSON only and contains no old prose verdict contract', () => {
    const prompt = buildStructuredReviewPrompt({
      task: 'Fix auth',
      body: 'Changed files:\napp.ts',
      mode: 'code',
    });
    expect(prompt).toContain('"schemaVersion":1');
    expect(prompt).toContain('"verdict":"PASS"|"NEEDS_WORK"');
    expect(prompt).toMatch(/nothing else/i);
    expect(prompt).not.toMatch(/Verdict:\s*APPROVED/i);
    expect(prompt).not.toMatch(/Verdict:\s*NEEDS WORK/i);
  });

  it('can include exact current git artifact context for production review prompts', () => {
    const repo = makeTempRepo();
    writeFileSync(path.join(repo, 'changed.ts'), 'export const changed = true;\n');
    writeFileSync(path.join(repo, '.env.local'), 'API_KEY=sk-abcdefghijklmnop123456\n');
    const body = buildReviewArtifactBody(repo, 'Transcript preview only');
    expect(body).toContain('## Git status');
    expect(body).toContain('changed.ts');
    expect(body).toContain('export const changed = true;');
    expect(body).not.toContain('sk-abcdefghijklmnop123456');
    expect(body).toContain('[redacted]');
    expect(body).toContain('Transcript preview only');
  });
});

describe('gitArtifactIdentity', () => {
  it('changes when reviewed dirty content is committed, and changes on material edits', () => {
    const repo = makeTempRepo();
    const file = path.join(repo, 'reviewed.txt');
    writeFileSync(file, 'reviewed content');
    const dirtyIdentity = gitArtifactIdentity(repo);

    execFileSync('git', ['add', 'reviewed.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add reviewed content'], { cwd: repo });
    expect(gitArtifactIdentity(repo)).not.toBe(dirtyIdentity);

    writeFileSync(file, 'materially changed content');
    expect(gitArtifactIdentity(repo)).not.toBe(dirtyIdentity);
  });

  it('changes for tracked deletions and symlink target changes without falling back to cwd-only', () => {
    const repo = makeTempRepo();
    writeFileSync(path.join(repo, 'delete-me.txt'), 'tracked');
    symlinkSync('delete-me.txt', path.join(repo, 'link-me'));
    execFileSync('git', ['add', 'delete-me.txt', 'link-me'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'track deletion and symlink cases'], { cwd: repo });
    const base = gitArtifactIdentity(repo);

    rmSync(path.join(repo, 'delete-me.txt'));
    const deleted = gitArtifactIdentity(repo);
    expect(deleted).not.toBe(base);

    rmSync(path.join(repo, 'link-me'));
    symlinkSync('missing-other-target.txt', path.join(repo, 'link-me'));
    expect(gitArtifactIdentity(repo)).not.toBe(deleted);
  });

  it('changes when staged content differs from the working tree and is committed', () => {
    const repo = makeTempRepo();
    const file = path.join(repo, 'split.txt');
    writeFileSync(file, 'base');
    execFileSync('git', ['add', 'split.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });

    writeFileSync(file, 'staged content');
    execFileSync('git', ['add', 'split.txt'], { cwd: repo });
    writeFileSync(file, 'working tree content');
    const reviewedIdentity = gitArtifactIdentity(repo);

    execFileSync('git', ['commit', '-m', 'commit staged content'], { cwd: repo });
    expect(gitArtifactIdentity(repo)).not.toBe(reviewedIdentity);
  });

  it('changes for branch-only renames even when tree content is identical', () => {
    const repo = makeTempRepo();
    writeFileSync(path.join(repo, 'reviewed.txt'), 'reviewed content');
    execFileSync('git', ['add', 'reviewed.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'reviewed content'], { cwd: repo });
    const reviewedIdentity = gitArtifactIdentity(repo);

    execFileSync('git', ['branch', '-m', 'mochi/renamed-after-review'], { cwd: repo });
    expect(gitArtifactIdentity(repo)).not.toBe(reviewedIdentity);
  });

  it('changes for HEAD-only changes even when tree content is identical', () => {
    const repo = makeTempRepo();
    writeFileSync(path.join(repo, 'reviewed.txt'), 'reviewed content');
    execFileSync('git', ['add', 'reviewed.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'reviewed content'], { cwd: repo });
    const reviewedIdentity = gitArtifactIdentity(repo);

    execFileSync('git', ['commit', '--allow-empty', '-m', 'metadata-only followup'], { cwd: repo });
    expect(gitArtifactIdentity(repo)).not.toBe(reviewedIdentity);
  });

  it('hashes large files through git without loading file bytes into the store process', () => {
    const repo = makeTempRepo();
    const file = path.join(repo, 'large.bin');
    writeFileSync(file, `${'a'.repeat(3 * 1024 * 1024)}\n`);
    const first = gitArtifactIdentity(repo);
    execFileSync('git', ['add', 'large.bin'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'add large file'], { cwd: repo });
    expect(gitArtifactIdentity(repo)).not.toBe(first);

    writeFileSync(file, `${'b'.repeat(3 * 1024 * 1024)}\n`);
    expect(gitArtifactIdentity(repo)).not.toBe(first);
  });

  it('uses a deterministic fail-closed identity when artifact inspection errors', () => {
    const artifactId = gitArtifactIdentity('/tmp/definitely-not-a-review-gate-repo');
    expect(gitArtifactIdentity('/tmp/definitely-not-a-review-gate-repo')).toBe(artifactId);
    expect(artifactId).toMatch(/^review-error:/);
  });
});
