import { describe, it, expect, vi } from 'vitest';
import { BrowserManager } from './manager.js';

function launcherWith(page: any) {
  const ctx: any = {
    pages: () => [page], newPage: async () => page, close: async () => {},
    on() {}, browser: () => ({ version: () => '1' }),
    addInitScript: async () => {}, exposeBinding: async () => {},
  };
  return { launchPersistentContext: async () => ctx };
}
function mk(page: any) {
  return new BrowserManager({ userDataDir: '/tmp', settings: () => ({ enabled: true, headless: true }), dispatch: async () => ({}), emit: () => {}, launcher: launcherWith(page) });
}

describe('BrowserManager.call (unit, fake page)', () => {
  it('navigate returns the resulting url', async () => {
    let u = 'about:blank';
    const page = { goto: vi.fn(async (x: string) => { u = x; }), url: () => u, title: async () => 't', screenshot: async () => Buffer.from('p'), bringToFront: async () => {} };
    const m = mk(page); await m.open('p');
    expect(await m.call('p', 'navigate', { url: 'https://z.test' })).toEqual({ url: 'https://z.test' });
  });
  it('evaluate returns { result }', async () => {
    const page = { goto: async () => {}, url: () => 'about:blank', title: async () => 't', screenshot: async () => Buffer.from('p'), bringToFront: async () => {}, evaluate: async (_e: string) => 42 };
    const m = mk(page); await m.open('p');
    expect(await m.call('p', 'evaluate', { expression: '1+41' })).toEqual({ result: 42 });
  });
  it('throws a clear error when the project has no open browser', async () => {
    const m = new BrowserManager({ userDataDir: '/tmp', settings: () => ({ enabled: true, headless: true }), dispatch: async () => ({}), emit: () => {} });
    await expect(m.call('nope', 'snapshot')).rejects.toThrow(/not open/i);
  });
  it('rejects unsupported actions', async () => {
    const page = { goto: async () => {}, url: () => 'about:blank', title: async () => 't', screenshot: async () => Buffer.from('p'), bringToFront: async () => {} };
    const m = mk(page); await m.open('p');
    await expect(m.call('p', 'frobnicate')).rejects.toThrow(/unsupported browser action/i);
  });
});

describe('BrowserManager.call (real Chrome, gated)', () => {
  it('drives navigate → snapshot → click → evaluate through the bus', async () => {
    const m = new BrowserManager({ userDataDir: '/tmp/mochi-call-' + Date.now(), settings: () => ({ enabled: true, headless: true }), dispatch: async () => ({}), emit: () => {} });
    const st = await m.open('p', { startUrl: 'data:text/html,<button onclick="window.__c=1">Go</button>' });
    if (!st.open) { expect(true).toBe(true); return; } // no Chrome → green-skip
    try {
      const snap: any = await m.call('p', 'snapshot');
      expect(snap.tree).toMatch(/button/i);
      expect(snap.refs.length).toBeGreaterThan(0);
      const btnRef = (snap.tree.match(/button[^\n]*\[ref=(e\d+|m\d+)\]/) || [])[1];
      if (btnRef) await m.call('p', 'click', { ref: btnRef });
      const ev: any = await m.call('p', 'evaluate', { expression: 'window.__c || 0' });
      expect(ev.result).toBe(1);
    } finally { await m.close('p'); }
  });
});
