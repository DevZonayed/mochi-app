/* health must report the LIVE app version (app.getVersion(), never a hardcoded /
   package.json value) and a VALIDATED release channel derived from MAESTRO_CHANNEL
   so simultaneously-running Production/Preview builds are distinguishable — while
   never leaking any other environment value. Verified through the REAL localApi
   dispatch (only the engine/gitService are stubbed). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-health-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '9.9.9-mock' } }));

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
  return { dispatch };
}

const CHANNEL_KEY = 'MAESTRO_CHANNEL';

describe('health — live app version + validated channel, no env leak', () => {
  const prevChannel = process.env[CHANNEL_KEY];
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));
  afterEach(() => {
    if (prevChannel === undefined) delete process.env[CHANNEL_KEY];
    else process.env[CHANNEL_KEY] = prevChannel;
    delete process.env.MAESTRO_HEALTH_LEAK_PROBE;
  });

  it('reports the live app.getVersion() (never a hardcoded/package version)', async () => {
    const { dispatch } = setup();
    const h = await dispatch('health') as { ok?: boolean; version?: string };
    expect(h.ok).toBe(true);
    expect(h.version).toBe('9.9.9-mock');
  });

  it('validates MAESTRO_CHANNEL — preview/development pass; unknown/unset → production', async () => {
    const { dispatch } = setup();
    const chan = async () => (await dispatch('health') as { channel?: string }).channel;

    process.env[CHANNEL_KEY] = 'preview';
    expect(await chan()).toBe('preview');
    process.env[CHANNEL_KEY] = 'development';
    expect(await chan()).toBe('development');
    process.env[CHANNEL_KEY] = 'staging'; // not a real channel
    expect(await chan()).toBe('production');
    delete process.env[CHANNEL_KEY];
    expect(await chan()).toBe('production');
  });

  it('exposes ONLY the known health fields — no other env value leaks', async () => {
    process.env.MAESTRO_HEALTH_LEAK_PROBE = 'DO_NOT_LEAK_ABCDEF';
    const { dispatch } = setup();
    const h = await dispatch('health') as Record<string, unknown>;
    expect(JSON.stringify(h)).not.toContain('DO_NOT_LEAK_ABCDEF');
    expect(Object.keys(h).sort()).toEqual(['channel', 'engine', 'name', 'ok', 'time', 'version']);
  });
});
