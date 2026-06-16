import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A temp git repo with one commit on `main`. Caller is responsible for cleanup. */
export function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** An empty temp dir. */
export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mst-'));
}
