/* Pure unit tests for chatSessionToSync + jobToSyncMessages — the bridge
   between the desktop's domain shapes and the mirror wire format. */

import { describe, it, expect } from 'vitest';
import { chatSessionToSync, jobToSyncMessages } from './sync-mappers.js';
import type { ChatSession, Job } from './store.js';

function makeSession(partial: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    projectId: 'p1',
    title: 'Hello',
    createdAt: 1000,
    updatedAt: 2000,
    ...partial,
  };
}

function makeJob(partial: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    projectId: 'p1',
    title: 't',
    status: 'running',
    phase: 'plan',
    progress: 0,
    input: 'hi',
    output: null,
    error: null,
    effort: 'balanced',
    cost: 0,
    tokens: 0,
    stage: 'start',
    sessionId: 's1',
    createdAt: 1000,
    updatedAt: 1100,
    ...partial,
  };
}

describe('chatSessionToSync', () => {
  it('passes through id/projectId/title/updatedAt', () => {
    const s = chatSessionToSync(makeSession({ id: 's1', projectId: 'p1', title: 'Conv', updatedAt: 999 }));
    expect(s).toMatchObject({ id: 's1', projectId: 'p1', title: 'Conv', updatedAt: 999, archived: false });
  });

  it('collapses ms-archived-timestamp to a boolean', () => {
    expect(chatSessionToSync(makeSession({ archived: 1700000000000 })).archived).toBe(true);
    expect(chatSessionToSync(makeSession({ archived: undefined })).archived).toBe(false);
  });

  it('drops mac-only fields (sdkSessionId, branch, worktreePath)', () => {
    const s = chatSessionToSync(makeSession({
      sdkSessionId: 'sdk-x',
      branch: 'feature/x',
      worktreePath: '/tmp/wt',
    }));
    // Wire shape has no such fields — checked by absence.
    expect(s).not.toHaveProperty('sdkSessionId');
    expect(s).not.toHaveProperty('branch');
    expect(s).not.toHaveProperty('worktreePath');
  });
});

describe('jobToSyncMessages', () => {
  it('returns [] when the job is not a chat turn (no sessionId)', () => {
    expect(jobToSyncMessages(makeJob({ sessionId: undefined }))).toEqual([]);
  });

  it('emits only the user message while the job is still running with no output', () => {
    const msgs = jobToSyncMessages(makeJob({ status: 'running', output: null }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: 'j1:in', chatId: 's1', role: 'user', content: 'hi' });
  });

  it('emits both messages once output arrives (running, partial token stream)', () => {
    const msgs = jobToSyncMessages(makeJob({ status: 'running', output: 'partial reply' }));
    expect(msgs.map((m) => m.id)).toEqual(['j1:in', 'j1:out']);
    expect(msgs[1].content).toBe('partial reply');
    expect(msgs[1].role).toBe('assistant');
  });

  it('emits both even on done with empty output (so the chat shows the turn ended)', () => {
    const msgs = jobToSyncMessages(makeJob({ status: 'done', output: '' }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('');
  });

  it('on failure, the assistant message carries the error text', () => {
    const msgs = jobToSyncMessages(makeJob({ status: 'failed', output: null, error: 'rate limit' }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('(failed) rate limit');
  });

  it('ids are stable across re-emits so SyncWorker upserts (not appends)', () => {
    const partial = jobToSyncMessages(makeJob({ output: 'a' }));
    const final = jobToSyncMessages(makeJob({ output: 'final' }));
    expect(partial.map((m) => m.id)).toEqual(final.map((m) => m.id));
    expect(final[1].content).toBe('final');
  });

  it('attaches metadata so the mobile view can surface job status / engine', () => {
    const msgs = jobToSyncMessages(makeJob({ status: 'done', output: 'ok', engine: 'claude', model: 'sonnet-4' }));
    expect(msgs[0].metadata).toMatchObject({ jobId: 'j1', status: 'done', engine: 'claude', model: 'sonnet-4', kind: 'input' });
    expect(msgs[1].metadata).toMatchObject({ kind: 'output' });
  });
});
