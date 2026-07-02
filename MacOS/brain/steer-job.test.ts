/* steerJob — routes the composer's ⌘↩ steer to engine.steer through the REAL
   localApi dispatch. The engine is stubbed; the dispatch wiring is production code. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-steerjob-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import type { LocalEngine } from './engine.js';

function setup(steerImpl: (jobId: string, text: string) => Promise<{ steered: boolean }>) {
  const s = new Store();
  const steer = vi.fn(steerImpl);
  const engine = { steer } as unknown as LocalEngine;
  const emit = vi.fn();
  // media/research/publishing/telegram/whatsapp/providers aren't touched by this case.
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit);
  return { dispatch, steer };
}

describe('steerJob dispatch', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('routes id + text to engine.steer and returns its result (delivered)', async () => {
    const { dispatch, steer } = setup(async () => ({ steered: true }));
    const r = await dispatch('steerJob', { id: 'job-1', text: 'use postgres instead' });
    expect(steer).toHaveBeenCalledWith('job-1', 'use postgres instead');
    expect(r).toEqual({ steered: true });
  });

  it('returns steered:false when the turn already settled (caller falls back to a send)', async () => {
    const { dispatch } = setup(async () => ({ steered: false }));
    const r = await dispatch('steerJob', { id: 'job-2', text: 'too late' });
    expect(r).toEqual({ steered: false });
  });

  it('coerces missing params to empty strings instead of throwing', async () => {
    const { dispatch, steer } = setup(async () => ({ steered: false }));
    await dispatch('steerJob', {});
    expect(steer).toHaveBeenCalledWith('', '');
  });
});
