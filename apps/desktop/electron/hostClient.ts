/* Host client for the ACCOUNT server — this Mac dials out to /ws/host authenticated
   by the operator's Better Auth session (?token=) and identified by a stable device
   id (?did=). It registers as a host, mirrors its snapshot, emits events, and runs
   forwarded commands locally (execution stays on the Mac). Auto-reconnects.

   Protocol matches apps/server (wsHost.ts), verified by account.integration.test.ts:
   - send    {type:'hello', name, platform, deckId}      → recv {type:'hello-ok'}
   - send    {type:'state', state}                       (snapshot mirror, ~20s heartbeat)
   - send    {type:'event', eventName, data}             (host→remote fan-out)
   - recv    {type:'cmd', cmdId, method, params}  → send {type:'result', cmdId, ok, result|error}
   - recv    {type:'signal', fromDeviceId, signal}       (WebRTC, → onSignal)
   - send    {type:'signal', toDeviceId, signal}         (WebRTC, → a remote) */
import WebSocket from 'ws';

export interface HostClientOptions {
  /** Base wss URL of the account server, e.g. wss://api.nexalance.cloud */
  url: string;
  /** Better Auth session token for the logged-in account. */
  sessionToken: string;
  /** Stable per-Mac device id (persisted). */
  deviceId: string;
  /** Friendly host name shown in the device switcher. */
  name: string;
  deckId: string;
  getSnapshot: () => unknown;
  onCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onSignal?: (fromDeviceId: string, signal: unknown) => void;
}

export class HostClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: HostClientOptions) {}

  start(): void {
    this.connect();
    // Periodic snapshot push doubles as the presence heartbeat (each state frame
    // refreshes the server's presence TTL for this host).
    this.heartbeat = setInterval(() => this.pushSnapshot(), 20000);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try { this.ws?.close(); } catch { /* closing */ }
  }

  /** Swap the session token (e.g. after re-login) and reconnect. */
  updateSession(sessionToken: string): void {
    this.opts.sessionToken = sessionToken;
    try { this.ws?.close(); } catch { /* 'close' schedules reconnect with the new token */ }
  }

  private wsUrl(): string {
    const base = this.opts.url.replace(/^http/, 'ws').replace(/\/$/, '');
    const q = `token=${encodeURIComponent(this.opts.sessionToken)}&did=${encodeURIComponent(this.opts.deviceId)}`;
    return `${base}/ws/host?${q}`;
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(this.wsUrl());
      this.ws = ws;
      ws.on('open', () => {
        this.retryMs = 1000;
        this.send({ type: 'hello', name: this.opts.name, platform: 'macos', deckId: this.opts.deckId });
        this.pushSnapshot();
      });
      ws.on('message', (buf: Buffer | string) => { void this.onMessage(String(buf)); });
      ws.on('close', () => this.scheduleReconnect());
      ws.on('error', () => { /* 'close' follows */ });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.ws = null;
    setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  private async onMessage(raw: string): Promise<void> {
    let m: { type?: string; cmdId?: string; method?: string; params?: Record<string, unknown>; fromDeviceId?: string; signal?: unknown };
    try { m = JSON.parse(raw) as typeof m; } catch { return; }
    if (m.type === 'signal' && m.fromDeviceId) { this.opts.onSignal?.(m.fromDeviceId, m.signal); return; }
    if (m.type === 'cmd' && m.cmdId && m.method) {
      try {
        const result = await this.opts.onCommand(m.method, m.params ?? {});
        this.send({ type: 'result', cmdId: m.cmdId, ok: true, result });
      } catch (e) {
        const err = e as { message?: string; statusCode?: number };
        this.send({ type: 'result', cmdId: m.cmdId, ok: false, error: err?.message ?? 'failed', statusCode: err?.statusCode ?? 500 });
      }
      this.pushSnapshot();
    }
  }

  pushSnapshot(): void { this.send({ type: 'state', state: this.opts.getSnapshot() }); }
  event(name: string, data: unknown): void { this.send({ type: 'event', eventName: name, data }); }
  /** Send a WebRTC signal to one remote device (the server routes by device id). */
  signal(toDeviceId: string, payload: unknown): void { this.send({ type: 'signal', toDeviceId, signal: payload }); }

  private send(obj: unknown): void {
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
    catch { /* dropped frame — next push covers it */ }
  }
}
