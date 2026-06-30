import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { ExtensionBridge } from './extension-bridge.js';

const TOKEN = 'TEST-TOK-EN01';

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeStore(opts: { jobs?: any[]; projects?: any[]; sessions?: any[] } = {}): any {
  const projects = opts.projects ?? [{ id: 'p1', name: 'Proj One', kind: 'coding', color: '#abc' }];
  const sessions = opts.sessions ?? [{ id: 's1', projectId: 'p1', title: 'Chat 1', updatedAt: 2 }];
  const jobs = opts.jobs ?? [];
  return {
    extensionToken: TOKEN,
    listProjects: () => projects,
    listSessions: (pid?: string) => sessions.filter((s: any) => !pid || s.projectId === pid),
    listJobs: (pid?: string, sid?: string) => jobs.filter((j: any) => (!pid || j.projectId === pid) && (!sid || j.sessionId === sid)),
  };
}

let nextPort = 17311;
const bridges: ExtensionBridge[] = [];
const clients: WebSocket[] = [];
afterEach(() => {
  for (const c of clients) { try { c.close(); } catch { /* */ } } clients.length = 0;
  for (const b of bridges) { try { b.stop(); } catch { /* */ } } bridges.length = 0;
});

function startBridge(store: any, dispatch: any = async () => ({})): { bridge: ExtensionBridge; port: number } {
  const port = nextPort++;
  const bridge = new ExtensionBridge(store, dispatch, () => {}, port);
  bridge.start();
  bridges.push(bridge);
  return { bridge, port };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 1500): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await sleep(15);
  }
}
const lastOfType = (msgs: any[], type: string) => [...msgs].reverse().find(m => m.type === type);
const lastLifecycle = (msgs: any[]) => [...msgs].reverse().find(m => m.type === 'promoted' || m.type === 'standby');

/** Open a ws client, retrying until the server is listening, then send `hello`. */
function open(port: number, hello: any): Promise<{ ws: WebSocket; msgs: any[] }> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const msgs: any[] = [];
      ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* */ } });
      ws.once('open', () => { clients.push(ws); ws.send(JSON.stringify(hello)); resolve({ ws, msgs }); });
      ws.once('error', (e) => { if (n < 30) setTimeout(() => attempt(n + 1), 35); else reject(e); });
    };
    attempt(0);
  });
}
const hello = (clientId: string, profile: string, token = TOKEN) => ({ type: 'hello', role: 'extension', clientId, profile, token });

