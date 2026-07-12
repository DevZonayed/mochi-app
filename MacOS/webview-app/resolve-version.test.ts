// Regression tests for the release-version resolver (resolve-version.sh).
//
// package-app.sh used to default VERSION to a stale literal (0.1.28), so a normal
// `./package-app.sh release` (README omits MAESTRO_VERSION) could silently bake an
// OLD version into the bundle. The resolver now derives it. These tests pin the
// precedence and every fallback WITHOUT running a full app build — they drive the
// tiny shell script directly against throwaway git repos.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./resolve-version.sh', import.meta.url));

/** Run the resolver against `dir` by executing the script DIRECTLY (via its
    shebang), not `bash SCRIPT` — this validates the executable/shebang contract
    that package-app.sh + the documented direct-usage rely on. MAESTRO_VERSION
    defaults to empty ("unset"). */
function resolve(dir: string, maestroVersion = ''): string {
  const res = spawnSync(SCRIPT, [dir], {
    encoding: 'utf8',
    env: { ...process.env, MAESTRO_VERSION: maestroVersion },
  });
  if (res.error) throw res.error; // e.g. EACCES if the exec bit were stripped
  if (res.status !== 0) throw new Error(`resolver exited ${res.status}: ${res.stderr}`);
  return res.stdout.trim();
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
function git(dir: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}
function commit(dir: string, msg: string): void {
  git(dir, 'commit', '--allow-empty', '-q', '-m', msg);
}

describe('resolve-version.sh', () => {
  let tmp = '';
  beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'mochi-ver-resolve-')); });
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

  const initRepo = (dir: string) => { git(dir, 'init', '-q'); commit(dir, 'root'); };

  it('is executable (owner exec bit set) so its shebang runs directly', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('explicit non-empty MAESTRO_VERSION wins over a matching tag', () => {
    initRepo(tmp);
    git(tmp, 'tag', 'mochlet-v0.1.40');
    expect(resolve(tmp, '9.9.9')).toBe('9.9.9');
  });

  it('empty MAESTRO_VERSION is treated as unset and falls through to the tag', () => {
    initRepo(tmp);
    git(tmp, 'tag', 'mochlet-v0.1.51');
    expect(resolve(tmp, '')).toBe('0.1.51');
  });

  it('derives from the nearest reachable mochlet-v* tag and strips the prefix', () => {
    initRepo(tmp);
    git(tmp, 'tag', 'mochlet-v0.1.49');
    commit(tmp, 'second');
    git(tmp, 'tag', 'mochlet-v0.1.51'); // on HEAD → the nearest reachable
    expect(resolve(tmp)).toBe('0.1.51');
  });

  it('ignores non-matching tags (e.g. legacy v* release tags)', () => {
    initRepo(tmp);
    git(tmp, 'tag', 'v0.1.28');   // legacy scheme — must NOT be chosen
    git(tmp, 'tag', 'v2.0.0');
    expect(resolve(tmp)).toBe('0.0.0-dev');
  });

  it('falls back to 0.0.0-dev when a repo has commits but no mochlet-v* tag', () => {
    initRepo(tmp);
    expect(resolve(tmp)).toBe('0.0.0-dev');
  });

  it('falls back to 0.0.0-dev in a source archive (no git metadata)', () => {
    // Plain directory, never `git init`ed — simulates a tarball/zip export.
    expect(resolve(tmp)).toBe('0.0.0-dev');
    // ...and even there, an explicit version still wins.
    expect(resolve(tmp, '1.2.3')).toBe('1.2.3');
  });
});
