/* Pure aggregator — no DOM. */
import { describe, test, expect } from 'vitest';
import {
  aggregateWorkspaceOverview,
  emptyStateMessage,
  needsAttention,
  rowAriaLabel,
} from './workspace-overview';
import type { ChatSession, Project } from './api';
import type { SessionGitState, SessionGitStatus } from './git-types';

const NOW = 1_700_000_000_000;

const proj = (id: string, name: string, color = 'blue'): Project => ({
  id, workspaceId: 'w', name, template: '', instructions: '', color,
  createdAt: 0,
});

const sess = (id: string, projectId: string, title: string, updatedAt = NOW): ChatSession => ({
  id, projectId, title, createdAt: 0, updatedAt,
});

const status = (sessionId: string, state: SessionGitState): SessionGitStatus => ({
  sessionId, branch: null, base: null,
  local: { isRepo: true, ahead: 0, behind: 0, dirty: false, pushed: false },
  pr: null, state, lastCheckedAt: 0,
});

const statusMap = (...entries: SessionGitStatus[]): Map<string, SessionGitStatus> => {
  const m = new Map<string, SessionGitStatus>();
  for (const e of entries) m.set(e.sessionId, e);
  return m;
};

describe('aggregateWorkspaceOverview — sort order', () => {
  test('conflicts beat mergeable beat blocked beat push beat dirty; clean omitted', () => {
    const projects = [
      proj('p-clean', 'Clean Project'),
      proj('p-dirty', 'Dirty Project'),
      proj('p-push', 'Push Project'),
      proj('p-blocked', 'Blocked Project'),
      proj('p-mergeable', 'Mergeable Project'),
      proj('p-conflicts', 'Conflicts Project'),
    ];
    const sessions = [
      sess('s-clean', 'p-clean', 'c1'),
      sess('s-dirty', 'p-dirty', 'd1'),
      sess('s-push', 'p-push', 'p1'),
      sess('s-blocked', 'p-blocked', 'b1'),
      sess('s-merge', 'p-mergeable', 'm1'),
      sess('s-conf', 'p-conflicts', 'cf1'),
    ];
    const statuses = statusMap(
      status('s-clean', 'clean'),
      status('s-dirty', 'uncommitted'),
      status('s-push', 'ready-to-push'),
      status('s-blocked', 'pr-blocked'),
      status('s-merge', 'pr-mergeable'),
      status('s-conf', 'pr-conflicts'),
    );
    const { rows, totalProjects, attentionProjects } = aggregateWorkspaceOverview({
      projects, sessions, statuses, onlyMine: false, now: NOW,
    });
    expect(totalProjects).toBe(6);
    // Clean project omitted.
    expect(attentionProjects).toBe(5);
    expect(rows.map(r => r.projectId)).toEqual([
      'p-conflicts', 'p-mergeable', 'p-blocked', 'p-push', 'p-dirty',
    ]);
    // ready-for-pr ranks between blocked and ready-to-push.
    const withReadyForPr = aggregateWorkspaceOverview({
      projects: [proj('p-rfpr', 'RFP Project'), proj('p-blocked', 'Blocked'), proj('p-push', 'Push')],
      sessions: [
        sess('s-rfpr', 'p-rfpr', 'rfp1'),
        sess('s-bk', 'p-blocked', 'bk1'),
        sess('s-pu', 'p-push', 'pu1'),
      ],
      statuses: statusMap(
        status('s-rfpr', 'ready-for-pr'),
        status('s-bk', 'pr-blocked'),
        status('s-pu', 'ready-to-push'),
      ),
      onlyMine: false, now: NOW,
    });
    expect(withReadyForPr.rows.map(r => r.topState)).toEqual([
      'pr-blocked', 'ready-for-pr', 'ready-to-push',
    ]);
  });

  test('ties on topState fall back to attentionCount then projectName', () => {
    const projects = [
      proj('p-b', 'Beta'),     // 1 conflict
      proj('p-a', 'Alpha'),    // 1 conflict
      proj('p-c', 'Charlie'),  // 2 conflicts → screams loudest
    ];
    const sessions = [
      sess('s-b1', 'p-b', 'b1'),
      sess('s-a1', 'p-a', 'a1'),
      sess('s-c1', 'p-c', 'c1'),
      sess('s-c2', 'p-c', 'c2'),
    ];
    const statuses = statusMap(
      status('s-b1', 'pr-conflicts'),
      status('s-a1', 'pr-conflicts'),
      status('s-c1', 'pr-conflicts'),
      status('s-c2', 'pr-conflicts'),
    );
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    // 2-conflict Charlie first, then Alpha (alphabetical), then Beta.
    expect(rows.map(r => r.projectId)).toEqual(['p-c', 'p-a', 'p-b']);
  });
});

