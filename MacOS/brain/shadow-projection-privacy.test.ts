/**
 * HIGH-1 reviewer reproduction + fix proof — the all-project projection must NOT leak
 * filesystem paths, stack traces, or credential/connection-string secrets to the phone.
 * These are the EXACT canaries from the independent review (REVIEW.md §HIGH-1). Each
 * asserts the canary is absent from the projected `data` (which is what gets encrypted,
 * published to the relay, and stored in the mobile SQLite DB), while useful safe fields
 * (status/title/name/host) survive.
 */
import { describe, it, expect } from 'vitest';
import { buildJobView, buildProjectView } from './shadow-projection-schema.js';
import { redactProjectionPayload } from './shadow-projection-redact.js';
import type { Job, Project } from './store.js';

const CANARIES = [
  '/Users/alice/proj/src/secrets.ts',
  '/Users/alice/.aws/credentials',
  'Tr0ub4dor',                                   // db password
  'admin:Tr0ub4dor@',                            // connection-string userinfo
  '/Users/alice/Library/Application Support',    // home path
  'ci-bot:Aph5xKq9rZsecret@',                    // git-remote userinfo
  'Aph5xKq9rZsecret',                            // git-remote password
  'C:\\Users\\alice\\secret.txt',                // Windows path
  'hunter2!',                                    // short punctuated password
  'at load (',                                   // stack frame
];

