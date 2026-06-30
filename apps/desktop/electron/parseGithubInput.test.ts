import { describe, it, expect } from 'vitest';
import { parseGithubInput, githubHttpsUrl } from '../src/lib/parseGithubInput.js';

describe('parseGithubInput', () => {
  describe('owner/repo shorthand', () => {
    it('accepts plain owner/repo', () => {
      expect(parseGithubInput('facebook/react')).toEqual({ owner: 'facebook', repo: 'react' });
    });
    it('trims surrounding whitespace', () => {
      expect(parseGithubInput('   facebook/react  \n')).toEqual({ owner: 'facebook', repo: 'react' });
    });
    it('allows dots, dashes, underscores in segments', () => {
      expect(parseGithubInput('Some-Org_42.x/my.repo-name_v2')).toEqual({ owner: 'Some-Org_42.x', repo: 'my.repo-name_v2' });
    });
  });

  describe('HTTPS URL', () => {
    it('extracts owner/repo from a bare github.com URL', () => {
      expect(parseGithubInput('https://github.com/DevZonayed/mochi-app')).toEqual({ owner: 'DevZonayed', repo: 'mochi-app' });
    });
    it('strips a trailing .git', () => {
      expect(parseGithubInput('https://github.com/DevZonayed/mochi-app.git')).toEqual({ owner: 'DevZonayed', repo: 'mochi-app' });
    });
    it('ignores extra path segments (e.g. /pull/123)', () => {
      expect(parseGithubInput('https://github.com/DevZonayed/mochi-app/pull/123')).toEqual({ owner: 'DevZonayed', repo: 'mochi-app' });
    });
    it('ignores /tree/branch/sub/path tails', () => {
      expect(parseGithubInput('https://github.com/torvalds/linux/tree/master/kernel')).toEqual({ owner: 'torvalds', repo: 'linux' });
    });
    it('handles query strings + fragments', () => {
      expect(parseGithubInput('https://github.com/foo/bar?tab=readme#install')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('accepts http://', () => {
      expect(parseGithubInput('http://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('accepts scheme-less github.com URLs', () => {
      expect(parseGithubInput('github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('accepts www. prefix', () => {
      expect(parseGithubInput('https://www.github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
    });
  });

  describe('SSH URL', () => {
    it('accepts git@github.com:owner/repo.git', () => {
      expect(parseGithubInput('git@github.com:DevZonayed/mochi-app.git')).toEqual({ owner: 'DevZonayed', repo: 'mochi-app' });
    });
    it('accepts git@github.com:owner/repo (no .git)', () => {
      expect(parseGithubInput('git@github.com:foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('accepts ssh://git@github.com/owner/repo.git', () => {
      expect(parseGithubInput('ssh://git@github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
    });
  });

  describe('rejects', () => {
    it('rejects empty / whitespace', () => {
      expect(parseGithubInput('')).toBeNull();
      expect(parseGithubInput('   ')).toBeNull();
    });
    it('rejects a single token without a slash', () => {
      expect(parseGithubInput('react')).toBeNull();
    });
    it('rejects a triple-segment shorthand', () => {
      expect(parseGithubInput('a/b/c')).toBeNull();
    });
    it('rejects gibberish', () => {
      expect(parseGithubInput('lol what is this')).toBeNull();
      expect(parseGithubInput('!!!')).toBeNull();
    });
    it('rejects non-github.com URLs', () => {
      expect(parseGithubInput('https://gitlab.com/foo/bar')).toBeNull();
      expect(parseGithubInput('https://example.com/foo/bar')).toBeNull();
    });
    it('rejects owner-only github URLs', () => {
      expect(parseGithubInput('https://github.com/foo')).toBeNull();
      expect(parseGithubInput('https://github.com/')).toBeNull();
    });
    it('rejects segments with spaces', () => {
      expect(parseGithubInput('foo /bar')).toBeNull();
      expect(parseGithubInput('foo/ bar')).toBeNull();
    });
    it('rejects segments that are just dots', () => {
      expect(parseGithubInput('./.')).toBeNull();
      expect(parseGithubInput('../..')).toBeNull();
    });
    it('rejects non-string inputs', () => {
      // @ts-expect-error — intentional bad input
      expect(parseGithubInput(null)).toBeNull();
      // @ts-expect-error — intentional bad input
      expect(parseGithubInput(undefined)).toBeNull();
      // @ts-expect-error — intentional bad input
      expect(parseGithubInput(42)).toBeNull();
    });
  });
});

describe('githubHttpsUrl', () => {
  it('normalises to the canonical .git form', () => {
    expect(githubHttpsUrl({ owner: 'foo', repo: 'bar' })).toBe('https://github.com/foo/bar.git');
  });
});
