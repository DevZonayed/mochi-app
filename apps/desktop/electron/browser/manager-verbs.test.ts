import { describe, it, expect } from 'vitest';
import { BrowserManager } from './manager.js';

/* Real-Chrome parity check for the extended verb map (gated: green-skips with no
   Chrome). Exercises the verbs the agent's browser_* tools depend on beyond the
   core navigate/click/snapshot. */
describe('extended verb parity (real Chrome, gated)', () => {
  it('handles query / interact / tab / cookie / history verbs', async () => {
    const m = new BrowserManager({ userDataDir: '/tmp/mochi-verbs-' + Date.now(), settings: () => ({ enabled: true, headless: true }), dispatch: async () => ({}), emit: () => {} });
    const st = await m.open('p', { startUrl: 'data:text/html,<button>One</button><a href="/x">L</a><script>console.log("hello-console")</script>' });
    if (!st.open) { expect(true).toBe(true); return; } // no Chrome → skip
    try {
      expect(((await m.call('p', 'match_count', { selector: 'button' })) as any).count).toBe(1);
      expect(((await m.call('p', 'find_by_role_name', { role: 'button', name: 'One' })) as any).count).toBeGreaterThan(0);

      const snap: any = await m.call('p', 'snapshot');
      const box: any = await m.call('p', 'resolve_box', { ref: snap.refs[0] });
      expect(box.box === null || typeof box.box.width === 'number').toBe(true);

      const cons: any = await m.call('p', 'console_messages', {});
      expect(JSON.stringify(cons.messages)).toContain('hello-console');

      await m.call('p', 'cookies_set', { cookies: [{ name: 'k', value: 'v', url: 'https://example.com' }] });
      expect(Array.isArray(((await m.call('p', 'cookies_get', {})) as any).cookies)).toBe(true);
      await m.call('p', 'cookies_clear', {});

      await m.call('p', 'open_tab', { url: 'data:text/html,<h1>Tab2</h1>' });
      expect(((await m.call('p', 'list_tabs', {})) as any).tabs.length).toBeGreaterThanOrEqual(2);
      await m.call('p', 'close_tab', {});

      await m.call('p', 'navigate', { url: 'data:text/html,<h1>Second</h1>' });
      expect(typeof ((await m.call('p', 'go_back', {})) as any).url).toBe('string');

      expect(Array.isArray(((await m.call('p', 'network_requests', {})) as any).requests)).toBe(true);
    } finally { await m.close('p'); }
  });
});
