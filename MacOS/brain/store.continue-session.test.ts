/* Track 7 "Continue from here": store.createSession now accepts opts that
   carry the baseBranch + continuedFrom provenance. The actual dispatcher
   (localApi 'continueSession') boils down to picking a codename, derived
   title, and calling this method with those opts — so verifying the store
   contract is sufficient + cheap (no Electron / IPC layer in the test). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-continue-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store.createSession — continuation opts (Track 7)', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('records continuedFrom + baseBranch when opts are passed', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'Repo' });
    const prev = s.createSession(proj.id, 'Refactor auth flow', 'lyon');
    const next = s.createSession(proj.id, 'Refactor auth flow (continued)', 'porto', {
      baseBranch: 'main',
      continuedFrom: { sessionId: prev.id, title: prev.title, prNumber: 42, mergedAt: 1700000000000, baseRefName: 'main' },
    });
    expect(next.baseBranch).toBe('main');
    expect(next.continuedFrom).toEqual({
      sessionId: prev.id,
      title: 'Refactor auth flow',
      prNumber: 42,
      mergedAt: 1700000000000,
      baseRefName: 'main',
    });
    // sanity: previous session is unchanged
    const reloaded = s.getSession(prev.id);
    expect(reloaded?.continuedFrom).toBeUndefined();
  });

  it('omits continuedFrom + baseBranch when opts are absent (back-compat)', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'Repo' });
    const sess = s.createSession(proj.id, 'Brand new', 'lyon');
    expect(sess.continuedFrom).toBeUndefined();
    expect(sess.baseBranch).toBeUndefined();
  });

  it('persists continuedFrom across a Store reload', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'Repo' });
    const prev = s.createSession(proj.id, 'Prev');
    s.createSession(proj.id, 'Next', undefined, {
      baseBranch: 'develop',
      continuedFrom: { sessionId: prev.id, title: 'Prev', baseRefName: 'develop' },
    });

    const reloaded = new Store();
    const sessions = reloaded.listSessions(proj.id);
    const next = sessions.find(x => x.title === 'Next');
    expect(next?.baseBranch).toBe('develop');
    expect(next?.continuedFrom?.sessionId).toBe(prev.id);
    expect(next?.continuedFrom?.baseRefName).toBe('develop');
  });
});
