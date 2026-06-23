/* createSession({ base }) — pinning the worktree base branch at chat-create
   time. The engine reads `session.baseBranch` later and forwards it into
   `ensureSessionWorktree`, so this is the data-layer contract that backs
   the new <BranchPicker /> popover. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-session-base-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store.createSession — opts.base', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('omitting opts keeps the legacy zero-arg behavior (no baseBranch set)', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Repo' });
    const sess = s.createSession(p.id, 'first');                         // no codename, no opts
    expect(sess.baseBranch).toBeUndefined();
    const sess2 = s.createSession(p.id, 'second', 'lyon');               // codename only — still legacy
    expect(sess2.baseBranch).toBeUndefined();
  });

  it('pins baseBranch when opts.base is given', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Repo' });
    const sess = s.createSession(p.id, 'pick a branch', 'lyon', { base: 'feat/login' });
    expect(sess.baseBranch).toBe('feat/login');
  });

  it('trims base and ignores empty/whitespace-only values', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Repo' });
    const trimmed = s.createSession(p.id, 't', undefined, { base: '  develop  ' });
    expect(trimmed.baseBranch).toBe('develop');
    const empty = s.createSession(p.id, 'e', undefined, { base: '   ' });
    expect(empty.baseBranch).toBeUndefined();
  });

  it('persists baseBranch across a Store reload', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Repo' });
    const sess = s.createSession(p.id, 'persist', 'porto', { base: 'release/2026.04' });

    const reloaded = new Store();
    expect(reloaded.getSession(sess.id)?.baseBranch).toBe('release/2026.04');
  });
});
