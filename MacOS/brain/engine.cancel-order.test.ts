/**
 * LOW-fix reviewer reproduction: `LocalEngine.cancel` must persist the durable `cancelled`
 * status BEFORE the external abort/kill, the external kill fires AT MOST once, a duplicate
 * cancel does not revive or re-kill, a kill failure still leaves a durable cancelled, and a
 * runner completing after cancel cannot overwrite the cancelled status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} }, clipboard: {}, nativeImage: {}, shell: {} }));

import { Store } from './store.js';
import { LocalEngine, type RunHandle } from './engine.js';

type EnginePriv = { running: Map<string, RunHandle> };

describe('LocalEngine.cancel — durable-first order', () => {
  let dir: string; let store: Store; let engine: LocalEngine;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cx-')); hoisted.dir = dir; store = new Store(); engine = new LocalEngine(store, () => {}); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function runningJob(): string {
    const p = store.createProject({ name: 'C' });
    const s = store.createSession(p.id, 'chat');
    const j = store.createJob(p.id, 'go', 'J', 'balanced', s.id); store.updateJob(j.id, { status: 'running' });
    return j.id;
  }

  it('persists cancelled BEFORE the external kill; kill fires exactly once', () => {
    const jobId = runningJob();
    let statusAtKill = ''; let killCount = 0; let aborted = false;
    const ac = new AbortController(); ac.signal.addEventListener('abort', () => { aborted = true; });
    const child = { kill: () => { statusAtKill = store.getJob(jobId)!.status; killCount++; } } as unknown as RunHandle['child'];
    (engine as unknown as EnginePriv).running.set(jobId, { ac, child });

    const out = engine.cancel(jobId);
    expect(out?.status).toBe('cancelled');
    expect(statusAtKill).toBe('cancelled');   // durable status written BEFORE the kill
    expect(aborted).toBe(true);
    expect(killCount).toBe(1);                 // external kill fired exactly once
    expect(store.getJob(jobId)!.status).toBe('cancelled');
  });

  it('duplicate cancel does not re-kill or revive', () => {
    const jobId = runningJob();
    let killCount = 0;
    const child = { kill: () => { killCount++; } } as unknown as RunHandle['child'];
    (engine as unknown as EnginePriv).running.set(jobId, { ac: new AbortController(), child });
    engine.cancel(jobId);
    engine.cancel(jobId); // second cancel — handle already dropped
    expect(killCount).toBe(1);
    expect(store.getJob(jobId)!.status).toBe('cancelled');
  });

  it('a kill failure still leaves a durable cancelled (persisted first)', () => {
    const jobId = runningJob();
    const child = { kill: () => { throw new Error('ESRCH'); } } as unknown as RunHandle['child'];
    (engine as unknown as EnginePriv).running.set(jobId, { ac: new AbortController(), child });
    const out = engine.cancel(jobId);
    expect(out?.status).toBe('cancelled');
    expect(store.getJob(jobId)!.status).toBe('cancelled');
  });

  it('an already-terminal job is a no-op (no kill, no revival)', () => {
    const jobId = runningJob();
    store.updateJob(jobId, { status: 'done' });
    let killCount = 0;
    const child = { kill: () => { killCount++; } } as unknown as RunHandle['child'];
    (engine as unknown as EnginePriv).running.set(jobId, { ac: new AbortController(), child });
    const out = engine.cancel(jobId);
    expect(out?.status).toBe('done');      // unchanged
    expect(killCount).toBe(0);             // no external kill
  });

  it('the run terminal never overwrites a cancelled status (guard precondition holds)', () => {
    const jobId = runningJob();
    const child = { kill: () => {} } as unknown as RunHandle['child'];
    (engine as unknown as EnginePriv).running.set(jobId, { ac: new AbortController(), child });
    engine.cancel(jobId);
    // The aborted run's terminal writes only when `status !== 'cancelled'` — the store now
    // reports 'cancelled', so a late runner completion is skipped by that guard.
    expect(store.getJob(jobId)!.status).toBe('cancelled');
  });
});
