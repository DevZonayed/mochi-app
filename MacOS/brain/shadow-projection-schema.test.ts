import { describe, expect, it } from 'vitest';
import {
  buildProjectView, buildSessionView, buildJobView, buildApprovalView, buildQuestionView, buildScheduleView,
  projectionDigest, tombstoneData, SHADOW_PROJECTION_SCHEMA_VERSION, PROJECTION_LIMITS,
} from './shadow-projection-schema.js';
import type { Project, ChatSession, Job, Approval, Schedule } from './store.js';

const CANARY = 'CANARY_SECRET_a1b2c3d4e5f6a7b8c9d0';

describe('shadow-projection-schema — safe versioned views', () => {
  it('projects a project with only safe fields (no local path)', () => {
    const p = { id: 'proj_1', workspaceId: 'w', name: 'Alpha', template: 't', instructions: 'x', color: '#fff', kind: 'coding', path: '/Users/bob/secret/repo', repoUrl: 'https://github.com/o/r', createdAt: 1, updatedAt: 2 } as Project;
    const e = buildProjectView(p)!;
    expect(e.collection).toBe('project');
    expect(e.entityId).toBe('proj_1');
    expect(e.data).toMatchObject({ v: SHADOW_PROJECTION_SCHEMA_VERSION, id: 'proj_1', name: 'Alpha', kind: 'coding', repoHost: 'github.com', repoPath: '/o/r', lastActivity: 2 });
    expect('repoUrl' in e.data).toBe(false);                     // no full URL (may carry credentials)
    expect(JSON.stringify(e.data)).not.toContain('/Users/bob/secret'); // local path never projected
  });

  it('redacts a secret embedded in a project name (defence-in-depth)', () => {
    const p = { id: 'proj_2', workspaceId: 'w', name: `Alpha ghp_${'x'.repeat(40)}`, template: 't', instructions: '', color: '#fff', createdAt: 1, updatedAt: 2 } as Project;
    const e = buildProjectView(p)!;
    expect(JSON.stringify(e.data)).not.toContain('ghp_');
  });

  it('projects job STATE only — never raw error/output diagnostics (HIGH-1)', () => {
    const j = { id: 'job_1', projectId: 'proj_1', title: 'Build', status: 'failed', phase: 'x', progress: 50, input: '', output: 'ok '.repeat(2000), error: `boom sk-ant-${CANARY}`, effort: 'balanced', cost: 1.25, tokens: 0, stage: 's', createdAt: 1, updatedAt: 2 } as Job;
    const e = buildJobView(j)!;
    expect(e.data.status).toBe('failed');
    expect(e.data.progress).toBe(0.5); // 50 → normalised 0..1
    expect(e.data.cost).toBe(1.25);
    // Raw diagnostics are NOT projected at all — and the secret in them cannot appear.
    expect('error' in e.data).toBe(false);
    expect('resultSummary' in e.data).toBe(false);
    expect(JSON.stringify(e.data)).not.toContain(CANARY);
  });

  it('projects approvals WITHOUT the detail field (raw command/args)', () => {
    const a = { id: 'appr_1', projectId: 'proj_1', kind: 'merge', title: 'Merge PR', subtitle: 'ready', detail: `run: rm -rf / && export TOKEN=${CANARY}`, status: 'pending', jobId: 'job_1', createdAt: 1, resolvedAt: null, updatedAt: 2 } as Approval;
    const e = buildApprovalView(a)!;
    expect(e.data).toMatchObject({ tool: 'merge', status: 'pending', title: 'Merge PR' });
    const s = JSON.stringify(e.data);
    expect(s).not.toContain(CANARY);
    expect(s).not.toContain('rm -rf');
    expect(s).not.toContain('detail');
  });

  it('projects a session with engine/model/reviewer but no worktree path', () => {
    const s = { id: 'sess_1', projectId: 'proj_1', title: 'chat', primary: { engine: 'claude', model: 'claude-opus-4-8' }, reviewer: 'off', autoPilot: true, reviewerEnabled: false, branch: 'mochi/porto/x', worktreePath: '/Users/bob/wt/secret', codename: 'porto', createdAt: 1, updatedAt: 2 } as ChatSession;
    const e = buildSessionView(s)!;
    expect(e.data).toMatchObject({ engine: 'claude', model: 'claude-opus-4-8', autopilot: true, reviewer: 'off', branch: 'mochi/porto/x' });
    expect(JSON.stringify(e.data)).not.toContain('/Users/bob/wt/secret');
  });

  it('projects a schedule WITHOUT prompt/questionAsk/chatId', () => {
    const s = { id: 'sch_1', projectId: 'proj_1', title: 'daily', time: '09:00', cadence: 'daily', enabled: true, nextRun: 123, createdAt: 1, kind: 'message', prompt: `secret ${CANARY}`, questionAsk: CANARY, chatId: '123@s.whatsapp.net' } as Schedule;
    const e = buildScheduleView(s)!;
    expect(e.data).toMatchObject({ title: 'daily', time: '09:00', cadence: 'daily', enabled: true });
    const str = JSON.stringify(e.data);
    expect(str).not.toContain(CANARY);
    expect(str).not.toContain('whatsapp');
  });

  it('projects a derived question with bounded choices', () => {
    const e = buildQuestionView({ id: 'q1', sessionId: 'sess_1', sourceJobId: 'job_1', question: 'Which option?', choices: ['A', 'B', 'C'], deadline: 999, createdAt: 5 })!;
    expect(e.collection).toBe('question');
    expect(e.data).toMatchObject({ sessionId: 'sess_1', question: 'Which option?', choices: ['A', 'B', 'C'], status: 'pending' });
  });

  it('returns null (skip) for malformed rows and bad ids', () => {
    expect(buildProjectView({ } as Project)).toBeNull();
    expect(buildProjectView({ id: 'bad id!' } as Project)).toBeNull();
    expect(buildSessionView({ id: 'sess_1' } as ChatSession)).toBeNull(); // missing projectId
    expect(buildJobView({ id: 'job_1' } as Job)).toBeNull();
  });

  it('projectionDigest is deterministic + changes on data change; tombstone digest differs', () => {
    const e = buildProjectView({ id: 'p', workspaceId: 'w', name: 'A', template: '', instructions: '', color: '', createdAt: 1, updatedAt: 2 } as Project)!;
    const d1 = projectionDigest('project', 'p', e.data);
    const d2 = projectionDigest('project', 'p', e.data);
    expect(d1).toBe(d2);
    const e2 = buildProjectView({ id: 'p', workspaceId: 'w', name: 'B', template: '', instructions: '', color: '', createdAt: 1, updatedAt: 2 } as Project)!;
    expect(projectionDigest('project', 'p', e2.data)).not.toBe(d1);
    expect(projectionDigest('project', 'p', tombstoneData('project', 'p'))).not.toBe(d1);
  });
});
