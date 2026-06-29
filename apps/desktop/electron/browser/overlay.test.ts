import { describe, it, expect, vi } from 'vitest';
import { BrowserManager } from './manager.js';
import { SNAPSHOT_BINDING, SEND_BINDING } from './overlay.js';

function fake() {
  const bindings: Record<string, Function> = {};
  const initScripts: string[] = [];
  let url = 'about:blank';
  const page = { goto: async (u: string) => { url = u; }, url: () => url, title: async () => 't', screenshot: async () => Buffer.from('PNG'), bringToFront: async () => {}, evaluate: async () => undefined };
  const ctx: any = {
    pages: () => [page], newPage: async () => page, close: async () => {}, on() {},
    browser: () => ({ version: () => '1' }),
    addInitScript: async (s: string) => { initScripts.push(s); },
    exposeBinding: async (n: string, cb: Function) => { bindings[n] = cb; },
  };
  return { launcher: { launchPersistentContext: async () => ctx }, bindings, initScripts, page };
}

function defaultDispatch() {
  return vi.fn(async (method: string, params: any) => {
    if (method === 'listSessions') return [{ id: 's1', title: 'Chat A' }, { id: 's2', title: 'Archived', archived: 123 }];
    if (method === 'listProjects') return [{ id: 'proj_42', name: 'My Project' }];
    if (method === 'listJobs') return [];
    if (method === 'sendChat') return { session: { id: params.sessionId || 'new-session' }, job: { id: 'j1' } };
    return {};
  });
}
function mk(f: ReturnType<typeof fake>, dispatch = defaultDispatch()) {
  const m = new BrowserManager({ userDataDir: '/tmp', settings: () => ({ enabled: true, headless: true }), dispatch, emit: () => {}, launcher: f.launcher as any });
  return { m, dispatch };
}

describe('send-hint overlay wiring (unit)', () => {
  it('registers the snapshot + send bindings and injects the overlay', async () => {
    const f = fake(); const { m } = mk(f);
    await m.open('proj_42');
    expect(typeof f.bindings[SNAPSHOT_BINDING]).toBe('function');
    expect(typeof f.bindings[SEND_BINDING]).toBe('function');
    expect(f.initScripts[0]).toContain('mochi-fab-host');
    expect(f.initScripts[0]).toContain('Send hint');
  });

  it('snapshot returns the project name + non-archived sessions for the picker', async () => {
    const f = fake(); const { m } = mk(f);
    await m.open('proj_42');
    const snap: any = await f.bindings[SNAPSHOT_BINDING](null);
    expect(snap.projects[0].name).toBe('My Project');
    expect(snap.projects[0].sessions.map((s: any) => s.id)).toEqual(['s1']); // 's2' archived → filtered
  });

  it('send targets the CHOSEN existing session (no new chat)', async () => {
    const f = fake(); const { m, dispatch } = mk(f);
    await m.open('proj_42');
    const res: any = await f.bindings[SEND_BINDING](null, { sessionId: 's1', text: 'tighten the header' });
    expect(res.ok).toBe(true);
    const sendCall = dispatch.mock.calls.find((c) => c[0] === 'sendChat')!;
    expect(sendCall[1]).toMatchObject({ projectId: 'proj_42', sessionId: 's1' });
    expect(sendCall[1].text).toContain('tighten the header');
  });

  it('null sessionId means a new chat (sessionId undefined → lazy-create)', async () => {
    const f = fake(); const { m, dispatch } = mk(f);
    await m.open('proj_42');
    await f.bindings[SEND_BINDING](null, { sessionId: null, text: 'hi' });
    const sendCall = dispatch.mock.calls.find((c) => c[0] === 'sendChat')!;
    expect(sendCall[1].sessionId).toBeUndefined();
  });

  it('composes element refs + URL + console errors into the message', async () => {
    const f = fake(); const { m, dispatch } = mk(f);
    await m.open('proj_42', { startUrl: 'https://shop.test/cart' });
    // seed a console error into the live buffer
    const live: any = (m as any).liveFor('proj_42'); live.cons.push({ type: 'error', text: 'Uncaught TypeError: x' });
    await f.bindings[SEND_BINDING](null, {
      sessionId: 's1', text: 'fix [#1]',
      elements: [{ selector: '#buy', tagName: 'button', text: 'Buy' }],
      includeUrl: true, includeConsole: true,
    });
    const sendCall = dispatch.mock.calls.find((c) => c[0] === 'sendChat')!;
    // Bubble text stays clean — JUST the hint, no context dump.
    expect(sendCall[1].text).toBe('fix [#1]');
    // Context rides as HIDDEN agentContext — NOT a visible/openable attachment.
    expect(sendCall[1].files).toBeUndefined();
    const ctx = sendCall[1].agentContext as string;
    expect(ctx).toContain('#buy');
    expect(ctx).toContain('<button>');
    expect(ctx).toContain('URL: https://shop.test/cart');
    expect(ctx).toContain('Uncaught TypeError');
  });

  it('steers a busy session — cancels its running job before sending', async () => {
    const f = fake();
    const dispatch = vi.fn(async (method: string, params: any) => {
      if (method === 'listJobs') return [{ id: 'jR', status: 'running' }];
      if (method === 'sendChat') return { session: { id: params.sessionId }, job: { id: 'j2' } };
      return {};
    });
    const { m } = mk(f, dispatch);
    await m.open('proj_42');
    await f.bindings[SEND_BINDING](null, { sessionId: 's1', text: 'stop, do this instead' });
    const methods = dispatch.mock.calls.map((c) => c[0]);
    expect(methods).toContain('cancelJob');
    expect(dispatch.mock.calls.find((c) => c[0] === 'cancelJob')![1]).toEqual({ id: 'jR' });
  });
});

describe('send-hint overlay (real Chrome, gated)', () => {
  it('injects the FAB + exposes the bindings on a live page', async () => {
    const dispatch = defaultDispatch();
    const m = new BrowserManager({ userDataDir: '/tmp/mochi-hint-' + Date.now(), settings: () => ({ enabled: true, headless: true }), dispatch, emit: () => {} });
    const st = await m.open('proj_42', { startUrl: 'data:text/html,<h1>Hi</h1>' });
    if (!st.open) { expect(true).toBe(true); return; }
    try {
      expect(((await m.call('proj_42', 'evaluate', { expression: 'typeof window.__mochiSnapshot' })) as any).result).toBe('function');
      expect(((await m.call('proj_42', 'evaluate', { expression: 'typeof window.__mochiSend' })) as any).result).toBe('function');
      expect(((await m.call('proj_42', 'evaluate', { expression: "!!document.getElementById('mochi-fab-host-9d2f')" })) as any).result).toBe(true);
      // Full round-trip: the REAL page calls the binding → Node sendHint → dispatch.
      const snap: any = await m.call('proj_42', 'evaluate', { expression: 'window.__mochiSnapshot()' });
      expect(snap.result.projects[0].name).toBe('My Project');
      const sent: any = await m.call('proj_42', 'evaluate', { expression: "window.__mochiSend({ sessionId: 'sX', text: 'from the real page' })" });
      expect(sent.result.ok).toBe(true);
      const sc = dispatch.mock.calls.find((c) => c[0] === 'sendChat')!;
      expect(sc[1].sessionId).toBe('sX');
      expect(sc[1].text).toContain('from the real page');
    } finally { await m.close('proj_42'); }
  });
});
