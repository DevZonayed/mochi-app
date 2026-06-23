/* Selector + wiring tests for the workspace-overview hook.

   The hook is a thin React wrapper around three pieces, exercised here
   without spinning up a renderer (the desktop project doesn't ship
   jsdom/happy-dom):

   1. The shared SessionGitStatus cache's "all listeners" channel — the hook
      bumps a reducer on every event, which re-runs the aggregator.
   2. The aggregator itself (covered in workspace-overview.test.ts), here
      only sanity-piped through to prove the inputs the hook would build
      survive into a stable output.

   Persistence (only-mine, collapsed) lands in a follow-up commit + its own
   test cases. */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Stub the api module BEFORE any source imports it, so `api.subscribe` doesn't
// reach for the real bridge/EventSource that the renderer entry-point sets up.
vi.mock('../lib/api', () => {
  return {
    api: {
      listProjects: () => Promise.resolve([]),
      listSessions: () => Promise.resolve([]),
      getSessionGitStatus: () => Promise.resolve({
        sessionId: '', branch: null, base: null,
        local: { isRepo: false, ahead: 0, behind: 0, dirty: false, pushed: false },
        pr: null, state: 'no-repo', lastCheckedAt: 0,
      }),
      subscribe: (_handlers: unknown) => () => {},
    },
    IS_LOCAL: true,
  };
});

import {
  subscribeAllGitStatuses,
  _resetGitStateCacheForTests,
  getAllSessionGitStatuses,
} from '../lib/useSessionGitState';
import { aggregateWorkspaceOverview } from '../lib/workspace-overview';
import type { ChatSession, Project } from '../lib/api';
import type { SessionGitStatus } from '../lib/git-types';

beforeEach(() => {
  _resetGitStateCacheForTests();
});

describe('subscribeAllGitStatuses — the hook recompute trigger', () => {
  test('register + unsubscribe round-trip without throwing', () => {
    const calls: number[] = [];
    const unsub = subscribeAllGitStatuses(() => calls.push(Date.now()));
    expect(typeof unsub).toBe('function');
    unsub();
    expect(calls.length).toBe(0);
  });

  test('cache-empty snapshot is just an empty Map', () => {
    expect(getAllSessionGitStatuses().size).toBe(0);
  });
});

describe('aggregator pipe — what the hook feeds the strip', () => {
  test('the inputs the hook would supply produce a stable row set', () => {
    const projects: Project[] = [{
      id: 'p', workspaceId: 'w', name: 'Proj', template: '',
      instructions: '', color: 'blue', createdAt: 0,
    }];
    const sessions: ChatSession[] = [{
      id: 's', projectId: 'p', title: 't', createdAt: 0, updatedAt: Date.now(),
    }];
    const statuses = new Map<string, SessionGitStatus>([
      ['s', {
        sessionId: 's', branch: null, base: null,
        local: { isRepo: true, ahead: 0, behind: 0, dirty: true, pushed: false },
        pr: null, state: 'uncommitted', lastCheckedAt: 0,
      }],
    ]);
    const out = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].topState).toBe('uncommitted');
    expect(out.attentionProjects).toBe(1);
  });
});
