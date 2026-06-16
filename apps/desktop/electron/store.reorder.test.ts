/* Drag-and-drop project reorder: persistence + ordering of the real Store.
   Only `app.getPath` is mocked — everything else is the production code path
   (createProject → reorderProjects → save → load → listProjects). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

// Point the Store's userData at a throwaway dir (unique per process, no RNG).
const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-reorder-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

const names = (s: Store) => s.listProjects().map(p => p.name);

describe('Store.reorderProjects', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('defaults to creation order, then honors a manual order that survives reload', () => {
    const s = new Store();
    const a = s.createProject({ name: 'Alpha' });
    const b = s.createProject({ name: 'Bravo' });
    const c = s.createProject({ name: 'Charlie' });
    expect(names(s)).toEqual(['Alpha', 'Bravo', 'Charlie']);

    s.reorderProjects([c.id, a.id, b.id]);
    expect(names(s)).toEqual(['Charlie', 'Alpha', 'Bravo']);

    // A fresh Store reading the same file on disk sees the persisted order.
    const reloaded = new Store();
    expect(names(reloaded)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('lands newly-created projects at the end of a hand-ordered list', () => {
    const s = new Store();
    const a = s.createProject({ name: 'Alpha' });
    const b = s.createProject({ name: 'Bravo' });
    s.reorderProjects([b.id, a.id]);
    s.createProject({ name: 'Delta' }); // no explicit order → falls back to createdAt
    expect(names(s)).toEqual(['Bravo', 'Alpha', 'Delta']);
  });

  it('ignores unknown ids and leaves listed projects ordered', () => {
    const s = new Store();
    const a = s.createProject({ name: 'Alpha' });
    const b = s.createProject({ name: 'Bravo' });
    s.reorderProjects([b.id, 'does-not-exist', a.id]);
    // 'does-not-exist' is skipped; b gets order 0, a gets order 2 → b before a.
    expect(names(s)).toEqual(['Bravo', 'Alpha']);
  });
});
