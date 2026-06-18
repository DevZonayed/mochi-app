import type { Transport, ConnState } from './transport';
import type { Envelope } from './envelope';

export type ActiveKind = 'p2p' | 'relay' | null;

export interface ConnectionManagerOptions {
  /** Returns an already-starting P2P transport. */
  makeP2P: () => Transport;
  /** Returns the relay transport (wraps the existing relay client). */
  makeRelay: () => Transport;
  /** How long to wait for P2P to reach `connected` before falling back. */
  p2pTimeoutMs?: number;
}

/**
 * Prefers a direct P2P transport; falls back to the relay if P2P can't reach
 * `connected` within the timeout. The active transport's messages and state
 * forward to the manager's subscribers, so the app sees one stable seam.
 */
export class ConnectionManager {
  private makeP2P: () => Transport;
  private makeRelay: () => Transport;
  private p2pTimeoutMs: number;
  private active: Transport | null = null;
  private activeKind: ActiveKind = null;
  private onMessageCb: (env: Envelope) => void = () => {};
  private onStateCb: (s: ConnState) => void = () => {};

  constructor(opts: ConnectionManagerOptions) {
    this.makeP2P = opts.makeP2P;
    this.makeRelay = opts.makeRelay;
    this.p2pTimeoutMs = opts.p2pTimeoutMs ?? 8000;
  }

  async connect(): Promise<ActiveKind> {
    const p2p = this.makeP2P();
    if (await this.race(p2p)) {
      this.active = p2p;
      this.activeKind = 'p2p';
      return 'p2p';
    }
    try {
      p2p.close();
    } catch {
      /* already gone */
    }
    const relay = this.makeRelay();
    this.wire(relay);
    this.active = relay;
    this.activeKind = 'relay';
    return 'relay';
  }

  private wire(t: Transport): void {
    t.onMessage((m) => this.onMessageCb(m));
    t.onStateChange((s) => this.onStateCb(s));
  }

  /** Resolve true if `t` reaches (or already is) `connected` within the timeout. */
  private race(t: Transport): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const timer = setTimeout(() => finish(false), this.p2pTimeoutMs);
      t.onMessage((m) => this.onMessageCb(m));
      t.onStateChange((s) => {
        this.onStateCb(s);
        if (s === 'connected') {
          clearTimeout(timer);
          finish(true);
        }
      });
      if (t.isReady()) {
        clearTimeout(timer);
        finish(true);
      }
    });
  }

  send(env: Envelope): void {
    this.active?.send(env);
  }
  isReady(): boolean {
    return this.active?.isReady() ?? false;
  }
  onMessage(cb: (env: Envelope) => void): void {
    this.onMessageCb = cb;
  }
  onStateChange(cb: (s: ConnState) => void): void {
    this.onStateCb = cb;
  }
  get kind(): ActiveKind {
    return this.activeKind;
  }
  close(): void {
    try {
      this.active?.close();
    } catch {
      /* */
    }
    this.active = null;
    this.activeKind = null;
  }
}
