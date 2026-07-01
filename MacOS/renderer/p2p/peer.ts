/* Renderer-hosted WebRTC peer (desktop = offerer).

   The Mac is the brain, but Node has no RTCPeerConnection — so the actual peer
   lives here in the renderer (Chromium's native WebRTC). main drives it over IPC
   (preload: sendP2P / onP2P / p2pIce). This module is a DUMB pipe: it owns the
   RTCPeerConnection + DataChannel per remote, relays signaling, and hands raw
   envelopes to/from main. All command execution + event sourcing stays in main.

   Inert outside the Electron shell (no window.maestro) — the web bundle keeps
   using the relay. The phone initiates with a `p2p-hello`; the desktop answers by
   creating the data channel + offer (it is the offerer). */

import type { Envelope } from '@maestro/realtime';

type ConnState = 'connecting' | 'connected' | 'unstable' | 'reconnecting' | 'disconnected';

interface Signal {
  kind?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface InboundMsg {
  kind: 'signal-in' | 'msg-out' | 'close';
  did: string;
  signal?: Signal;
  env?: Envelope;
}

interface P2PBridge {
  sendP2P?: (msg: unknown) => void;
  onP2P?: (cb: (msg: InboundMsg) => void) => () => void;
  p2pIce?: () => Promise<RTCIceServer[]>;
}

interface Peer {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

/** Start the desktop's renderer-side WebRTC peer. No-op outside the desktop shell. */
export function startDesktopP2P(): () => void {
  const bridge =
    typeof window !== 'undefined' ? (window as unknown as { maestro?: P2PBridge }).maestro : undefined;
  if (!bridge?.sendP2P || !bridge.onP2P) return () => {};
  const send = bridge.sendP2P;
  const peers = new Map<string, Peer>();
  let iceServers: RTCIceServer[] | null = null;

  const ice = async (): Promise<RTCIceServer[]> => {
    if (iceServers) return iceServers;
    try {
      iceServers = (await bridge.p2pIce?.()) ?? [];
    } catch {
      iceServers = [];
    }
    return iceServers;
  };

  const toMain = (kind: string, did: string, extra: Record<string, unknown> = {}): void =>
    send({ kind, did, ...extra });

  const wireChannel = (did: string, ch: RTCDataChannel): void => {
    ch.onopen = () => toMain('state', did, { state: 'connected' as ConnState });
    ch.onclose = () => toMain('state', did, { state: 'disconnected' as ConnState });
    ch.onmessage = (e: MessageEvent) => {
      try {
        toMain('msg-in', did, { env: JSON.parse(e.data as string) as Envelope });
      } catch {
        /* malformed frame — ignore */
      }
    };
  };

  const makeOffer = async (did: string): Promise<void> => {
    closePeer(did); // a fresh hello supersedes any half-open peer
    const pc = new RTCPeerConnection({ iceServers: await ice() });
    const channel = pc.createDataChannel('app', { ordered: true });
    peers.set(did, { pc, channel });
    wireChannel(did, channel);
    pc.onicecandidate = (e) => {
      if (e.candidate) toMain('signal-out', did, { signal: { kind: 'candidate', candidate: e.candidate.toJSON() } });
    };
    pc.oniceconnectionstatechange = () => {
      void onIceState(did, pc);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    toMain('signal-out', did, { signal: { kind: 'offer', sdp: offer } });
  };

  const onIceState = async (did: string, pc: RTCPeerConnection): Promise<void> => {
    const s = pc.iceConnectionState;
    if (s === 'disconnected') toMain('state', did, { state: 'unstable' as ConnState });
    if (s === 'failed') {
      // The offerer drives recovery: re-offer with ICE restart, re-signaled via the relay.
      toMain('state', did, { state: 'reconnecting' as ConnState });
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        toMain('signal-out', did, { signal: { kind: 'offer', sdp: offer } });
      } catch {
        /* a subsequent hello will retry */
      }
    }
  };

  const closePeer = (did: string): void => {
    const p = peers.get(did);
    if (!p) return;
    try {
      p.channel?.close();
    } catch {
      /* */
    }
    try {
      p.pc.close();
    } catch {
      /* */
    }
    peers.delete(did);
  };

  const dispose = bridge.onP2P((msg: InboundMsg) => {
    if (!msg || typeof msg.did !== 'string') return;
    const { did } = msg;
    if (msg.kind === 'close') {
      closePeer(did);
      return;
    }
    if (msg.kind === 'msg-out') {
      const ch = peers.get(did)?.channel;
      if (ch && ch.readyState === 'open' && msg.env) {
        try {
          ch.send(JSON.stringify(msg.env));
        } catch {
          /* channel raced closed */
        }
      }
      return;
    }
    if (msg.kind === 'signal-in') {
      void applySignal(did, msg.signal ?? {});
    }
  });

  const applySignal = async (did: string, sig: Signal): Promise<void> => {
    try {
      if (sig.kind === 'p2p-hello') {
        await makeOffer(did);
        return;
      }
      const p = peers.get(did);
      if (!p) return;
      if (sig.kind === 'answer' && sig.sdp) await p.pc.setRemoteDescription(sig.sdp);
      else if (sig.kind === 'candidate' && sig.candidate) await p.pc.addIceCandidate(sig.candidate);
    } catch {
      /* signaling races are tolerated; ICE restart / a fresh hello recovers */
    }
  };

  return () => {
    try {
      dispose?.();
    } catch {
      /* */
    }
    for (const did of [...peers.keys()]) closePeer(did);
  };
}
