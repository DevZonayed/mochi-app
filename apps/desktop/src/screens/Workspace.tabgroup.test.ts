/* Tests for the Workspace tab strip's grouping logic.
 *
 * The Workspace.tsx component delegates the actual decisions to pure
 * helpers in ../lib/tab-grouping so we can verify them without a renderer.
 *
 * Two eras of helpers live here:
 *   1. The legacy multi-project group helpers (groupTabsByProject /
 *      isGroupExpanded / prunePinnedGroups). The live renderer no longer
 *      uses them, but they remain pure + tested so we can revive
 *      cross-project tab layouts later (e.g. an "All open chats" view).
 *   2. The project-scoped helpers (projectVisibleTabs / lastTabForProject)
 *      that back the current "tabs are project-specific" rule.
 */
import { describe, it, expect } from 'vitest';
import { groupTabsByProject, isGroupExpanded, prunePinnedGroups, projectVisibleTabs, lastTabForProject, type TabLike, type ExpansionState } from '../lib/tab-grouping';

const tab = (key: string, projectId: string): TabLike => ({ key, projectId });

describe('groupTabsByProject', () => {
  it('returns an empty array for no tabs', () => {
    expect(groupTabsByProject([])).toEqual([]);
  });

  it('keeps tabs of the same project together, preserving input order', () => {
    const tabs = [tab('a1', 'A'), tab('a2', 'A'), tab('a3', 'A')];
    const groups = groupTabsByProject(tabs);
    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBe('A');
    expect(groups[0].tabs.map(t => t.key)).toEqual(['a1', 'a2', 'a3']);
  });

  it('orders groups by first appearance, not alphabetically', () => {
    const tabs = [tab('z1', 'Z'), tab('a1', 'A'), tab('z2', 'Z'), tab('m1', 'M')];
    const groups = groupTabsByProject(tabs);
    expect(groups.map(g => g.projectId)).toEqual(['Z', 'A', 'M']);
    // Tabs within a group keep their relative input order across interleaving.
    expect(groups[0].tabs.map(t => t.key)).toEqual(['z1', 'z2']);
  });

  it('does not mutate the input array', () => {
    const tabs = [tab('a1', 'A'), tab('b1', 'B')];
    const before = JSON.stringify(tabs);
    groupTabsByProject(tabs);
    expect(JSON.stringify(tabs)).toBe(before);
  });
});

describe('isGroupExpanded', () => {
  const base = (over: Partial<ExpansionState> = {}): ExpansionState => ({
    activeProjectId: null,
    pinnedGroups: new Set(),
    peekGroup: null,
    groupCount: 3,
    ...over,
  });

  it('expands the only group when there is just one project (no grouping ceremony)', () => {
    expect(isGroupExpanded('A', base({ groupCount: 1, activeProjectId: null }))).toBe(true);
  });

  it('expands the active project always', () => {
    expect(isGroupExpanded('A', base({ activeProjectId: 'A' }))).toBe(true);
  });

  it('collapses non-active, non-pinned, non-peeked projects', () => {
    expect(isGroupExpanded('B', base({ activeProjectId: 'A' }))).toBe(false);
  });

  it('expands a pinned project even when it is not active', () => {
    expect(isGroupExpanded('B', base({ activeProjectId: 'A', pinnedGroups: new Set(['B']) }))).toBe(true);
  });

  it('expands the currently-peeked project', () => {
    expect(isGroupExpanded('B', base({ activeProjectId: 'A', peekGroup: 'B' }))).toBe(true);
  });

  it('does not expand a different group because another is peeked', () => {
    expect(isGroupExpanded('C', base({ activeProjectId: 'A', peekGroup: 'B' }))).toBe(false);
  });
});

