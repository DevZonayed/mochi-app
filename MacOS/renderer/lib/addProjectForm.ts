/* addProjectForm — pure helpers driving <AddProjectModal />. Extracted
   so the validation logic + the submit-arguments builder are unit-testable
   WITHOUT a DOM (vitest's electron config is node-only). */

import { parseGithubInput, githubHttpsUrl, type GithubRepoRef } from './parseGithubInput';

export type AddProjectTab = 'folder' | 'new' | 'clone';

/** What "Clone" needs to be enabled. Returned as a tri-state so the UI
    can render an inline hint + an enabled/disabled state from one source. */
export interface CloneValidation {
  ok: boolean;
  ref: GithubRepoRef | null;
  reason: string | null;
}

export function validateCloneInput(text: string, destPath: string | null): CloneValidation {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, ref: null, reason: null };  // empty: no error yet
  const ref = parseGithubInput(trimmed);
  if (!ref) return { ok: false, ref: null, reason: 'Enter owner/repo, a github.com URL, or a git@github.com SSH URL.' };
  if (!destPath) return { ok: false, ref, reason: 'Choose a local folder to clone into.' };
  return { ok: true, ref, reason: null };
}

/** What "New project (local)" needs to be enabled. */
export interface NewLocalValidation {
  ok: boolean;
  reason: string | null;
}

export function validateNewLocalInput(name: string, parentPath: string | null): NewLocalValidation {
  const n = name.trim();
  if (!n) return { ok: false, reason: null };
  if (!parentPath) return { ok: false, reason: 'Pick where the new project folder should live.' };
  if (!/^[A-Za-z0-9 ._-]+$/.test(n)) return { ok: false, reason: 'Project name can use letters, numbers, spaces, dots, dashes and underscores.' };
  return { ok: true, reason: null };
}

/** Build the cloneRepo IPC payload from a validated CloneValidation. The
    UI never has to know the URL shape — it just hands the parser-derived
    ref + destination off to the bridge. */
export function buildCloneArgs(ref: GithubRepoRef, destParent: string): {
  url: string; dest: string; dirName: string; name: string; color: string;
} {
  return {
    url: githubHttpsUrl(ref),
    dest: destParent,
    dirName: ref.repo,
    name: ref.repo,
    color: 'blue',
  };
}

/** Tab labels — single source of truth so the rendered tablist and the
    keyboard-shortcut hints stay aligned. */
export const TABS: { id: AddProjectTab; label: string; sub: string }[] = [
  { id: 'folder', label: 'From folder', sub: 'A local folder on this Mac' },
  { id: 'new',    label: 'New',         sub: 'Start an empty project' },
  { id: 'clone',  label: 'Clone',       sub: 'From a GitHub repository' },
];
