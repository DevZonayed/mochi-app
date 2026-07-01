/* Maestro ⇄ browser-extension control channel.
   ONE app-owned local WebSocket server (127.0.0.1:<port>) the native Chrome
   extension connects to — the single, unified transport (replaces the old Mochi
   MCP broker on 9009). Multiple Chrome profiles connect at once; exactly one is
   "active"; any can take over (from the popup OR the app's Settings). The
   extension is a CONTROL SURFACE: it lists projects + chats live, sends/steers
   messages into any chat, and drops element-anchored comments onto a chosen
   project + chat.

   Trust model: bound to 127.0.0.1, token-gated (the extension must present the
   app's pairing token in its hello), and it exposes only a CURATED action set —
   it never proxies arbitrary dispatch methods, so the browser can't reach the
   sensitive local surface (git, project memory, feedback, …). */

import { WebSocketServer, WebSocket } from 'ws';
import type { Store } from './store.js';

type Dispatch = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const DEFAULT_PORT = 9234;
/** Server→client keepalive cadence. A peer that misses a ping/pong round is a
    zombie (half-open socket) and gets terminated so it can't hold the "active"
    slot or a stale snapshot subscription. */
const HEARTBEAT_MS = 15000;

/** A connected Chrome profile (one WS per profile, keyed by its stable clientId). */
interface Peer { ws: WebSocket; clientId: string; profile: string; active: boolean; lastActiveAt: number; alive: boolean }

export interface ExtensionStatus {
  running: boolean;
  port: number;
  token: string;
  peers: { clientId: string; profile: string; active: boolean }[];
  /** True when the user pinned the browser open (Project settings → Open browser),
      so the agent's end-of-turn auto-close leaves it alone. */
  held: boolean;
}

export class ExtensionBridge {
  private wss?: WebSocketServer;
  private listening = false;
  private peers = new Map<string, Peer>(); // keyed by clientId — one per Chrome profile
  private port: number;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  // app→extension RPC (browser automation): outstanding requests keyed by id.
  private reqSeq = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** True once the AGENT has opened a Mochi-managed browser session this run
      (navigate / session_start / open_tab) and hasn't ended it. Drives the
      end-of-turn auto-close: a browser job that opened a tab tidies up after
      itself instead of leaving the window hanging around. Cleared on session_end. */
  private agentSessionOpen = false;
  /** Manual "keep the browser open" pin. Set when the user opens the browser
      themselves (Project settings → Open browser) so the end-of-turn auto-close
      LEAVES it alone — they asked for it, they close it. */
  private browserHold = false;

  constructor(
    private store: Store,
    private dispatch: Dispatch,
    private publish: (status: ExtensionStatus) => void,
    portOverride?: number,
  ) {
    const envPort = Number(process.env.MAESTRO_EXT_PORT);
    this.port = portOverride ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
  }

  start(): void {
    try {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    } catch { return; /* construction failed — Settings shows "offline" */ }
    this.wss.on('listening', () => { this.listening = true; this.publishStatus(); });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.wss.on('error', () => { this.listening = false; this.publishStatus(); /* e.g. port in use */ });
    this.startHeartbeat();
  }

