import { describe, it, expect, vi } from 'vitest';
import { ScreenShareRegistry } from './shadow-screen-registry.js';

describe('ScreenShareRegistry', () => {
  it('starts inactive and holds metadata-only status', () => {
    const r = new ScreenShareRegistry();
    expect(r.get()).toEqual({ active: false, deviceLabel: '', sourceLabel: '', startedAtMs: 0 });
    r.set({ active: true, deviceLabel: 'Device abcd', sourceLabel: 'Built-in Display · 1512×982', startedAtMs: 1000 });
    expect(r.get().active).toBe(true);
    // no frame/key material ever lives here
    expect(JSON.stringify(r.get())).not.toMatch(/frame|key|nonce|cipher|base64/i);
  });

  it('clear() and set(inactive) both go inactive', () => {
    const r = new ScreenShareRegistry();
    r.set({ active: true, deviceLabel: 'd', sourceLabel: 's', startedAtMs: 1 });
    r.clear();
    expect(r.get().active).toBe(false);
    r.set({ active: false, deviceLabel: 'd', sourceLabel: 's', startedAtMs: 1 });
    expect(r.get()).toEqual({ active: false, deviceLabel: '', sourceLabel: '', startedAtMs: 0 });
  });

  it('stop() invokes the registered local stop and forces inactive', async () => {
    const r = new ScreenShareRegistry();
    const stop = vi.fn();
    r.registerStop(stop);
    r.set({ active: true, deviceLabel: 'd', sourceLabel: 's', startedAtMs: 1 });
    expect(await r.stop()).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(r.get().active).toBe(false);
  });

  it('stop() is safe with no registered stop and swallows stop errors', async () => {
    const r = new ScreenShareRegistry();
    expect(await r.stop()).toEqual({ ok: true });
    r.registerStop(() => { throw new Error('boom'); });
    r.set({ active: true, deviceLabel: 'd', sourceLabel: 's', startedAtMs: 1 });
    expect(await r.stop()).toEqual({ ok: true });
    expect(r.get().active).toBe(false);
  });
});
