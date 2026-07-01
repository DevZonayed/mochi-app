/* Hide/unhide a project: a reversible soft-state flag persisted on the real
   Store. Only `app.getPath` is mocked — everything else is the production path
   (createProject → updateProject({ hidden }) → save → load → getProject). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

// Point the Store's userData at a throwaway dir (unique per process, no RNG).
const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-hide-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store.updateProject({ hidden })', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('defaults to visible (hidden undefined) on a fresh project', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Alpha' });
    expect(p.hidden).toBeUndefined();
  });

  it('hides a project, bumps updatedAt, and survives reload', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Alpha' });
    const before = p.updatedAt;

    const hidden = s.updateProject(p.id, { hidden: true });
    expect(hidden.hidden).toBe(true);
    expect(hidden.updatedAt).toBeGreaterThanOrEqual(before);

    // A fresh Store reading the same file on disk sees the persisted flag.
    const reloaded = new Store();
    expect(reloaded.getProject(p.id)?.hidden).toBe(true);
  });

  it('unhides a project back to visible', () => {
    const s = new Store();
    const p = s.createProject({ name: 'Alpha' });
    s.updateProject(p.id, { hidden: true });
    const shown = s.updateProject(p.id, { hidden: false });
    expect(shown.hidden).toBe(false);
    expect(s.getProject(p.id)?.hidden).toBe(false);
  });
});
