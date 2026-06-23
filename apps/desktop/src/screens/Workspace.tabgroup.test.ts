/* Tests for the Workspace tab strip's grouping logic (Track 6).
 *
 * The Workspace.tsx component delegates the actual decisions to pure
 * helpers in ../lib/tab-grouping so we can verify them without a renderer.
 */
import { describe, it, expect } from 'vitest';
import { groupTabsByProject, type TabLike } from '../lib/tab-grouping';

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

// Closing-the-only-tab UX invariant: when the last tab of the active project
// closes, the remaining tab in another project becomes active and (since
// there's only one group left) renders full-width by the groupCount<=1 rule.
// The collapse logic for that lives in commit 2 — see the larger collapse
// test in this file once that lands.
describe('after closing the last tab of a project', () => {
  it('the remaining single group renders alone, in order', () => {
    const before = groupTabsByProject([tab('a1', 'A'), tab('b1', 'B'), tab('b2', 'B')]);
    expect(before.map(g => g.projectId)).toEqual(['A', 'B']);
    const after = groupTabsByProject([tab('b1', 'B'), tab('b2', 'B')]);
    expect(after.map(g => g.projectId)).toEqual(['B']);
    expect(after[0].tabs).toHaveLength(2);
  });
});
