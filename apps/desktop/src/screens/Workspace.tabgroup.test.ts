/* Tests for the Workspace tab strip's grouping logic (Track 6).
 *
 * The Workspace.tsx component delegates the actual decisions to pure
 * helpers in ../lib/tab-grouping so we can verify them without a renderer.
 */
import { describe, it, expect } from 'vitest';
import { groupTabsByProject, isGroupExpanded, type TabLike, type ExpansionState } from '../lib/tab-grouping';

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
