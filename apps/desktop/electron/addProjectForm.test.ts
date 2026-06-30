/* addProjectForm.test — the modal's pure logic. Lives in electron/ so it
   auto-runs in the standing vitest suite. We test the validators (what the
   tabs use to gate their submit buttons + surface inline errors) and the
   IPC payload builder (what the renderer hands to api.cloneRepo). */

import { describe, it, expect } from 'vitest';
import {
  validateCloneInput,
  validateNewLocalInput,
  buildCloneArgs,
  TABS,
} from '../src/lib/addProjectForm.js';

describe('validateCloneInput', () => {
  it('is "empty, no error" when nothing has been typed', () => {
    expect(validateCloneInput('', null)).toEqual({ ok: false, ref: null, reason: null });
    expect(validateCloneInput('   ', null)).toEqual({ ok: false, ref: null, reason: null });
  });
  it('surfaces a friendly hint for unparseable input', () => {
    const r = validateCloneInput('not a repo', null);
    expect(r.ok).toBe(false);
    expect(r.ref).toBeNull();
    expect(r.reason).toMatch(/owner\/repo/);
  });
  it('parses a recognisable ref but blocks until a destination is picked', () => {
    const r = validateCloneInput('foo/bar', null);
    expect(r.ok).toBe(false);
    expect(r.ref).toEqual({ owner: 'foo', repo: 'bar' });
    expect(r.reason).toMatch(/local folder/i);
  });
  it('is ok when ref + destination are both present', () => {
    const r = validateCloneInput('https://github.com/foo/bar', '/tmp/dest');
    expect(r).toEqual({ ok: true, ref: { owner: 'foo', repo: 'bar' }, reason: null });
  });
});

describe('validateNewLocalInput', () => {
  it('is "empty, no error" when no name typed', () => {
    expect(validateNewLocalInput('', null)).toEqual({ ok: false, reason: null });
    expect(validateNewLocalInput('  ', null)).toEqual({ ok: false, reason: null });
  });
  it('blocks until a parent folder is picked', () => {
    expect(validateNewLocalInput('my-project', null)).toEqual({ ok: false, reason: expect.stringMatching(/Pick where/i) });
  });
  it('rejects names with invalid characters', () => {
    const r = validateNewLocalInput('my/project', '/Users/me/code');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/letters/);
  });
  it('accepts a clean name with a parent folder', () => {
    expect(validateNewLocalInput('My Project_v2.1', '/Users/me/code')).toEqual({ ok: true, reason: null });
  });
});

describe('buildCloneArgs', () => {
  it('hands the renderer-side ref off as a complete cloneRepo payload', () => {
    expect(buildCloneArgs({ owner: 'DevZonayed', repo: 'mochi-app' }, '/Users/me/code')).toEqual({
      url: 'https://github.com/DevZonayed/mochi-app.git',
      dest: '/Users/me/code',
      dirName: 'mochi-app',
      name: 'mochi-app',
      color: 'blue',
    });
  });
});

describe('TABS', () => {
  it('has exactly three tabs in the documented order', () => {
    expect(TABS.map(t => t.id)).toEqual(['folder', 'new', 'clone']);
  });
  it('each tab has a non-empty label + sub-label for the tablist', () => {
    for (const t of TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.sub.length).toBeGreaterThan(0);
    }
  });
});