describe('aggregateWorkspaceOverview — pills', () => {
  test('one pill per distinct state, sorted by urgency, capped at 3', () => {
    const projects = [proj('p', 'P')];
    const sessions = [
      sess('s1', 'p', 't1'),
      sess('s2', 'p', 't2'),
      sess('s3', 'p', 't3'),
      sess('s4', 'p', 't4'),
      sess('s5', 'p', 't5'),
    ];
    // mergeable x2, conflicts x1, push x1, dirty x1 → top should be conflicts;
    // pills capped at 3 → conflicts, mergeable, push (dirty drops off).
    const statuses = statusMap(
      status('s1', 'pr-mergeable'),
      status('s2', 'pr-mergeable'),
      status('s3', 'pr-conflicts'),
      status('s4', 'ready-to-push'),
      status('s5', 'uncommitted'),
    );
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.topState).toBe('pr-conflicts');
    expect(r.attentionCount).toBe(5);
    expect(r.pills.map(p => p.label)).toEqual([
      '1 conflicts', '2 mergeable', '1 ready to push',
    ]);
  });

  test('topSessionId is the newest session matching topState', () => {
    const projects = [proj('p', 'P')];
    const sessions = [
      sess('s-old', 'p', 'old', NOW - 5000),
      sess('s-new', 'p', 'new', NOW - 1000), // newest mergeable
      sess('s-mid', 'p', 'mid', NOW - 3000),
    ];
    const statuses = statusMap(
      status('s-old', 'pr-mergeable'),
      status('s-new', 'pr-mergeable'),
      status('s-mid', 'pr-mergeable'),
    );
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    expect(rows[0].topSessionId).toBe('s-new');
  });
});

describe('aggregateWorkspaceOverview — only-mine filter', () => {
  test('hides projects whose only attention sessions are stale', () => {
    const projects = [proj('p-fresh', 'Fresh'), proj('p-stale', 'Stale')];
    const sessions = [
      sess('s-fresh', 'p-fresh', 'f', NOW - 1 * 24 * 60 * 60 * 1000),  // 1d
      sess('s-stale', 'p-stale', 's', NOW - 30 * 24 * 60 * 60 * 1000), // 30d
    ];
    const statuses = statusMap(
      status('s-fresh', 'uncommitted'),
      status('s-stale', 'pr-conflicts'),
    );
    const onlyMine = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: true, now: NOW });
    expect(onlyMine.rows.map(r => r.projectId)).toEqual(['p-fresh']);
    const all = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    expect(all.rows.map(r => r.projectId)).toEqual(['p-stale', 'p-fresh']);
  });

  test('a project with ANY fresh attention session stays visible', () => {
    const projects = [proj('p', 'P')];
    const sessions = [
      sess('s-stale', 'p', 'stale', NOW - 60 * 24 * 60 * 60 * 1000),
      sess('s-fresh', 'p', 'fresh', NOW - 60 * 1000),
    ];
    const statuses = statusMap(
      status('s-stale', 'pr-conflicts'),
      status('s-fresh', 'uncommitted'),
    );
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: true, now: NOW });
    expect(rows).toHaveLength(1);
    // Top state still wins from the stale session (PR conflicts > uncommitted),
    // but the project is visible because at least one session is fresh.
    expect(rows[0].topState).toBe('pr-conflicts');
  });
});