function projectedText(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

describe('HIGH-1 — projection fails closed on paths / stack traces / credentials', () => {
  it('buildJobView projects NO raw error/output diagnostics (status/phase/stage/progress only)', () => {
    const job = {
      id: 'job_1', projectId: 'proj_1', sessionId: 'sess_1', title: 'Build the app',
      status: 'failed', phase: 'Compile', stage: 'link', progress: 0.5, engine: 'claude', model: 'opus', cost: 0.12,
      error: 'Error: boom at /Users/alice/proj/src/secrets.ts:42\n  at load (/Users/alice/.aws/credentials:9)',
      output: 'connected postgres://admin:Tr0ub4dor@db.internal:5432/prod ; home /Users/alice/Library/Application Support/maestro',
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
    } as unknown as Job;
    const view = buildJobView(job);
    expect(view).not.toBeNull();
    const data = view!.data;
    // Raw diagnostics are NOT projected at all.
    expect('error' in data).toBe(false);
    expect('resultSummary' in data).toBe(false);
    const text = projectedText(data);
    for (const c of CANARIES) expect(text.includes(c)).toBe(false);
    // Useful safe fields survive.
    expect(data.status).toBe('failed');
    expect(data.title).toBe('Build the app');
    expect(data.phase).toBe('Compile');
    expect(data.progress).toBe(0.5);
  });

  it('buildJobView redacts secrets in input + transcript and NEVER projects raw tool cmd', () => {
    const job = {
      id: 'job_2', projectId: 'proj_1', sessionId: 'sess_1', title: 'Fix login',
      status: 'done', phase: 'Done', progress: 1, engine: 'claude', model: 'opus', cost: 0.2,
      input: 'deploy postgres://admin:Tr0ub4dor@db.internal:5432/prod from /Users/alice/proj/src/secrets.ts',
      transcript: [
        { kind: 'thinking', text: 'the key sits in /Users/alice/.aws/credentials' },
        { kind: 'text', text: 'I fixed the auth guard and added a test.' },
        { kind: 'tool', text: 'Bash · install deps', name: 'Bash', cmd: 'curl -H "Authorization: Bearer Aph5xKq9rZsecret" https://x', toolStatus: 'done' },
        { kind: 'result', text: 'All tests passed.' },
      ],
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
    } as unknown as Job;
    const view = buildJobView(job);
    expect(view).not.toBeNull();
    const text = projectedText(view!.data);
    // Every canary from input + transcript is scrubbed.
    for (const c of CANARIES) expect(text.includes(c)).toBe(false);
    // The raw tool command is NEVER projected — only the human label.
    expect(text.includes('curl')).toBe(false);
    expect(text.includes('Bearer')).toBe(false);
    expect(text.includes('cmd')).toBe(false);
    // Safe conversation content survives for the controller.
    expect(text.includes('I fixed the auth guard')).toBe(true);
    expect(text.includes('All tests passed')).toBe(true);
    expect(text.includes('Bash')).toBe(true);
    expect(Array.isArray((view!.data as { transcript?: unknown }).transcript)).toBe(true);
  });

  it('buildProjectView never projects URL userinfo (credential-bearing repo URL)', () => {
    const project = {
      id: 'proj_1', name: 'App', kind: 'coding', color: '#fff', hidden: false,
      repoUrl: 'https://ci-bot:Aph5xKq9rZsecret@gitlab.example.com/team/app.git',
      path: '/Users/alice/proj', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
    } as unknown as Project;
    const view = buildProjectView(project);
    expect(view).not.toBeNull();
    const data = view!.data;
    const text = projectedText(data);
    for (const c of CANARIES) expect(text.includes(c)).toBe(false);
    expect(text.includes('@')).toBe(false);              // no authority userinfo at all
    expect(text.includes('/Users/alice')).toBe(false);   // no local path
    // A safe repo identity (host) still survives for the UI.
    expect(text.includes('gitlab.example.com')).toBe(true);
    expect(data.name).toBe('App');
  });

  it('buildProjectView omits repo entirely for a file:// / local-path repoUrl', () => {
    for (const raw of ['file:///Users/alice/repo', '/Users/alice/local/repo', '~/repo', 'C:\\repo\\app', 'https://user@host/x?token=abc#frag']) {
      const view = buildProjectView({ id: 'proj_x', name: 'P', repoUrl: raw } as unknown as Project);
      const text = projectedText(view!.data);
      for (const c of ['/Users/alice', 'C:\\repo', 'token=abc', '@']) expect(text.includes(c)).toBe(false);
    }
  });

  it('redactor (defense-in-depth) scrubs paths / stack frames / connection-string creds / inline secrets', () => {
    const samples: Array<[string, string[]]> = [
      ['stack at /Users/alice/proj/src/secrets.ts:42', ['/Users/alice', 'secrets.ts:42']],
      ['home /Users/alice/Library/Application Support/maestro', ['/Users/alice/Library']],
      ['creds /Users/alice/.aws/credentials', ['.aws/credentials', '/Users/alice']],
      ['db postgres://admin:Tr0ub4dor@db.internal:5432/prod', ['admin:Tr0ub4dor@', 'Tr0ub4dor']],
      ['redis redis://user:p@ss@cache:6379', ['user:p@ss@']],
      ['git https://ci-bot:Aph5xKq9rZsecret@gitlab.example.com/team/app.git', ['ci-bot:Aph5xKq9rZsecret@', 'Aph5xKq9rZsecret']],
      ['win C:\\Users\\alice\\secret.txt done', ['C:\\Users\\alice']],
      ['unc \\\\server\\share\\secret', ['\\\\server\\share']],
      ['config password=hunter2! next', ['password=hunter2!', 'hunter2!']],
      ['token: aB3-xY9_qL next', ['token: aB3-xY9_qL']],
      ['frame\n    at load (/app/x.js:9:2)', ['at load (/app/x.js:9:2)', '/app/x.js:9']],
      ['ssh /Users/alice/.ssh/id_rsa', ['.ssh/id_rsa', '/Users/alice']],
    ];
    for (const [input, mustNotContain] of samples) {
      const r = redactProjectionPayload(input);
      const out = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
      for (const secret of mustNotContain) expect(out.includes(secret)).toBe(false);
      expect(r.redactions).toBeGreaterThan(0);
    }
  });

  it('redactor keeps genuinely-safe text intact (no over-broad destruction)', () => {
    for (const safe of ['Build the app', 'Compile step 3 of 5', 'gitlab.example.com/team/app', 'claude opus', 'branch feature/login']) {
      const r = redactProjectionPayload(safe);
      expect(r.value).toBe(safe);
      expect(r.redactions).toBe(0);
    }
  });
});
