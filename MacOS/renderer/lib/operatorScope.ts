/* operatorScope — pure helpers that keep the Agent (operator) view scoped to
   the CONTEXT genre. Extracted from Workspace.tsx so the logic is
   unit-testable without a DOM (vitest runs node-only).

   Why this exists at all: /workspace and /operator render the SAME Workspace
   component type, so React RE-USES the mounted instance when the top-nav
   switches between them — state initialized "once for operator mode" (a
   useState initializer) silently keeps CodeSpace's values and leaks every
   coding project into the Agent view. The rule that fixes it: operator scope
   must be DERIVED on every render / re-checked in an effect, never captured
   at mount. These helpers are that derivation. */

/** Structural project shape — mirrors lib/api's Project without importing it,
    so this module (and its tests) stay free of renderer globals. */
export interface ProjectScopeLike {
  id: string;
  kind?: string;
  hidden?: boolean;
}

/** A project's effective genre: projects created before `kind` existed count
    as 'general' (same default Workspace.tsx applies). */
export const scopeKind = (p?: ProjectScopeLike): string => p?.kind ?? 'general';

export const isContextProject = (p?: ProjectScopeLike): boolean => scopeKind(p) === 'context';

/** What the operator-mode effect should do with the active project when the
    Agent view (re)takes the mounted Workspace instance. */
export type OperatorScopeAction =
  | { type: 'keep' }                    // active project is already a context project
  | { type: 'switch'; pid: string }     // re-aim at this context project
  | { type: 'clear' }                   // no context project exists; drop the leaked active project
  | { type: 'none' };                   // nothing active, nothing to aim at — stay empty

/** Decide how to (re)scope the active project for the Agent view.
    Preference order for `switch`: first VISIBLE context project, then any
    (hidden) context project — matching the rail's default rendering. */
export function resolveOperatorScope(
  projects: readonly ProjectScopeLike[],
  activeProjectId: string | null,
): OperatorScopeAction {
  const cur = activeProjectId ? projects.find(p => p.id === activeProjectId) : undefined;
  if (cur && isContextProject(cur)) return { type: 'keep' };
  const first = projects.find(p => isContextProject(p) && !p.hidden) ?? projects.find(isContextProject);
  if (first) return { type: 'switch', pid: first.id };
  return activeProjectId ? { type: 'clear' } : { type: 'none' };
}

/** Which project the tab-strip "+" (new chat) should target. In operator mode
    the fallback is restricted to context projects — a coding chat must never
    open inside the Agent view. Returns null when there is no legal target
    (callers open the add-project modal instead). */
export function newChatTargetProject(
  operator: boolean,
  activeProjectId: string | null,
  projects: readonly ProjectScopeLike[],
): string | null {
  if (activeProjectId) return activeProjectId;
  if (operator) return projects.find(isContextProject)?.id ?? null;
  return projects[0]?.id ?? null;
}