describe('aggregateWorkspaceOverview — edge cases', () => {
  test('archived sessions never contribute to attention', () => {
    const projects = [proj('p', 'P')];
    const sessions = [
      { ...sess('s', 'p', 't'), archived: NOW - 1 },
    ];
    const statuses = statusMap(status('s', 'pr-conflicts'));
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    expect(rows).toHaveLength(0);
  });

  test('no projects → empty result', () => {
    expect(aggregateWorkspaceOverview({
      projects: [], sessions: [], statuses: new Map(), onlyMine: false, now: NOW,
    })).toEqual({ rows: [], totalProjects: 0, attentionProjects: 0 });
  });

  test('all clean → empty rows, totalProjects preserved', () => {
    const projects = [proj('p1', 'A'), proj('p2', 'B')];
    const sessions = [sess('s1', 'p1', 't'), sess('s2', 'p2', 't')];
    const statuses = statusMap(status('s1', 'clean'), status('s2', 'clean'));
    const r = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    expect(r.rows).toEqual([]);
    expect(r.totalProjects).toBe(2);
    expect(r.attentionProjects).toBe(0);
  });

  test('cache miss → session contributes nothing (no-repo not an attention state)', () => {
    const projects = [proj('p', 'P')];
    const sessions = [sess('s-uncached', 'p', 't')];
    const { rows } = aggregateWorkspaceOverview({
      projects, sessions, statuses: new Map(), onlyMine: false, now: NOW,
    });
    expect(rows).toHaveLength(0);
  });

  test('provisional ready-for-pr (pushed, PR not yet checked) is held back', () => {
    // The cheap local-only fetch reports a pushed branch as ready-for-pr before
    // GitHub is queried. If a PR is actually merged the next poll flips it to
    // pr-merged and the row would vanish — so don't show it until confirmed.
    const projects = [proj('p', 'P')];
    const sessions = [sess('s', 'p', 't')];
    const provisional: SessionGitStatus = {
      sessionId: 's', branch: 'b', base: 'master',
      local: { isRepo: true, ahead: 2, behind: 0, dirty: false, pushed: true },
      pr: null, state: 'ready-for-pr', lastCheckedAt: 0, prChecked: false,
    };
    const held = aggregateWorkspaceOverview({
      projects, sessions, statuses: statusMap(provisional), onlyMine: false, now: NOW,
    });
    expect(held.rows).toHaveLength(0);

    // Once the poll confirms it (prChecked: true, still no PR), it surfaces.
    const confirmed = aggregateWorkspaceOverview({
      projects, sessions, statuses: statusMap({ ...provisional, prChecked: true }), onlyMine: false, now: NOW,
    });
    expect(confirmed.rows.map(r => r.topState)).toEqual(['ready-for-pr']);
  });

  test('un-pushed dirty session shows immediately even before PR check', () => {
    // No remote branch ⇒ no PR possible ⇒ the local state is final, not a guess.
    const projects = [proj('p', 'P')];
    const sessions = [sess('s', 'p', 't')];
    const localOnly: SessionGitStatus = {
      sessionId: 's', branch: 'b', base: 'master',
      local: { isRepo: true, ahead: 1, behind: 0, dirty: true, pushed: false },
      pr: null, state: 'uncommitted', lastCheckedAt: 0, prChecked: false,
    };
    const { rows } = aggregateWorkspaceOverview({
      projects, sessions, statuses: statusMap(localOnly), onlyMine: false, now: NOW,
    });
    expect(rows.map(r => r.topState)).toEqual(['uncommitted']);
  });

  test('pr-merged and pr-closed do NOT trigger attention', () => {
    const projects = [proj('p1', 'M'), proj('p2', 'C')];
    const sessions = [sess('s1', 'p1', 't'), sess('s2', 'p2', 't')];
    const statuses = statusMap(status('s1', 'pr-merged'), status('s2', 'pr-closed'));
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    expect(rows).toEqual([]);
  });
});

describe('helpers', () => {
  test('needsAttention matches the strip definition', () => {
    expect(needsAttention('pr-conflicts')).toBe(true);
    expect(needsAttention('pr-mergeable')).toBe(true);
    expect(needsAttention('uncommitted')).toBe(true);
    expect(needsAttention('clean')).toBe(false);
    expect(needsAttention('pr-merged')).toBe(false);
    expect(needsAttention('pr-closed')).toBe(false);
    expect(needsAttention('no-repo')).toBe(false);
  });

  test('emptyStateMessage pluralises sanely', () => {
    expect(emptyStateMessage(0)).toBe('No projects yet');
    expect(emptyStateMessage(1)).toBe('Everything clean across 1 project');
    expect(emptyStateMessage(5)).toBe('Everything clean across 5 projects');
  });

  test('rowAriaLabel mentions every pill + top state', () => {
    const projects = [proj('p', 'Acme')];
    const sessions = [sess('s1', 'p', 't1'), sess('s2', 'p', 't2')];
    const statuses = statusMap(
      status('s1', 'pr-mergeable'),
      status('s2', 'pr-conflicts'),
    );
    const { rows } = aggregateWorkspaceOverview({ projects, sessions, statuses, onlyMine: false, now: NOW });
    const label = rowAriaLabel(rows[0]);
    expect(label).toContain('Acme');
    expect(label).toContain('1 conflicts');
    expect(label).toContain('1 mergeable');
    expect(label).toContain('PR · conflicts');
  });
});