  stop(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null; }
    this.rejectAllPending('extension bridge stopped');
    for (const p of this.peers.values()) { try { p.ws.close(); } catch { /* gone */ } }
    this.peers.clear();
    try { this.wss?.close(); } catch { /* already closed */ }
    this.listening = false;
  }

  /** Periodic WS ping to every peer. Browsers auto-answer ping frames with a
      pong (invisible to page JS), so a peer that didn't pong since the last tick
      is genuinely gone — terminate it, which fires `close` → detach → promotion
      of the next profile. Unref'd so it never holds the app process open. */
  private startHeartbeat(): void {
    if (this.hbTimer) return;
    const t = setInterval(() => {
      for (const p of this.peers.values()) {
        if (!p.alive) { try { p.ws.terminate(); } catch { /* already gone */ } continue; }
        p.alive = false;
        try { p.ws.ping(); } catch { /* surfaces as a close */ }
      }
    }, HEARTBEAT_MS);
    t.unref();
    this.hbTimer = t;
  }

  // ── status (for the Settings panel + app-side takeover) ──────────────────
  status(): ExtensionStatus {
    return { running: this.listening, port: this.port, token: this.store.extensionToken, peers: this.peerList(), held: this.browserHold };
  }
  /** App-side takeover ("Make active" in Settings). */
  setActiveFromApp(clientId: string): ExtensionStatus {
    if (this.peers.has(clientId)) this.setActive(clientId);
    return this.status();
  }
  private peerList() { return [...this.peers.values()].map(p => ({ clientId: p.clientId, profile: p.profile, active: p.active })); }
  private publishStatus() { try { this.publish(this.status()); } catch { /* no window */ } }

  // ── connection handshake ────────────────────────────────────────────────
  private onConnection(ws: WebSocket): void {
    let clientId: string | null = null;
    const helloTimer = setTimeout(() => { if (!clientId) { try { ws.close(1002, 'no hello'); } catch { /* */ } } }, 4000);
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!clientId) {
        // First frame MUST be a valid, token-bearing hello from the extension.
        if (msg.type !== 'hello' || msg.role !== 'extension') { try { ws.close(1002, 'bad hello'); } catch { /* */ } return; }
        if (String(msg.token ?? '') !== this.store.extensionToken) { try { ws.close(1008, 'unauthorised'); } catch { /* */ } return; }
        clearTimeout(helloTimer);
        clientId = String(msg.clientId || `ext-${Date.now()}`);
        this.attach(ws, clientId, String(msg.profile || 'Chrome'));
        return;
      }
      void this.handle(clientId, msg, ws);
    });
    ws.on('close', () => { clearTimeout(helloTimer); if (clientId) this.detach(clientId); });
    ws.on('error', () => { try { ws.close(); } catch { /* */ } });
  }

  private attach(ws: WebSocket, clientId: string, profile: string): void {
    const someoneActive = [...this.peers.values()].some(p => p.active);
    const prev = this.peers.get(clientId);
    // A reconnecting profile keeps its prior active flag; a brand-new profile
    // becomes active only if nobody is active yet.
    const active = prev?.active ?? !someoneActive;
    this.peers.set(clientId, { ws, clientId, profile, active, lastActiveAt: prev?.lastActiveAt ?? (active ? Date.now() : 0), alive: true });
    // A pong (auto-sent by the browser in reply to our heartbeat ping) proves
    // this exact socket is still live. Guard on `p.ws === ws` so a late pong from
    // a replaced socket can't revive a reconnected peer's new entry.
    ws.on('pong', () => { const p = this.peers.get(clientId); if (p && p.ws === ws) p.alive = true; });
    if (active) this.setActive(clientId); else this.broadcastLifecycle();
    this.send(ws, { type: 'welcome', clientId, active });
    this.send(ws, this.snapshotMessage(active));
    this.publishStatus();
  }

  private detach(clientId: string): void {
    const wasActive = this.peers.get(clientId)?.active;
    this.peers.delete(clientId);
    if (wasActive) {
      // In-flight browser commands were routed to this (now gone) profile — fail
      // them fast instead of waiting for the per-request timeout.
      this.rejectAllPending('browser profile disconnected');
      // Promote the most-recently-active remaining profile, if any.
      const next = [...this.peers.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (next) this.setActive(next.clientId);
    }
    this.broadcastLifecycle();
    this.publishStatus();
  }

  // ── active / standby election ───────────────────────────────────────────
  private setActive(clientId: string): void {
    const now = Date.now();
    for (const p of this.peers.values()) {
      p.active = p.clientId === clientId;
      if (p.active) p.lastActiveAt = now;
    }
    this.broadcastLifecycle();
    this.publishStatus();
  }

  private broadcastLifecycle(): void {
    const peers = this.peerList();
    for (const p of this.peers.values()) {
      this.send(p.ws, p.active ? { type: 'promoted' } : { type: 'standby', reason: 'another Chrome profile is active' });
      this.send(p.ws, { type: 'peers', peers });
    }
  }

  // ── snapshot + live refresh ─────────────────────────────────────────────
  private snapshotMessage(active: boolean) {
    const projects = this.store.listProjects().map(pr => {
      const sessions = this.store.listSessions(pr.id)
        .filter(s => !s.archived)
        .map(s => ({ id: s.id, title: s.title, running: this.isSessionRunning(pr.id, s.id), updatedAt: s.updatedAt }));
      return { id: pr.id, name: pr.name, kind: pr.kind ?? 'general', color: pr.color, sessions };
    });
    return { type: 'snapshot', active, projects };
  }

  private isSessionRunning(projectId: string, sessionId: string): boolean {
    return this.store.listJobs(projectId, sessionId).some(j => j.status === 'running' || j.status === 'pending');
  }

  /** Hooked from main.ts emit() — coalesced snapshot re-push on project/session/job
      changes so every connected profile's project+chat list stays live. */
  onAppEvent(name: string): void {
    if (name !== 'project' && name !== 'session' && name !== 'job') return;
    if (!this.peers.size || this.snapTimer) return;
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      for (const p of this.peers.values()) this.send(p.ws, this.snapshotMessage(p.active));
    }, 600);
  }

  // ── inbound messages ────────────────────────────────────────────────────
  private async handle(clientId: string, msg: Record<string, unknown>, ws: WebSocket): Promise<void> {
    if (!this.peers.has(clientId)) return;
    if (msg.type === 'request_takeover') { this.setActive(clientId); return; }
    if (msg.type === 'ping') { this.send(ws, { type: 'pong' }); return; }
    const id = msg.id;
    // A reply to one of OUR app→ext requests (browser automation): {id, ok, result|error}, no `type`.
    if (id != null && msg.type === undefined && 'ok' in msg) {
      const p = this.pending.get(String(id));
      if (p) {
        clearTimeout(p.timer); this.pending.delete(String(id));
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'browser command failed'));
      }
      return;
    }
    if (id == null) return; // not an RPC
    try {
      const result = await this.action(String(msg.type ?? ''), (msg.params as Record<string, unknown>) ?? {});
      this.send(ws, { id, ok: true, result });
    } catch (e) {
      this.send(ws, { id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The curated action set — the ONLY app surface the extension can reach. */
  private async action(type: string, params: Record<string, unknown>): Promise<unknown> {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    switch (type) {
      case 'get_snapshot':
        return this.snapshotMessage(this.peers.size ? [...this.peers.values()].some(p => p.active) : false);
      case 'send_message':
      case 'steer_message':
        return this.deliver(str(params.projectId), params.sessionId ? str(params.sessionId) : null, str(params.text));
      case 'add_comment':
        return this.addComment(params);
      default:
        throw new Error(`unknown action: ${type}`);
    }
  }

  /** Deliver text into a chat as a new turn. NEVER interrupts a live turn —
      previously this called cancelJob on any running job for the session, which
      kept STOPPING the operator's run out from under them when they added an
      element comment / pasted from the extension while the agent was busy
      (image_nqm3a.png — same root cause as the front-end "send mid-stream
      cancels the run" bug). Now, when the session is busy, we refuse the
      delivery cleanly so the caller can choose to retry or store the message
      for the operator. The red abort button in the chat is the only stop. */
  private async deliver(projectId: string, sessionId: string | null, text: string): Promise<{ sessionId: string; jobId: string }> {
    if (!projectId) throw new Error('projectId required');
    if (!text.trim()) throw new Error('message text required');
    if (sessionId) {
      const running = this.store.listJobs(projectId, sessionId).find(j => j.status === 'running' || j.status === 'pending');
      if (running) throw new Error('session busy — the agent is mid-turn; try again when it finishes');
    }
    const res = await this.dispatch('sendChat', { projectId, sessionId: sessionId ?? undefined, text }) as { session: { id: string }; job: { id: string } };
    return { sessionId: res.session.id, jobId: res.job.id };
  }

  /** Save an element-anchored comment as a project design-comment, and — when a
      chat is chosen — also deliver it into that chat. */
  private async addComment(params: Record<string, unknown>): Promise<{ commentId: string; sessionId?: string }> {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const projectId = str(params.projectId);
    if (!projectId) throw new Error('projectId required');
    const label = str(params.label) || 'element';
    const note = str(params.note);
    const url = str(params.url);
    const selector = str(params.selector);
    const added = await this.dispatch('addDesignComment', { id: projectId, selector, label, note }) as { comment: { id: string } };
    let deliveredSession: string | undefined;
    // A null sessionId means "+ New chat" — deliver() opens a fresh chat with the
    // comment body. Only skip delivery when the caller explicitly opts out, so
    // picking an element + "New chat" actually starts a chat (not silently drop).
    const sessionId = params.sessionId ? str(params.sessionId) : null;
    if (params.deliverToChat !== false) {
      const body = [
        `💬 Browser comment on **${label}**${url ? ` — ${url}` : ''}:`,
        note,
        selector ? `\nselector: \`${selector}\`` : '',
      ].filter(Boolean).join('\n');
      try { deliveredSession = (await this.deliver(projectId, sessionId, body)).sessionId; } catch { /* comment is still saved */ }
    }
    return { commentId: added.comment.id, sessionId: deliveredSession };
  }

  // ── app→extension RPC: drive the ACTIVE Chrome profile (browser automation) ──
  private activePeer(): Peer | undefined { for (const p of this.peers.values()) if (p.active) return p; return undefined; }

  /** Is there a live Chrome profile the agent can drive right now? */
  hasActiveBrowser(): boolean { return !!this.activePeer(); }
  /** The active profile's label (for agent/UI context), or null. */
  activeProfile(): string | null { return this.activePeer()?.profile ?? null; }

  // ── browser-session ownership (auto-close vs. manual "keep open") ──────────
  /** Did the agent open a Mochi-managed session that's still around? */
  hasAgentSession(): boolean { return this.agentSessionOpen; }
  /** Has the user pinned the browser open (Project settings → Open browser)? */
  isBrowserHeld(): boolean { return this.browserHold; }
  /** Pin / unpin the manual hold. Pinning also clears the agent-opened flag so
      the very next end-of-turn doesn't try to close a window the user now owns. */
  setBrowserHold(on: boolean): void { this.browserHold = on; if (on) this.agentSessionOpen = false; }
  /** End the agent-opened session and close its tabs — the end-of-turn tidy-up.
      No-op when nothing is open, no profile is connected, or the user pinned it
      open. Best-effort: a failure here never fails the run. */
  async closeAgentSession(): Promise<void> {
    if (this.browserHold || !this.agentSessionOpen) return;
    this.agentSessionOpen = false;
    if (!this.activePeer()) return;
    try { await this.request('session_end', { closeTabs: true }); } catch { /* already gone */ }
  }

  /** Run a browser-automation command (navigate/click/snapshot/type/…) against the
      ACTIVE profile and resolve with its result. The extension already dispatches
      `{id,type,params,clientId}` through its automation switch and replies
      `{id,ok,result|error}`; this is the app-side caller + correlation that was the
      missing half of "Round 2". Throws (503) when no browser is connected. */
  async request(type: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const peer = this.activePeer();
    if (!peer) throw Object.assign(new Error('No browser connected. Open the Mochi Chrome extension and activate a profile (the app shows it under Settings → Browser extension).'), { statusCode: 503 });
    const id = `a${this.reqSeq++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`browser '${type}' timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { this.trackSessionLifecycle(type); resolve(v); },
        reject,
        timer,
      });
      this.send(peer.ws, { id, type, params, clientId: peer.clientId });
    });
  }

  /** Note when a browser RPC opened or closed a Mochi-managed session so the
      end-of-turn auto-close knows whether there's anything to tidy up. A manual
      hold (user pinned the browser) suppresses the "opened" flag — their tabs
      aren't the agent's to close. */
  private trackSessionLifecycle(type: string): void {
    if (type === 'session_end') this.agentSessionOpen = false;
    else if ((type === 'navigate' || type === 'session_start' || type === 'open_tab') && !this.browserHold) this.agentSessionOpen = true;
  }

  private rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); try { p.reject(new Error(reason)); } catch { /* */ } }
    this.pending.clear();
  }

  private send(ws: WebSocket, obj: unknown): void {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* peer dropped */ }
  }
}
