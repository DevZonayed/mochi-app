/* Session rename: the data layer behind the desktop "rename chat" UI
   (pencil button + double-click in the rails/tabs). Mirrors the reorder
   test's setup — only `app.getPath` is mocked; everything else exercises
   the production Store + JSON persistence. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-session-rename-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store.updateSession — rename', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('updates the title and bumps updatedAt', async () => {
    const s = new Store();
    const proj = s.createProject({ name: 'Repo' });
    const sess = s.createSession(proj.id, 'Untitled');
    const t0 = sess.updatedAt;
    // small wait so updatedAt can advance even on fast clocks
    await new Promise(r => setTimeout(r, 5));
    const renamed = s.updateSession(sess.id, { title: 'Refactor auth flow' });
    expect(renamed.title).toBe('Refactor auth flow');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(t0);
  });

  it('persists the new title across a Store reload', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'Repo' });
    const sess = s.createSession(proj.id, 'Old');
    s.updateSession(sess.id, { title: 'New' });

    const reloaded = new Store();
    const got = reloaded.getSession(sess.id);
    expect(got?.title).toBe('New');
  });

  it('throws (404) when the session id is unknown', () => {
    const s = new Store();
    expect(() => s.updateSession('nope', { title: 'x' })).toThrow(/not found/);
  });

  it('createSession trims + caps title at 60 chars (matches rename cap in localApi)', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'Repo' });
    const long = 'a'.repeat(80);
    const sess = s.createSession(proj.id, `   ${long}   `);
    expect(sess.title.length).toBe(60);
    expect(sess.title.startsWith('a')).toBe(true);
  });
});