describe('prunePinnedGroups', () => {
  it('drops pin ids whose project no longer has any open tab', () => {
    const groups = groupTabsByProject([tab('a1', 'A'), tab('b1', 'B')]);
    const out = prunePinnedGroups(new Set(['A', 'GONE']), groups);
    expect([...out]).toEqual(['A']);
  });

  it('returns an empty set when no pins are still live', () => {
    const groups = groupTabsByProject([tab('a1', 'A')]);
    const out = prunePinnedGroups(new Set(['X', 'Y']), groups);
    expect(out.size).toBe(0);
  });

  it('is identity when every pin is still live', () => {
    const groups = groupTabsByProject([tab('a1', 'A'), tab('b1', 'B')]);
    const out = prunePinnedGroups(new Set(['A', 'B']), groups);
    expect([...out].sort()).toEqual(['A', 'B']);
  });
});

// Sanity behavior test: collapse rules + the closing-the-only-tab UX
// invariant. closeTab itself lives in Workspace.tsx, but its observable
// effect on activeKey is what the grouping consumes.
describe('closing the only tab in the active project (UX invariant)', () => {
  it('newly-active project expands automatically after the last A-tab closes', () => {
    const before = groupTabsByProject([tab('a1', 'A'), tab('b1', 'B'), tab('b2', 'B')]);
    expect(before.map(g => g.projectId)).toEqual(['A', 'B']);
    const after = groupTabsByProject([tab('b1', 'B'), tab('b2', 'B')]);
    expect(after.map(g => g.projectId)).toEqual(['B']);
    // With only one group remaining, it expands by the groupCount<=1 rule.
    expect(isGroupExpanded('B', {
      activeProjectId: 'B', pinnedGroups: new Set(), peekGroup: null, groupCount: after.length,
    })).toBe(true);
  });
});

/* ── Project-scoped helpers (the live "tabs are project-specific" rule) ── */

describe('projectVisibleTabs', () => {
  it('returns an empty array when no project is focused yet', () => {
    expect(projectVisibleTabs([tab('a1', 'A'), tab('b1', 'B')], null)).toEqual([]);
  });

  it('keeps only the focused project\'s tabs, preserving input order', () => {
    const tabs = [tab('a1', 'A'), tab('b1', 'B'), tab('a2', 'A'), tab('b2', 'B')];
    expect(projectVisibleTabs(tabs, 'A').map(t => t.key)).toEqual(['a1', 'a2']);
    expect(projectVisibleTabs(tabs, 'B').map(t => t.key)).toEqual(['b1', 'b2']);
  });

  it('returns an empty array when the focused project has no open tabs', () => {
    expect(projectVisibleTabs([tab('a1', 'A')], 'B')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const tabs = [tab('a1', 'A'), tab('b1', 'B')];
    const before = JSON.stringify(tabs);
    projectVisibleTabs(tabs, 'A');
    expect(JSON.stringify(tabs)).toBe(before);
  });
});

describe('lastTabForProject', () => {
  it('returns null when the project has no open tabs', () => {
    expect(lastTabForProject([tab('a1', 'A')], 'B', {})).toBeNull();
  });

  it('prefers the project\'s remembered last-active tab when it is still open', () => {
    const tabs = [tab('a1', 'A'), tab('a2', 'A'), tab('a3', 'A')];
    const hit = lastTabForProject(tabs, 'A', { A: 'a2' });
    expect(hit?.key).toBe('a2');
  });

  it('falls back to the first project tab when the remembered key is gone', () => {
    const tabs = [tab('a1', 'A'), tab('a2', 'A')];
    const hit = lastTabForProject(tabs, 'A', { A: 'aOLD' });
    expect(hit?.key).toBe('a1');
  });

  it('falls back to the first project tab when no memory exists yet', () => {
    const tabs = [tab('a1', 'A'), tab('a2', 'A')];
    const hit = lastTabForProject(tabs, 'A', {});
    expect(hit?.key).toBe('a1');
  });

  it('ignores remembered keys that belong to a different project', () => {
    // Defensive: a stale memory entry shouldn't surface a foreign tab.
    const tabs = [tab('a1', 'A'), tab('b1', 'B')];
    const hit = lastTabForProject(tabs, 'A', { A: 'b1' });
    expect(hit?.key).toBe('a1');
  });
});
