/* Mobile side of the direct P2P channel — the phone is the ANSWERER.

   react-native-webrtc is native: it runs ONLY in an EAS dev build, never Expo Go
   or web. This module is therefore loaded lazily (dynamic import in link.ts) so a
   non-dev-build launch never touches the native module. The phone sends a
   `p2p-hello`; the Mac (offerer) creates the data channel + offer; we answer.

   Typed against a minimal local surface (cast at the boundary) so it stays
   typecheck-clean regardless of react-native-webrtc's version-specific types. */

import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'react-native-webrtc';
import type { Envelope, ConnState, Transport, IceServer } from '@maestro/realtime';

export interface Signal {
  kind?: string;
  sdp?: unknown;
  candidate?: unknown;
}

export interface MobileP2POptions {
  iceServers: IceServer[];
  /** Deliver our outbound signaling (answer / ICE) to the Mac (→ POST /api/signal). */
  sendSignal: (signal: Signal) => void;
}

interface DataChannelLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
}

interface PeerLike {
  setRemoteDescription(d: unknown): Promise<void>;
  setLocalDescription(d: unknown): Promise<void>;
  createAnswer(): Promise<unknown>;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
  iceConnectionState: string;
  ondatachannel: ((e: { channel: DataChannelLike }) => void) | null;
  onicecandidate: ((e: { candidate: { toJSON?: () => unknown } | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}

// Cast the native constructors to a minimal shape (decouples from RN-webrtc types).
const PeerConnection = RTCPeerConnection as unknown as new (cfg: unknown) => PeerLike;
const SessionDescription = RTCSessionDescription as unknown as new (init: unknown) => unknown;
const IceCandidate = RTCIceCandidate as unknown as new (init: unknown) => unknown;

export class MobileP2P implements Transport {
  private pc: PeerLike | null = null;
  private channel: DataChannelLike | null = null;
  private msgCb: (e: Envelope) => void = () => {};
  private stateCb: (s: ConnState) => void = () => {};
  private pending: unknown[] = [];
  private remoteSet = false;

  constructor(private opts: MobileP2POptions) {}

  send(env: Envelope): void {
    if (this.channel && this.channel.readyState === 'open') {
      try {
        this.channel.send(JSON.stringify(env));
      } catch {
        /* channel raced closed */
      }
    }
  }
  isReady(): boolean {
    return this.channel?.readyState === 'open';
  }
  onMessage(cb: (e: Envelope) => void): void {
    this.msgCb = cb;
  }
  onStateChange(cb: (s: ConnState) => void): void {
    this.stateCb = cb;
  }
  close(): void {
    try {
      this.channel?.close();
    } catch {
      /* */
    }
    try {
      this.pc?.close();
    } catch {
      /* */
    }
    this.channel = null;
    this.pc = null;
    this.remoteSet = false;
    this.pending = [];
  }

  /** Apply inbound signaling from the Mac (offer / ICE candidate). */
  async applySignal(sig: Signal): Promise<void> {
    if (!sig) return;
    if (sig.kind === 'offer' && sig.sdp) {
      const pc = this.ensurePc();
      await pc.setRemoteDescription(new SessionDescription(sig.sdp));
      this.remoteSet = true;
      for (const c of this.pending.splice(0)) {
        try {
          await pc.addIceCandidate(new IceCandidate(c));
        } catch {
          /* stale candidate */
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.opts.sendSignal({ kind: 'answer', sdp: answer });
    } else if (sig.kind === 'candidate' && sig.candidate) {
      if (this.pc && this.remoteSet) {
        try {
          await this.pc.addIceCandidate(new IceCandidate(sig.candidate));
        } catch {
          /* */
        }
      } else {
        this.pending.push(sig.candidate); // buffer until the offer's remote description is set
      }
    }
  }

  private ensurePc(): PeerLike {
    if (this.pc) return this.pc;
    this.stateCb('connecting');
    const pc = new PeerConnection({ iceServers: this.opts.iceServers });
    this.pc = pc;
    pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this.wireChannel(e.channel);
    };
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (c) this.opts.sendSignal({ kind: 'candidate', candidate: c.toJSON ? c.toJSON() : c });
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'disconnected') this.stateCb('unstable');
      else if (s === 'failed') this.stateCb('reconnecting'); // the Mac (offerer) drives ICE restart
    };
    return pc;
  }

  private wireChannel(ch: DataChannelLike): void {
    ch.onopen = () => this.stateCb('connected');
    ch.onclose = () => this.stateCb('disconnected');
    ch.onmessage = (e) => {
      try {
        this.msgCb(JSON.parse(e.data) as Envelope);
      } catch {
        /* malformed frame */
      }
    };
  }
}
