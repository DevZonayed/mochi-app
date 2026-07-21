/* Regression: the file-artifact reveal/open confinement must NOT regress the
   existing trusted `revealPath` contract. `revealPath` stays a TRUSTED reveal that
   performs the OS side effect and returns { ok: true } (no `path`). The NEW
   `resolveFilePath` is a pure resolver: it confines an artifact path to the
   project/session roots (or a trusted asset), returns { ok, path }, and performs NO
   OS action. Verified through the REAL localApi dispatch. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-reveal-test-${process.pid}` }));
const showItemInFolder = vi.fn();
const openPathSpy = vi.fn();
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' },
  shell: { showItemInFolder: (...a: unknown[]) => showItemInFolder(...a), openPath: (...a: unknown[]) => openPathSpy(...a) },
}));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import type { LocalEngine } from './engine.js';

function setup() {
  const s = new Store();
  const emit = vi.fn();
  const engine = {
    run: vi.fn(async () => ({})) as unknown as LocalEngine['run'],
    isRunning: vi.fn(() => false),
    cancel: vi.fn(() => false),
  } as unknown as LocalEngine;
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit, '', stub);
  return { s, dispatch };
}

describe('revealPath (trusted) + resolveFilePath (confined) are distinct contracts', () => {
  let proj = '';
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    showItemInFolder.mockClear();
    openPathSpy.mockClear();
    proj = mkdtempSync(path.join(os.tmpdir(), 'mochi-reveal-proj-'));
    mkdirSync(path.join(proj, 'renders'), { recursive: true });
    writeFileSync(path.join(proj, 'renders', 'final.mp4'), Buffer.from([0, 0, 0, 0x18]));
  });
  afterEach(() => { if (proj) rmSync(proj, { recursive: true, force: true }); });

  it('revealPath keeps the TRUSTED contract: performs the OS reveal and returns { ok:true } (no path)', async () => {
    const { dispatch } = setup();
    const f = path.join(proj, 'renders', 'final.mp4');
    const r = await dispatch('revealPath', { path: f }) as { ok?: boolean; path?: string };
    expect(r).toEqual({ ok: true });                 // NOT overloaded as a resolver — no `path`
    expect(showItemInFolder).toHaveBeenCalledWith(f); // real trusted side effect
  });

  it('revealPath 404s a missing path', async () => {
    const { dispatch } = setup();
    await expect(dispatch('revealPath', { path: path.join(proj, 'nope.txt') })).rejects.toThrow();
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('resolveFilePath CONFINES an artifact path to a canonical path with NO OS side effect', async () => {
    const { s, dispatch } = setup();
    const project = s.createProject({ name: 'P', path: proj });
    const r = await dispatch('resolveFilePath', { projectId: project.id, path: 'renders/final.mp4' }) as { ok?: boolean; path?: string };
    expect(r.ok).toBe(true);
    expect(r.path).toBe(realpathSync(path.join(proj, 'renders', 'final.mp4')));
    expect(showItemInFolder).not.toHaveBeenCalled(); // pure resolver — the native layer acts
    expect(openPathSpy).not.toHaveBeenCalled();
  });

  it('resolveFilePath rejects a traversal escape (never returns a path outside the roots)', async () => {
    const { s, dispatch } = setup();
    const project = s.createProject({ name: 'P', path: proj });
    await expect(dispatch('resolveFilePath', { projectId: project.id, path: '../../../../etc/hosts' })).rejects.toThrow();
    await expect(dispatch('resolveFilePath', { projectId: project.id, path: 'no/such/file.mp4' })).rejects.toThrow();
  });

  it('resolveFilePath surfaces AMBIGUITY (409) distinctly from missing (404)', async () => {
    mkdirSync(path.join(proj, 'a'), { recursive: true });
    mkdirSync(path.join(proj, 'b'), { recursive: true });
    writeFileSync(path.join(proj, 'a', 'dup.png'), 'x');
    writeFileSync(path.join(proj, 'b', 'dup.png'), 'y');
    const { s, dispatch } = setup();
    const project = s.createProject({ name: 'P', path: proj });
    // a bare 'dup.png' suffix matches two files → 409, not a generic 404
    await expect(dispatch('resolveFilePath', { projectId: project.id, path: 'dup.png' }))
      .rejects.toMatchObject({ statusCode: 409 });
    // a genuinely-missing path stays 404
    await expect(dispatch('resolveFilePath', { projectId: project.id, path: 'gone.png' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