describe('ExtensionBridge', () => {
  it('rejects a connection that presents the wrong token', async () => {
    const { port } = startBridge(fakeStore());
    const { ws, msgs } = await open(port, hello('a', 'A', 'WRONG'));
    await waitFor(() => (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) || undefined);
    expect(lastOfType(msgs, 'welcome')).toBeUndefined();
  });

  it('welcomes a valid profile, snapshots projects+chats, and makes the first active', async () => {
    const { port } = startBridge(fakeStore());
    const { msgs } = await open(port, hello('a', 'Alice'));
    const welcome = await waitFor(() => lastOfType(msgs, 'welcome'));
    expect(welcome.active).toBe(true);
    const snap = await waitFor(() => lastOfType(msgs, 'snapshot'));
    expect(snap.projects[0].id).toBe('p1');
    expect(snap.projects[0].sessions[0].id).toBe('s1');
    expect(snap.projects[0].sessions[0].running).toBe(false);
  });

  it('marks running chats in the snapshot', async () => {
    const store = fakeStore({ jobs: [{ id: 'jr', projectId: 'p1', sessionId: 's1', status: 'running' }] });
    const { port } = startBridge(store);
    const { msgs } = await open(port, hello('a', 'A'));
    const snap = await waitFor(() => lastOfType(msgs, 'snapshot'));
    expect(snap.projects[0].sessions[0].running).toBe(true);
  });

  it('puts a second profile on standby and promotes it on request_takeover', async () => {
    const { port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    const b = await open(port, hello('b', 'B'));
    const bWelcome = await waitFor(() => lastOfType(b.msgs, 'welcome'));
    expect(bWelcome.active).toBe(false);
    await waitFor(() => a.msgs.some(m => m.type === 'peers' && m.peers.length === 2));

    b.ws.send(JSON.stringify({ type: 'request_takeover' }));
    await waitFor(() => lastLifecycle(b.msgs)?.type === 'promoted');
    await waitFor(() => lastLifecycle(a.msgs)?.type === 'standby');
  });

  it('promotes the remaining profile when the active one disconnects', async () => {
    const { port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    const b = await open(port, hello('b', 'B'));
    await waitFor(() => lastOfType(b.msgs, 'welcome'));
    a.ws.close();
    await waitFor(() => lastLifecycle(b.msgs)?.type === 'promoted');
  });

  it('lets the app take over a profile (setActiveFromApp)', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    const b = await open(port, hello('b', 'B'));
    await waitFor(() => lastOfType(b.msgs, 'welcome'));
    const st = bridge.setActiveFromApp('b');
    expect(st.peers.find(p => p.clientId === 'b')?.active).toBe(true);
    expect(st.peers.find(p => p.clientId === 'a')?.active).toBe(false);
    await waitFor(() => lastLifecycle(b.msgs)?.type === 'promoted');
  });

  it('routes send_message → cancel the running job, then sendChat', async () => {
    const calls: { method: string; params: any }[] = [];
    const dispatch = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'sendChat') return { session: { id: 's1' }, job: { id: 'j9' } };
      return { ok: true };
    };
    const store = fakeStore({ jobs: [{ id: 'jr', projectId: 'p1', sessionId: 's1', status: 'running' }] });
    const { port } = startBridge(store, dispatch);
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    a.ws.send(JSON.stringify({ id: 5, type: 'send_message', params: { projectId: 'p1', sessionId: 's1', text: 'hello' } }));
    const reply = await waitFor(() => a.msgs.find(m => m.id === 5));
    expect(reply.ok).toBe(true);
    expect(reply.result).toEqual({ sessionId: 's1', jobId: 'j9' });
    expect(calls.map(c => c.method)).toEqual(['cancelJob', 'sendChat']);
    expect(calls[0].params).toEqual({ id: 'jr' });
  });

  it('rejects an unknown action', async () => {
    const { port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    a.ws.send(JSON.stringify({ id: 9, type: 'wat', params: {} }));
    const reply = await waitFor(() => a.msgs.find(m => m.id === 9));
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain('unknown action');
  });

  it('add_comment stores a design comment and delivers it into the chosen chat', async () => {
    const calls: string[] = [];
    const dispatch = async (method: string, _params: any) => {
      calls.push(method);
      if (method === 'addDesignComment') return { comment: { id: 'c1' } };
      if (method === 'sendChat') return { session: { id: 's1' }, job: { id: 'j1' } };
      return { ok: true };
    };
    const { port } = startBridge(fakeStore(), dispatch);
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    a.ws.send(JSON.stringify({ id: 7, type: 'add_comment', params: { projectId: 'p1', sessionId: 's1', selector: '.x', label: 'Button', note: 'too small', url: 'http://x' } }));
    const reply = await waitFor(() => a.msgs.find(m => m.id === 7));
    expect(reply.ok).toBe(true);
    expect(reply.result.commentId).toBe('c1');
    expect(calls).toContain('addDesignComment');
    expect(calls).toContain('sendChat');
  });

  it('add_comment with no session ("+ New chat") still opens a chat and delivers', async () => {
    const calls: string[] = [];
    const dispatch = async (method: string, params: any) => {
      calls.push(method);
      if (method === 'addDesignComment') return { comment: { id: 'c2' } };
      if (method === 'sendChat') { expect(params.sessionId).toBeUndefined(); return { session: { id: 'sNew' }, job: { id: 'jNew' } }; }
      return { ok: true };
    };
    const { port } = startBridge(fakeStore(), dispatch);
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    // sessionId omitted = "+ New chat" in the picker.
    a.ws.send(JSON.stringify({ id: 8, type: 'add_comment', params: { projectId: 'p1', selector: '.y', label: 'Card', note: 'wrong color', url: 'http://y' } }));
    const reply = await waitFor(() => a.msgs.find(m => m.id === 8));
    expect(reply.ok).toBe(true);
    expect(reply.result.commentId).toBe('c2');
    expect(reply.result.sessionId).toBe('sNew');
    expect(calls).toEqual(['addDesignComment', 'sendChat']);
  });

  // ── app→extension RPC (browser automation, "Round 2") ──
  /** Make a connected client behave like the extension: reply to app→ext commands. */
  function autoReplyBrowser(ws: WebSocket, handler: (type: string, params: any) => { ok: boolean; result?: any; error?: string }) {
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id != null && m.type && m.params !== undefined) {
        const r = handler(m.type, m.params);
        ws.send(JSON.stringify({ id: m.id, ok: r.ok, result: r.result, error: r.error }));
      }
    });
  }

  it('request() drives the ACTIVE browser and resolves with its reply', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    autoReplyBrowser(a.ws, (type, params) => ({ ok: true, result: { echoed: type, url: params.url } }));
    expect(bridge.hasActiveBrowser()).toBe(true);
    expect(bridge.activeProfile()).toBe('A');
    const res = await bridge.request('navigate', { url: 'https://x.test' }) as any;
    expect(res).toEqual({ echoed: 'navigate', url: 'https://x.test' });
  });

  it('request() rejects (503) when no browser is connected', async () => {
    const { bridge } = startBridge(fakeStore());
    expect(bridge.hasActiveBrowser()).toBe(false);
    await expect(bridge.request('navigate', { url: 'x' })).rejects.toThrow(/No browser connected/);
  });

  it('request() routes to the ACTIVE profile, not a standby one', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    const b = await open(port, hello('b', 'B'));         // b joins on standby
    await waitFor(() => lastOfType(b.msgs, 'welcome'));
    bridge.setActiveFromApp('b');                          // make b active
    await waitFor(() => lastLifecycle(b.msgs)?.type === 'promoted');
    autoReplyBrowser(a.ws, () => ({ ok: true, result: { who: 'A' } }));
    autoReplyBrowser(b.ws, () => ({ ok: true, result: { who: 'B' } }));
    const res = await bridge.request('snapshot', {}) as any;
    expect(res.who).toBe('B');
  });

  it('request() surfaces a browser-side error', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    autoReplyBrowser(a.ws, () => ({ ok: false, error: 'tab crashed' }));
    await expect(bridge.request('click', { ref: '.x' })).rejects.toThrow(/tab crashed/);
  });

  // ── browser-session ownership (end-of-turn auto-close vs. manual "keep open") ──
  it('marks an agent session open after navigate, and closeAgentSession ends it', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    const seen: string[] = [];
    autoReplyBrowser(a.ws, (type) => { seen.push(type); return { ok: true, result: {} }; });

    expect(bridge.hasAgentSession()).toBe(false);
    await bridge.request('navigate', { url: 'https://x.test' });
    expect(bridge.hasAgentSession()).toBe(true);   // agent opened a managed session

    await bridge.closeAgentSession();
    expect(bridge.hasAgentSession()).toBe(false);  // tidied up
    expect(seen).toContain('session_end');         // and asked the browser to close tabs
  });

  it('session_end (agent-driven) clears the open flag', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    autoReplyBrowser(a.ws, () => ({ ok: true, result: {} }));
    await bridge.request('open_tab', { url: 'https://x.test' });
    expect(bridge.hasAgentSession()).toBe(true);
    await bridge.request('session_end', { closeTabs: true });
    expect(bridge.hasAgentSession()).toBe(false);
  });

  it('a manual hold suppresses agent-session tracking and no-ops closeAgentSession', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    const seen: string[] = [];
    autoReplyBrowser(a.ws, (type) => { seen.push(type); return { ok: true, result: {} }; });

    bridge.setBrowserHold(true);
    expect(bridge.isBrowserHeld()).toBe(true);
    expect(bridge.status().held).toBe(true);

    await bridge.request('navigate', { url: 'https://x.test' });
    expect(bridge.hasAgentSession()).toBe(false);  // user pinned it — not the agent's to track

    await bridge.closeAgentSession();              // must be a no-op while held
    expect(seen).not.toContain('session_end');

    bridge.setBrowserHold(false);
    expect(bridge.status().held).toBe(false);
  });

  it('pinning the browser open clears any prior agent-opened flag', async () => {
    const { bridge, port } = startBridge(fakeStore());
    const a = await open(port, hello('a', 'A'));
    await waitFor(() => lastOfType(a.msgs, 'welcome'));
    autoReplyBrowser(a.ws, () => ({ ok: true, result: {} }));
    await bridge.request('navigate', { url: 'https://x.test' });
    expect(bridge.hasAgentSession()).toBe(true);
    bridge.setBrowserHold(true);                    // user takes ownership
    expect(bridge.hasAgentSession()).toBe(false);   // agent flag cleared → no auto-close
  });
});
