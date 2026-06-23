/* AiConflictResolveDialog — pure unit tests for the contract the agent reads.
   The renderer monorepo doesn't ship @testing-library/react (verified at the
   time of writing), so we cover the load-bearing logic without rendering:

     buildConflictResolutionPrompt — the prefixed system context that drops
     into api.sendChat. It IS the agent's instruction surface; lock its
     shape (header phrase + tool callout + per-file blocks) here so a future
     refactor can't silently re-word the prompt and break the agent loop.

   The render + sendChat-dispatch path is covered by the live smoke test
   noted in the PR description (the dialog is small and the renderer's other
   dialogs follow the same proven shape). */

import { describe, test, expect } from 'vitest';
import { buildConflictResolutionPrompt } from './AiConflictResolveDialog';
import type { ConflictFile } from '../lib/git-types';

const sample: ConflictFile[] = [
  {
    path: 'src/router.ts',
    hunks: [
      {
        startLine: 12, endLine: 18,
        oursLabel: 'HEAD', theirsLabel: 'origin/master',
        ours:   ['router.get("/v2/foo", v2Foo);'],
        theirs: ['router.get("/v3/foo", v3Foo);'],
      },
    ],
  },
  {
    path: 'db/migrate.sql',
    hunks: [
      {
        startLine: 1, endLine: 7,
        oursLabel: 'HEAD', theirsLabel: 'origin/master',
        ours:   ['ALTER TABLE users ADD COLUMN nickname TEXT;'],
        theirs: ['ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT \'\';'],
      },
    ],
  },
];

describe('buildConflictResolutionPrompt', () => {
  test('starts with the [Conflict resolution mode] header', () => {
    const p = buildConflictResolutionPrompt({ prTitle: 'Test PR', branch: 'feat/x', files: sample, instructions: '' });
    expect(p.startsWith('[Conflict resolution mode]')).toBe(true);
  });

  test('lists every file with its hunk count in the header', () => {
    const p = buildConflictResolutionPrompt({ prTitle: 'Test PR', branch: 'feat/x', files: sample, instructions: '' });
    expect(p).toContain('• src/router.ts (1 hunk)');
    expect(p).toContain('• db/migrate.sql (1 hunk)');
  });

  test('quotes the operator instructions verbatim when provided', () => {
    const p = buildConflictResolutionPrompt({
      prTitle: null, branch: 'feat/x', files: sample,
      instructions: 'prefer the branch version for routing changes',
    });
    expect(p).toContain('"prefer the branch version for routing changes"');
  });

  test('says "did not provide additional instructions" when the textarea is empty', () => {
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: 'feat/x', files: sample, instructions: '   ' });
    expect(p).toContain('did not provide additional instructions');
  });

  test('mentions the pr_resolve_conflicts callout so the agent knows the exit', () => {
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: null, files: sample, instructions: '' });
    expect(p).toContain('pr_resolve_conflicts');
  });

  test('includes the conflict markers inline so the agent has a preview', () => {
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: null, files: sample, instructions: '' });
    expect(p).toContain('<<<<<<< HEAD');
    expect(p).toContain('=======');
    expect(p).toContain('>>>>>>> origin/master');
    expect(p).toContain('router.get("/v2/foo"');
    expect(p).toContain('router.get("/v3/foo"');
  });

  test('flags unreadable files instead of silently dropping them', () => {
    const files: ConflictFile[] = [{ path: 'bin/blob', hunks: [], unreadable: true }];
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: null, files, instructions: '' });
    expect(p).toContain('bin/blob');
    expect(p).toContain('unreadable');
  });

  test('handles an empty file list without crashing (defensive)', () => {
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: null, files: [], instructions: '' });
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
    // Falls back to a placeholder bullet rather than emitting an empty section.
    expect(p).toContain('(none');
  });

  test('emits diff3 base section when present', () => {
    const files: ConflictFile[] = [{
      path: 'a.txt',
      hunks: [{
        startLine: 1, endLine: 7, oursLabel: 'HEAD', theirsLabel: 'feat',
        ours: ['X'], base: ['Y'], theirs: ['Z'],
      }],
    }];
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: null, files, instructions: '' });
    expect(p).toContain('||||||| base');
    expect(p).toContain('Y');
  });

  test('truncates a very large `ours`/`theirs` payload (>60 lines) with a marker', () => {
    const huge = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    const files: ConflictFile[] = [{
      path: 'big.txt',
      hunks: [{
        startLine: 1, endLine: 250, oursLabel: 'HEAD', theirsLabel: 'feat',
        ours: huge, theirs: ['t'],
      }],
    }];
    const p = buildConflictResolutionPrompt({ prTitle: null, branch: null, files, instructions: '' });
    expect(p).toMatch(/\(\d+ more lines, truncated\)/);
  });
});
