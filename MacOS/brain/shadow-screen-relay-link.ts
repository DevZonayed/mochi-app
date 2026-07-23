/* shadow-screen-relay-link — Phase 3D1 (B2) host-side `/ws/host/screen` client. A thin
 * `ScreenRelayLink` over the `ws` library (mirrors hostClient.ts): sends control JSON +
 * opaque binary frames, receives the controller's control JSON, and reports disconnect.
 * Auto-reconnects on relay-side close/sweep so the host is always reachable for new
 * view requests — the coordinator stops the active stream on disconnect (a broken link
 * cannot relay frames) but the link re-establishes itself for the next request. */

import WebSocket from 'ws';
import type { ScreenRelayLink } from './shadow-screen-host.js';
import type { ScreenControlMessage } from '@maestro/realtime/shadowScreenStream';

export interface ScreenRelayLinkOptions {
  readonly relayOrigin: string; // e.g. https://api.nexalance.cloud
  readonly sessionToken: string;
  readonly hostDeviceId: string;
}

/** Base reconnect delay (ms). Doubles on consecutive failures, capped at 30s. */
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;

export class ScreenRelayHostLink implements ScreenRelayLink {
  private ws: WebSocket | null = null;
  private controlCb: ((raw: unknown) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private outbox: Array<{ text?: string; bin?: Uint8Array }> = [];
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly opts: ScreenRelayLinkOptions) {
    this.connect();
  }

  private url(): string {
    const base = this.opts.relayOrigin.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${base}/ws/host/screen?token=${encodeURIComponent(this.opts.sessionToken)}&did=${encodeURIComponent(this.opts.hostDeviceId)}`;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.on('open', () => {
      this.consecutiveFailures = 0;
      try { process.stderr.write(`[DIAG5] host link CONNECTED\n`); } catch { /* */ }
      const out = this.outbox; this.outbox = [];
      for (const m of out) { try { if (m.text !== undefined) ws.send(m.text); else if (m.bin) ws.send(m.bin, { binary: true }); } catch { /* */ } }
    });
    ws.on('message', (buf: Buffer | string, isBinary: boolean) => {
      if (isBinary) return; // the host never receives binary on this link
      try { process.stderr.write(`[DIAG5] host link RECV ${String(buf).slice(0, 90)}\n`); } catch { /* */ }
      try { this.controlCb?.(JSON.parse(String(buf))); } catch { /* */ }
    });
    ws.on('close', (code: number) => {
      try { process.stderr.write(`[DIAG5] host link CLOSED code=${code}\n`); } catch { /* */ }
      this.ws = null;
      // Notify the coordinator so it stops any active stream (a broken link cannot
      // relay frames). Then schedule a reconnect so the host is ready for the next
      // view request — unless destroy() was called (this.closed).
      this.disconnectCb?.();
      this.scheduleReconnect();
    });
    ws.on('error', () => { try { ws.close(); } catch { /* */ } });
  }

  /** Exponential-backoff reconnect (3s → 6s → 12s → … → 30s cap). */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.consecutiveFailures), RECONNECT_MAX_MS);
    this.consecutiveFailures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    if (typeof (this.reconnectTimer as { unref?: () => void }).unref === 'function') {
      (this.reconnectTimer as { unref: () => void }).unref();
    }
  }

  sendControl(msg: ScreenControlMessage): void {
    const text = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(text); } catch { /* */ } }
    else this.outbox.push({ text });
  }

  sendFrame(envelope: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(envelope, { binary: true }); } catch { /* */ } }
    // frames are latest-only — if not open, drop (never queue a backlog)
  }

  onControl(cb: (raw: unknown) => void): void { this.controlCb = cb; }
  onDisconnect(cb: () => void): void { this.disconnectCb = cb; }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { ws.removeAllListeners('close'); try { ws.close(); } catch { /* */ } }
  }
}
