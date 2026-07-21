/* shadow-screen-relay-link — Phase 3D1 (B2) host-side `/ws/host/screen` client. A thin
 * `ScreenRelayLink` over the `ws` library (mirrors hostClient.ts): sends control JSON +
 * opaque binary frames, receives the controller's control JSON, and reports disconnect.
 * Reconnect is handled by the owner rebuilding the link on relay loss. */

import WebSocket from 'ws';
import type { ScreenRelayLink } from './shadow-screen-host.js';
import type { ScreenControlMessage } from '@maestro/realtime/shadowScreenStream';

export interface ScreenRelayLinkOptions {
  readonly relayOrigin: string; // e.g. https://api.nexalance.cloud
  readonly sessionToken: string;
  readonly hostDeviceId: string;
}

export class ScreenRelayHostLink implements ScreenRelayLink {
  private ws: WebSocket | null = null;
  private controlCb: ((raw: unknown) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private outbox: Array<{ text?: string; bin?: Uint8Array }> = [];
  private closed = false;

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
      const out = this.outbox; this.outbox = [];
      for (const m of out) { try { if (m.text !== undefined) ws.send(m.text); else if (m.bin) ws.send(m.bin, { binary: true }); } catch { /* */ } }
    });
    ws.on('message', (buf: Buffer | string, isBinary: boolean) => {
      if (isBinary) return; // the host never receives binary on this link
      try { this.controlCb?.(JSON.parse(String(buf))); } catch { /* */ }
    });
    ws.on('close', () => { this.ws = null; this.disconnectCb?.(); });
    ws.on('error', () => { try { ws.close(); } catch { /* */ } });
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
    const ws = this.ws; this.ws = null;
    if (ws) { ws.removeAllListeners('close'); try { ws.close(); } catch { /* */ } }
  }
}
