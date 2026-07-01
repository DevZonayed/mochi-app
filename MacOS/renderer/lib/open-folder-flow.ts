/* open-folder-flow — pure decision helper for "Open project from folder".

   Before #N, the sidebar "+" → AddProjectModal → "From folder" tab just
   shoved the chosen path into `createProject` and walked away — no GitHub
   detection, no memory-repo discovery, no offer to push/init. That broke
   the user's expectation that opening a folder behaves the same way as
   the rest of the GitHub-first flows (#62/#70).

   This module turns an `adoptFolderInspect` result into a small, render-
   ready `OpenFolderPlan`: which decision card to show, which buttons to
   render with which labels, and which action becomes the default-focused
   recommendation. The actual git/GitHub side effects live in the bootstrap
   helpers (`api.bootstrapProject`, `api.createProject`); this file is
   100% pure so the AddProjectModal stays a thin renderer over it. */

import type { FolderInspect, RepoInfo } from './api';

/** What the inspector resolved. Mirrors the `adoptFolderInspect` IPC
    return shape but narrowed to the fields the decision tree actually
    reads. Tests pass synthetic shapes; production calls api.adoptFolderInspect
    and feeds the result straight in. */
export interface OpenFolderInspection {
  ok: boolean;
  path: string;
  info?: RepoInfo;
  remote?: string | null;
  kind?: 'no-git' | 'git-no-remote' | 'git-github' | 'git-non-github';
  memoryRepo?:
    | { state: 'memory-found'; cloneUrl: string; slug: string; user: string }
    | { state: 'memory-missing'; slug: string; user: string }
    | { state: 'no-github-auth' }
    | { state: 'error'; error: string };
  error?: string;
}

/** One of four decisions the modal shows after picking a folder.
    `kind` drives the button row + headline; `recommended` is the default-
    focused button (the one the spec calls out per-case). */
export type OpenFolderPlan =
  /** Inspect failed (folder not found, etc.) — surface the error. */
  | { kind: 'error'; error: string }
  /** Folder has a github remote AND a companion memory repo — proceed
      silently (no extra prompt). The modal calls `proceed` immediately. */
  | {
      kind: 'silent-proceed';
      headline: string;
      proceed: { repoUrl: string; memorySlug: string; memoryRepoUrl: string };
    }
  /** GitHub remote present, no memory companion — offer "Create memory
      repo" or "Skip". */
  | {
      kind: 'github-no-memory';
      headline: string;
      repoUrl: string;
      memoryUser: string;
      memorySlug: string;
      /** Which button gets autofocus / Enter-key default. */
      recommended: 'create-memory' | 'skip';
    }
  /** Folder is a git repo but has NO remote — offer "Create GitHub repo +
      push" or "Skip — local-only". */
  | {
      kind: 'git-no-remote';
      headline: string;
      recommended: 'init-push' | 'skip';
    }
  /** Folder is NOT a git repo — offer "Init + push to GitHub" or
      "Skip — keep local". */
  | {
      kind: 'no-git';
      headline: string;
      recommended: 'init-push' | 'skip';
    };

/** Decide what the modal should show next based on the inspector result.
    Pure: no I/O, no side effects, no React. The caller (the modal) renders
    the returned plan and, on click, dispatches the matching action. */
export function planOpenFolder(inspect: OpenFolderInspection): OpenFolderPlan {
  if (!inspect.ok) {
    return { kind: 'error', error: inspect.error ?? 'Could not open that folder.' };
  }
  const folderName = inspect.path.split('/').filter(Boolean).pop() ?? 'this folder';

  // git-github: already a real GitHub-tracked repo. The memory companion's
  // state decides whether we silently proceed or offer to create one.
  if (inspect.kind === 'git-github') {
    const remoteUrl = inspect.remote ?? '';
    const repoLabel = friendlyRemote(remoteUrl) ?? folderName;
    const mem = inspect.memoryRepo;
    if (mem?.state === 'memory-found') {
      return {
        kind: 'silent-proceed',
        headline: `Found GitHub remote ${repoLabel} + memory repo ${mem.user}/${mem.slug}-memory — opening as-is`,
        proceed: {
          repoUrl: remoteUrl,
          memorySlug: mem.slug,
          memoryRepoUrl: `https://github.com/${mem.user}/${mem.slug}-memory`,
        },
      };
    }
    // memory-missing — we have GitHub auth + know what to create.
    if (mem?.state === 'memory-missing') {
      return {
        kind: 'github-no-memory',
        headline: `Found GitHub remote ${repoLabel} — no memory companion yet.`,
        repoUrl: remoteUrl,
        memoryUser: mem.user,
        memorySlug: mem.slug,
        recommended: 'create-memory',
      };
    }
    // no-github-auth / error — we know it's a github-tracked repo but
    // can't reach the API. Proceed silently with just the code remote;
    // the memory side waits for a GitHub sign-in later.
    return {
      kind: 'silent-proceed',
      headline: `Found GitHub remote ${repoLabel} — opening as-is`,
      proceed: { repoUrl: remoteUrl, memorySlug: '', memoryRepoUrl: '' },
    };
  }

  // git-non-github: a git repo with a non-GitHub remote (gitlab / self-
  // hosted / etc.). We DON'T push it anywhere — just record the path.
  // Same UX as silent-proceed but without a memory companion.
  if (inspect.kind === 'git-non-github') {
    return {
      kind: 'silent-proceed',
      headline: `Found existing remote — opening as-is`,
      proceed: { repoUrl: inspect.remote ?? '', memorySlug: '', memoryRepoUrl: '' },
    };
  }

  // git-no-remote: a real git repo but no origin remote. Offer to create
  // one on GitHub (recommended) or skip and keep it local.
  if (inspect.kind === 'git-no-remote') {
    return {
      kind: 'git-no-remote',
      headline: `Git repo found at ${folderName} — no GitHub remote yet.`,
      recommended: 'init-push',
    };
  }

  // no-git (default): not even a git repo. Offer to init+push, or skip.
  return {
    kind: 'no-git',
    headline: `${folderName} is not a git repo yet.`,
    recommended: 'init-push',
  };
}

/** Pull a friendly "owner/repo" label out of a github remote URL. Returns
    null when the URL doesn't parse cleanly (caller falls back to the
    folder name). Mirrors the format from #62's parser without adding a
    dependency on it here (so this file stays trivially testable). */
export function friendlyRemote(remote: string): string | null {
  // git@github.com:owner/repo(.git)
  const ssh = /git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // https://github.com/owner/repo(.git)
  const https = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/** Convenience for the modal: derive the project name from a folder path,
    matching the original `submitFromFolder` heuristic. Exported so the
    flow's tests can assert the same name shows up in createProject
    arguments. */
export function projectNameFromPath(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? 'Project';
}

/** Re-exported solely so the modal can pass `api.pickFolder()`'s result
    straight into `planOpenFolder` without an extra adapter layer. */
export type { FolderInspect };
