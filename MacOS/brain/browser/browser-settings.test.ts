/* AppSettings.browser persistence on the real Store. Only app.getPath is mocked;
   everything else is the production getSettings/setSettings/save/load path. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-browser-settings-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0' } }));

import { Store } from '../store.js';

describe('AppSettings.browser', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('defaults to enabled + visible (not headless)', () => {
    const s = new Store();
    expect(s.getSettings().browser).toEqual({ enabled: true, headless: false });
  });

  it('persists a browser settings patch across reload', () => {
    const s = new Store();
    s.setSettings({ browser: { enabled: false, headless: true, chromePath: '/custom/chrome' } });
    expect(s.getSettings().browser?.headless).toBe(true);

    const reloaded = new Store();
    expect(reloaded.getSettings().browser?.enabled).toBe(false);
    expect(reloaded.getSettings().browser?.chromePath).toBe('/custom/chrome');
  });
});
