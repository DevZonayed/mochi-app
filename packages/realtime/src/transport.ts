import type { Envelope } from './envelope';

export type ConnState =
  | 'connecting'
  | 'connected'
  | 'unstable'
  | 'reconnecting'
  | 'disconnected';

/**
 * The single seam the app talks to. Both the WebRTC peer and the existing
 * relay implement this, so application code never branches on "P2P vs relay".
 */
export interface Transport {
  send(env: Envelope): void;
  isReady(): boolean;
  onMessage(cb: (env: Envelope) => void): void;
  onStateChange(cb: (s: ConnState) => void): void;
  close(): void;
}
