/* tab-grouping — pure helpers backing the Workspace tab strip.
 *
 * The actual rendering lives in Workspace.tsx; this module isolates the
 * decisions ("which tabs belong to the active project?") so they can be
 * exercised with plain unit tests, without spinning up a full renderer
 * environment. Keep this file free of React imports.
 *
 * Project-scoped tab model (the current shape):
 *   The Workspace shows ONE project's tabs at a time. `projectVisibleTabs`
 *   filters the global tab list to the active project; `lastTabForProject`
 *   resolves the tab to re-activate when the operator switches projects.
 *
 * The legacy multi-project helpers (groupTabsByProject / isGroupExpanded /
 * prunePinnedGroups) are kept here because they are still pure and tested,
 * and we may want them back if we re-introduce cross-project tab strips
 * (e.g. a "All open chats" overflow). They are not used by the renderer
 * today — see Workspace.tsx for the project-scoped rendering.
 */

export interface TabLike {
  /** Unique tab key. */
  key: string;
  /** Owning project. The tab strip groups tabs that share this id. */
  projectId: string;
}

export interface TabGroup<T extends TabLike> {
  projectId: string;
  tabs: T[];
}

/**
 * Group tabs by `projectId`, preserving the order in which each project
 * first appeared. Within a group, tabs keep their input order.
 *
 * Equivalent to `Object.groupBy(tabs, t => t.projectId)` but ES2022-safe
 * and order-stable (Object.groupBy returns a plain object whose key order
 * is not guaranteed for numeric-looking keys).
 */
export function groupTabsByProject<T extends TabLike>(tabs: readonly T[]): TabGroup<T>[] {
  const order: string[] = [];
  const buckets: Record<string, T[]> = {};
  for (const t of tabs) {
    if (!buckets[t.projectId]) { buckets[t.projectId] = []; order.push(t.projectId); }
    buckets[t.projectId].push(t);
  }
  return order.map(pid => ({ projectId: pid, tabs: buckets[pid] }));
}

export interface ExpansionState {
  /** The currently active project (derived from the active tab's projectId). */
  activeProjectId: string | null;
  /** Projects the user has pinned open. */
  pinnedGroups: ReadonlySet<string>;
  /** A non-pinned project the user clicked open ("peek"). At most one. */
  peekGroup: string | null;
  /** How many groups exist right now. With ≤1 we never collapse. */
  groupCount: number;
}

/** Decide whether a project's tab group renders full-width or collapsed-to-avatar. */
export function isGroupExpanded(projectId: string, s: ExpansionState): boolean {
  if (s.groupCount <= 1) return true;
  if (projectId === s.activeProjectId) return true;
  if (s.pinnedGroups.has(projectId)) return true;
  if (s.peekGroup === projectId) return true;
  return false;
}

/** Drop pin ids whose project no longer has any open tab. Pure. */
export function prunePinnedGroups<T extends TabLike>(pinned: ReadonlySet<string>, groups: readonly TabGroup<T>[]): Set<string> {
  const live = new Set(groups.map(g => g.projectId));
  const next = new Set<string>();
  for (const id of pinned) if (live.has(id)) next.add(id);
  return next;
}

/* ── Project-scoped helpers (used by the live renderer) ────────────────── */

/** Return the subset of `tabs` that belong to `projectId`, preserving the
 *  input order. When `projectId` is null, returns an empty array (the strip
 *  has no project context yet — render nothing).
 *
 *  This is what powers the "tabs are project-specific" rule: the Workspace
 *  passes the global tab list + the active projectId, and the strip renders
 *  only the matches. */
export function projectVisibleTabs<T extends TabLike>(tabs: readonly T[], projectId: string | null): T[] {
  if (!projectId) return [];
  return tabs.filter(t => t.projectId === projectId);
}

/** When the operator switches to `projectId`, resolve the tab to re-activate:
 *    1. Prefer the project's last-known active tab (if it's still open).
 *    2. Otherwise fall back to the first open tab in the project.
 *    3. If the project has no open tabs, return null (strip stays empty).
 *
 *  Persisted per-project memory keeps the right tab focused when the user
 *  flips between projects, instead of always jumping to the first one. */
export function lastTabForProject<T extends TabLike>(
  tabs: readonly T[],
  projectId: string,
  lastByProject: Readonly<Record<string, string>>,
): T | null {
  const projTabs = tabs.filter(t => t.projectId === projectId);
  if (!projTabs.length) return null;
  const candidate = lastByProject[projectId];
  if (candidate) {
    const hit = projTabs.find(t => t.key === candidate);
    if (hit) return hit;
  }
  return projTabs[0];
}
