/* open-folder-flow.test — the decision tree that turns an `adoptFolderInspect`
   result into the in-modal step shown after "From folder" → Pick folder.
   The flow used to be hard-coded: every pick just dropped into createProject
   without GitHub detection. Bug 1 fixes that by branching on inspector kind. */

import { describe, it, expect } from 'vitest';
import {
  planOpenFolder, friendlyRemote, projectNameFromPath,
  type OpenFolderInspection,
} from '../src/lib/open-folder-flow.js';

const baseInspect = (over: Partial<OpenFolderInspection>): OpenFolderInspection => ({
  ok: true, path: '/Users/me/code/my-project', ...over,
});

describe('planOpenFolder', () => {
  it('surfaces an `error` plan when the inspector failed', () => {
    const plan = planOpenFolder({ ok: false, path: '/missing', error: 'Folder not found.' });
    expect(plan).toEqual({ kind: 'error', error: 'Folder not found.' });
  });

  it('silently proceeds when the folder has a GitHub remote AND memory companion', () => {
    const plan = planOpenFolder(baseInspect({
      info: { branch: 'main', remote: 'https://github.com/DevZonayed/my-project.git', isRepo: true },
      remote: 'https://github.com/DevZonayed/my-project.git',
      kind: 'git-github',
      memoryRepo: { state: 'memory-found', cloneUrl: 'https://github.com/me/my-project-memory.git', slug: 'my-project', user: 'me' },
    }));
    expect(plan.kind).toBe('silent-proceed');
    if (plan.kind !== 'silent-proceed') return;
    expect(plan.headline).toMatch(/DevZonayed\/my-project/);
    expect(plan.headline).toMatch(/me\/my-project-memory/);
    expect(plan.proceed).toEqual({
      repoUrl: 'https://github.com/DevZonayed/my-project.git',
      memorySlug: 'my-project',
      memoryRepoUrl: 'https://github.com/me/my-project-memory',
    });
  });

  it('offers Create-memory-repo when github remote exists but companion is missing', () => {
    const plan = planOpenFolder(baseInspect({
      remote: 'git@github.com:org/repo.git',
      kind: 'git-github',
      memoryRepo: { state: 'memory-missing', slug: 'repo', user: 'me' },
    }));
    expect(plan.kind).toBe('github-no-memory');
    if (plan.kind !== 'github-no-memory') return;
    expect(plan.recommended).toBe('create-memory');
    expect(plan.repoUrl).toBe('git@github.com:org/repo.git');
    expect(plan.memorySlug).toBe('repo');
    expect(plan.memoryUser).toBe('me');
    expect(plan.headline).toMatch(/org\/repo/);
  });

  it('offers Create-GitHub-repo+push when the folder is a git repo with no remote', () => {
    const plan = planOpenFolder(baseInspect({
      info: { branch: 'main', remote: null, isRepo: true },
      kind: 'git-no-remote',
    }));
    expect(plan.kind).toBe('git-no-remote');
    if (plan.kind !== 'git-no-remote') return;
    expect(plan.recommended).toBe('init-push');
    expect(plan.headline).toMatch(/my-project/);
    expect(plan.headline).toMatch(/no GitHub remote/i);
  });

  it('offers Init+push when the folder is not a git repo', () => {
    const plan = planOpenFolder(baseInspect({
      info: { branch: null, remote: null, isRepo: false },
      kind: 'no-git',
    }));
    expect(plan.kind).toBe('no-git');
    if (plan.kind !== 'no-git') return;
    expect(plan.recommended).toBe('init-push');
    expect(plan.headline).toMatch(/not a git repo/i);
  });

  it('silently proceeds on a non-GitHub git repo (gitlab/self-hosted) — no push offered', () => {
    const plan = planOpenFolder(baseInspect({
      info: { branch: 'main', remote: 'git@gitlab.com:org/repo.git', isRepo: true },
      remote: 'git@gitlab.com:org/repo.git',
      kind: 'git-non-github',
    }));
    expect(plan.kind).toBe('silent-proceed');
    if (plan.kind !== 'silent-proceed') return;
    expect(plan.proceed.repoUrl).toBe('git@gitlab.com:org/repo.git');
    expect(plan.proceed.memorySlug).toBe('');
  });

  it('falls back to silent-proceed when github remote exists but auth is missing', () => {
    const plan = planOpenFolder(baseInspect({
      remote: 'https://github.com/foo/bar.git',
      kind: 'git-github',
      memoryRepo: { state: 'no-github-auth' },
    }));
    expect(plan.kind).toBe('silent-proceed');
    if (plan.kind !== 'silent-proceed') return;
    // No memory linkage offered when we can't see the API — opens as-is.
    expect(plan.proceed.memorySlug).toBe('');
    expect(plan.proceed.repoUrl).toBe('https://github.com/foo/bar.git');
  });
});

describe('friendlyRemote', () => {
  it('parses https github remotes (with .git suffix)', () => {
    expect(friendlyRemote('https://github.com/foo/bar.git')).toBe('foo/bar');
  });
  it('parses https github remotes (without .git)', () => {
    expect(friendlyRemote('https://github.com/foo/bar')).toBe('foo/bar');
  });
  it('parses git@github.com SSH remotes', () => {
    expect(friendlyRemote('git@github.com:org/repo.git')).toBe('org/repo');
  });
  it('returns null for non-github remotes', () => {
    expect(friendlyRemote('git@gitlab.com:org/repo.git')).toBeNull();
    expect(friendlyRemote('')).toBeNull();
  });
});

describe('projectNameFromPath', () => {
  it('takes the trailing path segment', () => {
    expect(projectNameFromPath('/Users/me/code/my-project')).toBe('my-project');
  });
  it('handles trailing slash', () => {
    expect(projectNameFromPath('/Users/me/code/my-project/')).toBe('my-project');
  });
  it('falls back to "Project" for an empty path', () => {
    expect(projectNameFromPath('')).toBe('Project');
    expect(projectNameFromPath('/')).toBe('Project');
  });
});
