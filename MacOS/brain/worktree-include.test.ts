import { describe, test, expect } from 'vitest';
import { DEFAULT_COPY_GLOBS, parseWorktreeInclude, resolveCopyGlobs } from './worktree-include.js';

describe('parseWorktreeInclude', () => {
  test('keeps glob lines, drops blanks and # comments', () => {
    const text = '# files to copy into each worktree\n.env*\n\n  config/*.local.json  \n# trailing comment\n';
    expect(parseWorktreeInclude(text)).toEqual(['.env*', 'config/*.local.json']);
  });
  test('returns [] for empty / comment-only text', () => {
    expect(parseWorktreeInclude('\n  \n# only comments\n')).toEqual([]);
  });
});

describe('resolveCopyGlobs', () => {
  test('1. a non-empty .worktreeinclude wins over project globs', () => {
    expect(resolveCopyGlobs({ worktreeIncludeText: '.env\nsecrets/*.pem\n', projectGlobs: ['.env*'] }))
      .toEqual(['.env', 'secrets/*.pem']);
  });
  test('2. falls back to project globs when no .worktreeinclude file', () => {
    expect(resolveCopyGlobs({ worktreeIncludeText: null, projectGlobs: ['.env*', 'foo'] }))
      .toEqual(['.env*', 'foo']);
  });
  test('2b. an empty/comment-only .worktreeinclude falls through to project globs', () => {
    expect(resolveCopyGlobs({ worktreeIncludeText: '# nothing\n', projectGlobs: ['.env.local'] }))
      .toEqual(['.env.local']);
  });
  test('3. defaults to .env* when neither is set', () => {
    expect(resolveCopyGlobs({ worktreeIncludeText: null, projectGlobs: undefined })).toEqual(DEFAULT_COPY_GLOBS);
    expect(resolveCopyGlobs({ worktreeIncludeText: null, projectGlobs: [] })).toEqual(DEFAULT_COPY_GLOBS);
  });
});
