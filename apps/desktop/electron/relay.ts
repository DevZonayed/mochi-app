/* Relay client — this Mac dials OUT to the sync server and registers as the
   host. The server holds no data and runs no engine: it mirrors the snapshot
   we push (so the phone can render instantly) and forwards phone commands
   here, where they execute locally. Auto-reconnects with backoff. */

import WebSocket from 'ws';

/** One connected/recent remote, as reported by the relay's device registry. */
export interface RemoteDevice {
  id: string;
  name: string | null;
  /** Has at least one open SSE stream right now. */
  live: boolean;
  lastSeen: number;
}

export interface RelayOptions {
  url: string;
  deckId: string;
  deckSecret: string;
  /** Pairing token remotes must present; the relay enforces it on /api/*. */
  accessToken: string;
  getSnapshot: () => unknown;
  onCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Relay reports the current remote-device list (presence + per-device identity). */
  onRemote?: (devices: RemoteDevice[]) => void;
  /** A remote's WebRTC signaling (offer/answer/ICE) arrived for one device. */
  onSignal?: (did: string, signal: unknown) => void;
}

/** Match HostClient: minimum gap between snapshot pushes. The emit() path in
    main.ts calls pushSnapshot on every non-live event, so a streaming chat
    triggers one push per second. The snapshot is ~70 MB of JSON for a heavy
    user and was being built EVEN WHEN THE WS WASN'T CONNECTED — the sustained
    ArrayBuffer allocation rate (the JSON.stringify -> ws.send path is
    Buffer-backed) exhausted V8's ArrayBuffer pool. */
const SNAPSHOT_THROTTLE_MS = 5000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTrailer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: RelayOptions) {}

  start(): void {
    this.connect();
    this.heartbeat = setInterval(() => this.pushSnapshot(), 20000);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.snapshotTrailer) { clearTimeout(this.snapshotTrailer); this.snapshotTrailer = null; }
    try { this.ws?.close(); } catch { /* closing */ }
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      ws.on('open', () => {
        this.retryMs = 1000;
        this.send({ type: 'hello', role: 'host', deckId: this.opts.deckId, secret: this.opts.deckSecret, accessToken: this.opts.accessToken });
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
    let m: { type?: string; id?: string; method?: string; params?: Record<string, unknown>; devices?: RemoteDevice[]; did?: string; signal?: unknown };
    try { m = JSON.parse(raw) as typeof m; } catch { return; }
    if (m.type === 'ping') { this.send({ type: 'pong' }); return; }
    if (m.type === 'remote') { this.opts.onRemote?.(Array.isArray(m.devices) ? m.devices : []); return; }
    if (m.type === 'signal' && m.did) { this.opts.onSignal?.(m.did, m.signal); return; }
    if (m.type === 'cmd' && m.id && m.method) {
      try {
        const result = await this.opts.onCommand(m.method, m.params ?? {});
        this.send({ type: 'result', id: m.id, ok: true, result });
      } catch (e) {
        const err = e as { message?: string; statusCode?: number };
        this.send({ type: 'result', id: m.id, ok: false, error: err?.message ?? 'failed', statusCode: err?.statusCode ?? 500 });
      }
      this.pushSnapshot();
    }
  }

  /** Throttled snapshot push. Same shape as HostClient.pushSnapshot: callers
      fire it on every event, so collapse a burst into one push per window AND
      short-circuit when the WS isn't OPEN so we don't pay the JSON cost when
      nothing is listening. */
  pushSnapshot(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const wait = SNAPSHOT_THROTTLE_MS - (now - this.lastSnapshotAt);
    if (wait <= 0) {
      if (this.snapshotTrailer) { clearTimeout(this.snapshotTrailer); this.snapshotTrailer = null; }
      this.lastSnapshotAt = now;
      this.send({ type: 'state', state: this.opts.getSnapshot() });
      return;
    }
    if (this.snapshotTrailer) return;
    this.snapshotTrailer = setTimeout(() => {
      this.snapshotTrailer = null;
      this.lastSnapshotAt = Date.now();
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'state', state: this.opts.getSnapshot() });
    }, wait);
  }

  event(name: string, data: unknown): void {
    this.send({ type: 'event', name, data });
  }

  /** Send a WebRTC signaling payload (offer/ICE) to one remote — the relay routes by device id. */
  signal(did: string, payload: unknown): void {
    this.send({ type: 'signal', did, signal: payload });
  }

  /** Disconnect one remote device — the relay closes its streams and revokes its id. */
  kick(deviceId: string): void {
    this.send({ type: 'kick', deviceId });
  }

  /** Rotate the pairing token: drop the socket so we re-`hello` with the new token.
     The relay treats a changed token as a new pairing epoch (all remotes must re-pair). */
  updateToken(accessToken: string): void {
    this.opts.accessToken = accessToken;
    try { this.ws?.close(); } catch { /* 'close' schedules a reconnect with the new token */ }
  }

  private send(obj: unknown): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    } catch { /* dropped frame — next push covers it */ }
  }
}
