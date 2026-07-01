/* Desktop side of the direct P2P data channel.

   The actual RTCPeerConnection lives in a renderer (Chromium's native WebRTC);
   this main-process host is the brain-side bridge. It does NOT fall back — the
   relay is always connected and keeps serving commands/events. P2P is the FAST
   path: when a phone's channel is open, the Mac answers that phone's commands and
   pushes its events directly, peer-to-peer, instead of over the relay.

   Per connected remote it runs a ReliableMessenger over the renderer-hosted
   channel (outbox/ack/dedupe), and it answers inbound commands through the SAME
   `handleCommand` the relay path uses — so the remote-guard blocked-method set is
   enforced identically no matter which transport a command arrives on. */

import { ReliableMessenger, makeEnvelope } from '@maestro/realtime';
import type { Envelope, ConnState, MessengerConn } from '@maestro/realtime';

/** A control message the host pushes DOWN to the renderer-hosted WebRTC peer (IPC). */
export type ToRendererMsg =
  | { kind: 'signal-in'; did: string; signal: unknown } // remote SDP/ICE to apply
  | { kind: 'msg-out'; did: string; env: Envelope } // an envelope to send over the channel
  | { kind: 'close'; did: string }; // tear this peer down

export interface DesktopP2PDeps {
  /** Push a control message to the renderer-hosted peer (over IPC). */
  toRenderer: (msg: ToRendererMsg) => void;
  /** Send a signaling payload to one remote via the relay (host WS → device SSE). */
  signalViaRelay: (did: string, signal: unknown) => void;
  /** Execute a remote command with the relay path's exact security posture. */
  handleCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Heartbeat cadence for each peer's messenger (0 disables). Defaults to 15s. */
  heartbeatMs?: number;
}

/** Bridges a renderer-hosted data channel to a ReliableMessenger living in main. */
class RendererChannelConn implements MessengerConn {
  private msgCb: (e: Envelope) => void = () => {};
  private stateCb: (s: ConnState) => void = () => {};
  constructor(private did: string, private toRenderer: (m: ToRendererMsg) => void) {}
  send(env: Envelope): void {
    this.toRenderer({ kind: 'msg-out', did: this.did, env });
  }
  onMessage(cb: (e: Envelope) => void): void {
    this.msgCb = cb;
  }
  onStateChange(cb: (s: ConnState) => void): void {
    this.stateCb = cb;
  }
  // host-driven inputs (from renderer IPC)
  deliver(env: Envelope): void {
    this.msgCb(env);
  }
  setState(s: ConnState): void {
    this.stateCb(s);
  }
}

interface Peer {
  conn: RendererChannelConn;
  messenger: ReliableMessenger;
  ready: boolean;
}

interface CmdPayload {
  reqId?: string;
  method?: string;
  params?: Record<string, unknown>;
}

export class DesktopP2PHost {
  private peers = new Map<string, Peer>();
  private enabled = false;

  constructor(private deps: DesktopP2PDeps) {}

  /** Flag-gated: turning off tears down every peer and ignores new signaling. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.closeAll();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Inbound signaling from a remote (relay 'signal' frame) → ensure peer + forward to renderer. */
  onSignal(did: string, signal: unknown): void {
    if (!this.enabled || !did) return;
    this.ensurePeer(did);
    this.deps.toRenderer({ kind: 'signal-in', did, signal });
  }

  /** The renderer's peer produced a signaling payload to deliver to the remote. */
  fromRendererSignal(did: string, signal: unknown): void {
    if (!did) return;
    this.deps.signalViaRelay(did, signal);
  }

  /** The renderer reports an inbound channel envelope from the remote. */
  fromRendererMessage(did: string, env: Envelope): void {
    this.peers.get(did)?.conn.deliver(env);
  }

  /** The renderer reports the data channel's connection state changed. */
  fromRendererState(did: string, state: ConnState): void {
    const p = this.peers.get(did);
    if (!p) return;
    p.ready = state === 'connected';
    p.conn.setState(state);
  }

  /** The remote's channel closed for good (or the device went away). */
  removePeer(did: string): void {
    const p = this.peers.get(did);
    if (!p) return;
    p.messenger.dispose();
    this.peers.delete(did);
    this.deps.toRenderer({ kind: 'close', did });
  }

  /** Push a host event to every remote whose channel is open right now. */
  broadcastEvent(name: string, data: unknown): void {
    if (!this.enabled) return;
    for (const p of this.peers.values()) {
      if (p.ready) p.messenger.send(makeEnvelope('event', { name, data }));
    }
  }

  /** Device ids with an open channel right now. */
  liveDevices(): string[] {
    return [...this.peers.entries()].filter(([, p]) => p.ready).map(([did]) => did);
  }

  private ensurePeer(did: string): void {
    if (this.peers.has(did)) return;
    const conn = new RendererChannelConn(did, this.deps.toRenderer);
    const messenger = new ReliableMessenger(conn, {
      heartbeatMs: this.deps.heartbeatMs,
      onDeliver: (env) => {
        void this.onDeliver(did, env);
      },
    });
    this.peers.set(did, { conn, messenger, ready: false });
  }

  private async onDeliver(did: string, env: Envelope): Promise<void> {
    if (env.kind !== 'cmd') return;
    const p = this.peers.get(did);
    if (!p) return;
    const payload = (env.payload ?? {}) as CmdPayload;
    if (!payload.method) return;
    try {
      const result = await this.deps.handleCommand(payload.method, payload.params ?? {});
      p.messenger.send(makeEnvelope('result', { reqId: payload.reqId, ok: true, result }));
    } catch (e) {
      const err = e as { message?: string; statusCode?: number };
      p.messenger.send(
        makeEnvelope('result', {
          reqId: payload.reqId,
          ok: false,
          error: err?.message ?? 'failed',
          statusCode: err?.statusCode ?? 500,
        }),
      );
    }
  }

  private closeAll(): void {
    for (const [did, p] of this.peers) {
      p.messenger.dispose();
      this.deps.toRenderer({ kind: 'close', did });
    }
    this.peers.clear();
  }
}
