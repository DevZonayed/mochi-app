import { describe, test, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { resolveBaseBranch } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function tmp(): string { const d = makeTempDir(); cleanup.push(d); return d; }

describe('resolveBaseBranch', () => {
  test('falls back to the current branch when there is no origin/HEAD', () => {
    expect(resolveBaseBranch(repo())).toBe('main');
  });
});

// `tmp` is exercised by worktree tests added in later tasks.
void tmp;
