import { describe, it, expect, vi } from 'vitest';
import { BrowserManager } from './manager.js';

/** A fake Playwright launcher — no real Chrome. Captures launch args and lets
    us assert lifecycle behavior deterministically. */
function fakeLauncher() {
  let currentUrl = 'about:blank';
  const page = {
    goto: vi.fn(async (u: string) => { currentUrl = u; }),
    url: () => currentUrl,
    title: async () => 'Title',
    screenshot: async () => Buffer.from('PNGDATA'),
    bringToFront: async () => {},
  };
  let closeCb: (() => void) | undefined;
  const ctx: any = {
    _closed: false,
    pages: () => [page],
    newPage: async () => page,
    close: vi.fn(async () => { ctx._closed = true; closeCb?.(); }),
    on: (_e: string, cb: () => void) => { closeCb = cb; },
    browser: () => ({ version: () => '126.0' }),
    addInitScript: vi.fn(async () => {}),
    exposeBinding: vi.fn(async () => {}),
  };
  return { launchPersistentContext: vi.fn(async () => ctx), _ctx: ctx, _page: page };
}

function mk(launcher: any) {
  const emit = vi.fn();
  const m = new BrowserManager({
    userDataDir: '/tmp/ud',
    settings: () => ({ enabled: true, headless: false }),
    dispatch: async () => ({}),
    emit,
    launcher,
  });
  return { m, emit };
}

describe('BrowserManager lifecycle', () => {
  it('open launches a persistent context with channel:chrome and reports open', async () => {
    const launcher = fakeLauncher();
    const { m, emit } = mk(launcher);
    const st = await m.open('proj_1', { startUrl: 'https://example.com' });
    expect(launcher.launchPersistentContext).toHaveBeenCalledWith(
      '/tmp/ud/browser-profiles/proj_1',
      expect.objectContaining({ channel: 'chrome', headless: false }),
    );
    expect(st.open).toBe(true);
    expect(st.chromeVersion).toBe('126.0');
    expect(emit).toHaveBeenCalled();
  });

  it('open is idempotent — second call reuses the context', async () => {
    const launcher = fakeLauncher();
    const { m } = mk(launcher);
    await m.open('proj_1');
    await m.open('proj_1');
    expect(launcher.launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it('navigate goes to the url and status reflects it', async () => {
    const launcher = fakeLauncher();
    const { m } = mk(launcher);
    await m.open('proj_1');
    const st = await m.navigate('proj_1', 'https://a.test');
    expect(st.url).toBe('https://a.test');
  });

  it('close closes the context and status goes not-open', async () => {
    const launcher = fakeLauncher();
    const { m } = mk(launcher);
    await m.open('proj_1');
    await m.close('proj_1');
    expect(launcher._ctx.close).toHaveBeenCalled();
    expect(m.status('proj_1').open).toBe(false);
  });

  it('screenshot returns a png data url', async () => {
    const launcher = fakeLauncher();
    const { m } = mk(launcher);
    await m.open('proj_1');
    const r = await m.screenshot('proj_1');
    expect(r.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('call/screenshot on an unopened project throws a clear error', async () => {
    const { m } = mk(fakeLauncher());
    await expect(m.screenshot('nope')).rejects.toThrow(/not open/i);
  });
});
