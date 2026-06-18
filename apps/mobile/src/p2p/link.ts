/* Mobile P2P link: drives the answerer + a ReliableMessenger over the channel.

   Events flow over the direct channel when it's up; commands stay on the proven
   REST path (see api.ts). Started only when the Mac's `p2pEnabled` flag is on. The
   native transport is dynamically imported so react-native-webrtc never loads in
   Expo Go / web — if it's unavailable, the link aborts and we stay on SSE. */

import { ReliableMessenger } from '@maestro/realtime';
import type { Envelope, IceServer, Transport } from '@maestro/realtime';
import type { Signal } from './transport';

/** The answerer's public surface (a Transport that also applies inbound signaling). */
type Answerer = Transport & { applySignal(sig: Signal): Promise<void> };

export interface P2PLinkDeps {
  /** Send our signaling to the Mac (→ POST /api/signal). */
  postSignal: (signal: Signal) => void;
  /** ICE servers — TURN creds from the relay, else public STUN. */
  fetchIce: () => Promise<IceServer[]>;
  /** Deliver a P2P-sourced host event to the live sink (useLive). */
  onEvent: (name: string, data: unknown) => void;
}

export interface P2PLink {
  start(): void;
  stop(): void;
  /** True once the data channel is open (events then ride P2P, not SSE). */
  isActive(): boolean;
  /** Feed a `signal` frame received over SSE to the answerer. */
  onRemoteSignal(signal: Signal): void;
}

export function createP2PLink(deps: P2PLinkDeps): P2PLink {
  let peer: Answerer | null = null;
  let messenger: ReliableMessenger | null = null;
  let active = false;
  let started = false;

  const begin = async (): Promise<void> => {
    if (started) return;
    started = true;
    const iceServers = await deps.fetchIce().catch(() => [] as IceServer[]);
    if (!started) return; // stopped while fetching
    let MobileP2P: new (o: { iceServers: IceServer[]; sendSignal: (s: Signal) => void }) => Answerer;
    try {
      ({ MobileP2P } = await import('./transport')); // native loads ONLY here
    } catch {
      started = false; // react-native-webrtc unavailable (Expo Go / web) → stay on SSE
      return;
    }
    if (!started) return;
    const p = new MobileP2P({ iceServers, sendSignal: deps.postSignal });
    peer = p;
    messenger = new ReliableMessenger(p, {
      onState: (s) => {
        active = s === 'connected';
      },
      onDeliver: (env: Envelope) => {
        if (env.kind === 'event') {
          const payload = env.payload as { name?: string; data?: unknown } | undefined;
          if (payload?.name) deps.onEvent(payload.name, payload.data);
        }
        // 'result' envelopes would be handled here once commands also move to P2P.
      },
    });
    deps.postSignal({ kind: 'p2p-hello' }); // ask the Mac to upgrade us (it offers iff its flag is on)
  };

  return {
    start: () => {
      void begin();
    },
    stop: () => {
      started = false;
      active = false;
      messenger?.dispose();
      try {
        peer?.close();
      } catch {
        /* */
      }
      peer = null;
      messenger = null;
    },
    isActive: () => active,
    onRemoteSignal: (signal: Signal) => {
      void peer?.applySignal(signal);
    },
  };
}
