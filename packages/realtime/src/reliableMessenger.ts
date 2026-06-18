import { makeEnvelope } from './envelope';
import type { Envelope, EnvelopeKind } from './envelope';
import type { ConnState } from './transport';

/** The slice of a transport/ConnectionManager the messenger drives. */
export interface MessengerConn {
  send(env: Envelope): void;
  onMessage(cb: (env: Envelope) => void): void;
  onStateChange(cb: (s: ConnState) => void): void;
}

export interface ReliableOptions {
  /** 0 disables the heartbeat. */
  heartbeatMs?: number;
  onDeliver?: (env: Envelope) => void;
  onState?: (s: ConnState) => void;
}

/** Kinds that must arrive: queued until acked, deduped on receipt. */
const RELIABLE: ReadonlySet<EnvelopeKind> = new Set<EnvelopeKind>(['cmd', 'result', 'event', 'hello']);

/**
 * Transport-agnostic guarantee layer: no silent loss (outbox flushes on
 * reconnect), no double-delivery (id dedupe), liveness (heartbeat). Sits above
 * the ConnectionManager so it protects both the P2P and relay paths.
 */
export class ReliableMessenger {
  private outbox = new Map<string, Envelope>();
  private seen = new Set<string>();
  private ready = false;
  private heartbeatMs: number;
  private hb: ReturnType<typeof setInterval> | null = null;
  private onDeliverCb: (env: Envelope) => void;
  private onStateCb: (s: ConnState) => void;

  constructor(private conn: MessengerConn, opts: ReliableOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    this.onDeliverCb = opts.onDeliver ?? (() => {});
    this.onStateCb = opts.onState ?? (() => {});
    this.conn.onStateChange((s) => this.onState(s));
    this.conn.onMessage((env) => this.receive(env));
  }

  send(env: Envelope): void {
    if (RELIABLE.has(env.kind)) this.outbox.set(env.id, env);
    this.trySend(env);
  }

  onDeliver(cb: (env: Envelope) => void): void {
    this.onDeliverCb = cb;
  }

  dispose(): void {
    this.stopHeartbeat();
  }

  private onState(s: ConnState): void {
    this.ready = s === 'connected';
    this.onStateCb(s);
    if (this.ready) {
      this.flush();
      this.startHeartbeat();
    } else {
      this.stopHeartbeat();
    }
  }

  private receive(env: Envelope): void {
    if (env.kind === 'ack') {
      this.outbox.delete(env.id);
      return;
    }
    if (env.kind === 'ping') {
      this.trySend(makeEnvelope('pong', undefined, env.id));
      return;
    }
    if (env.kind === 'pong') return;
    this.trySend(makeEnvelope('ack', undefined, env.id)); // acknowledge every reliable msg
    if (this.seen.has(env.id)) return; // dedupe a resend
    this.seen.add(env.id);
    this.onDeliverCb(env);
  }

  private flush(): void {
    if (!this.ready) return;
    for (const env of this.outbox.values()) this.trySend(env);
  }

  private trySend(env: Envelope): void {
    try {
      this.conn.send(env);
    } catch {
      /* stays in outbox; flushes on reconnect */
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.hb) return;
    this.hb = setInterval(() => this.trySend(makeEnvelope('ping')), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = null;
    }
  }
}
