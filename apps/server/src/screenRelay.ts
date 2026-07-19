/* screenRelay — Phase 3D1 ephemeral, in-memory, view-only screen-frame relay hub.
 *
 * This is deliberately NOT the durable path: frame bytes NEVER touch Postgres, the
 * Store, Redis, disk, or any log. The hub keeps opaque ciphertext in memory only,
 * routes a single host↔controller pair, and applies a LATEST-FRAME backpressure
 * policy (a queue of at most ONE pending frame per controller — a newer frame drops
 * the older, the buffer never grows). The relay cannot decrypt anything: control
 * messages are opaque JSON strings it forwards, frames are opaque binary it forwards
 * host→controller only. There is NO controller→host frame/input path here at all.
 *
 * The hub is transport-agnostic and pure w.r.t. IO: sockets are represented by an
 * injected `RelaySocket` (send / bufferedAmount / close), so it is fully unit
 * testable without a live WebSocket. `wsScreen.ts` wires real `ws` sockets to it. */

import { SHADOW_SCREEN_ENVELOPE_MAX_BYTES } from '@maestro/realtime/shadowScreenStream';

/** Max bytes a single relayed control (JSON) message may be. */
export const SCREEN_RELAY_MAX_CONTROL_BYTES = 8 * 1024;
/** Above this buffered amount we consider the controller socket backpressured and
 * hold only the LATEST frame in a single slot (drop stale). */
export const SCREEN_RELAY_HIGH_WATER_BYTES = 512 * 1024;
/** Idle (no frame + no control) timeout before the relay tears the pair down. */
export const SCREEN_RELAY_IDLE_MS = 30_000;
/** Absolute session cap (matches the protocol foreground TTL). */
export const SCREEN_RELAY_MAX_SESSION_MS = 15 * 60_000;
/** A valid placeholder stream id for relay-originated teardown notifications (the
 * relay never learns the real streamId — frames/control are opaque). */
export const SCREEN_RELAY_TEARDOWN_STREAM_ID = 'relay';

function stoppedStatusJson(now: number): string {
  return JSON.stringify({ kind: 'screen-status', v: 1, streamId: SCREEN_RELAY_TEARDOWN_STREAM_ID, status: 'stopped', reason: 'peer disconnected', at: now });
}
function stopControlJson(now: number): string {
  return JSON.stringify({ kind: 'screen-stop', v: 1, streamId: SCREEN_RELAY_TEARDOWN_STREAM_ID, reason: 'viewer disconnected', at: now });
}

export interface RelaySocket {
  send(data: string | Uint8Array, binary: boolean): void;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

interface ControllerSlot {
  deviceId: string;
  socket: RelaySocket;
  pending: Uint8Array | null; // single latest-frame slot
  sent: number;
  dropped: number;
  lastActiveAt: number;
}

interface Pair {
  host: RelaySocket | null;
  hostDeviceId: string | null;
  controller: ControllerSlot | null;
  createdAt: number;
}

export interface ScreenRelayMetricsSnapshot {
  pairs: number;
  controllers: number;
  framesRouted: number;
  framesDropped: number;
}

export type AttachControllerResult =
  | { ok: true }
  | { ok: false; reason: 'busy' };

/**
 * The routing core. One instance per server process. Keyed by `${accountId}:${hostId}`.
 */
export class ScreenRelayHub {
  private readonly pairs = new Map<string, Pair>();
  private framesRouted = 0;
  private framesDropped = 0;

  private pair(key: string, now: number): Pair {
    let p = this.pairs.get(key);
    if (!p) {
      p = { host: null, hostDeviceId: null, controller: null, createdAt: now };
      this.pairs.set(key, p);
    }
    return p;
  }

  /** A host attaches (or re-attaches, replacing a stale host socket). */
  attachHost(key: string, hostDeviceId: string, socket: RelaySocket, now: number): void {
    const p = this.pair(key, now);
    // Replace any prior host socket (a fresh connection supersedes a stale one).
    if (p.host && p.host !== socket) {
      try { p.host.close(1000, 'superseded'); } catch { /* */ }
    }
    p.host = socket;
    p.hostDeviceId = hostDeviceId;
    p.createdAt = now;
  }

  /**
   * A controller attaches as the SOLE viewer. If another controller already holds
   * the pair, the newcomer is rejected with `busy` (it never steals). Same-device
   * reconnect replaces its own slot.
   */
  attachController(key: string, deviceId: string, socket: RelaySocket, now: number): AttachControllerResult {
    const p = this.pair(key, now);
    if (p.controller && p.controller.deviceId !== deviceId) {
      return { ok: false, reason: 'busy' };
    }
    if (p.controller && p.controller.socket !== socket) {
      try { p.controller.socket.close(1000, 'superseded'); } catch { /* */ }
    }
    p.controller = { deviceId, socket, pending: null, sent: 0, dropped: 0, lastActiveAt: now };
    return { ok: true };
  }

  /** True iff a live host socket is present for the pair. */
  hasHost(key: string): boolean {
    return !!this.pairs.get(key)?.host;
  }

  activeControllerDeviceId(key: string): string | null {
    return this.pairs.get(key)?.controller?.deviceId ?? null;
  }

  /**
   * Route an opaque binary frame host→controller with latest-frame backpressure.
   * Returns `sent` / `dropped` / `rejected` (oversize or no controller).
   */
  routeFrame(key: string, frame: Uint8Array, now: number): 'sent' | 'dropped' | 'rejected' {
    if (frame.byteLength === 0 || frame.byteLength > SHADOW_SCREEN_ENVELOPE_MAX_BYTES) return 'rejected';
    const p = this.pairs.get(key);
    const c = p?.controller;
    if (!p || !c) return 'rejected';
    c.lastActiveAt = now;
    // First, opportunistically flush a previously-held pending frame if drained.
    this.tryFlush(c);
    if (c.socket.bufferedAmount() <= SCREEN_RELAY_HIGH_WATER_BYTES) {
      try { c.socket.send(frame, true); c.sent += 1; this.framesRouted += 1; return 'sent'; }
      catch { return 'rejected'; }
    }
    // Backpressured: keep only the latest, drop the older (queue never grows past 1).
    if (c.pending) { c.dropped += 1; this.framesDropped += 1; }
    c.pending = frame;
    return 'dropped';
  }

  private tryFlush(c: ControllerSlot): void {
    if (c.pending && c.socket.bufferedAmount() <= SCREEN_RELAY_HIGH_WATER_BYTES) {
      const f = c.pending;
      c.pending = null;
      try { c.socket.send(f, true); c.sent += 1; this.framesRouted += 1; } catch { /* dropped on send error */ }
    }
  }

  /** Forward an opaque control JSON string in the given direction. */
  routeControl(key: string, from: 'host' | 'controller', text: string, now: number): boolean {
    if (text.length > SCREEN_RELAY_MAX_CONTROL_BYTES) return false;
    const p = this.pairs.get(key);
    if (!p) return false;
    const target = from === 'host' ? p.controller?.socket : p.host;
    if (from === 'controller' && p.controller) p.controller.lastActiveAt = now;
    if (!target) return false;
    try { target.send(text, false); return true; } catch { return false; }
  }

  /** Detach a host socket (on disconnect). Notifies the controller (generic stopped)
   * + zeroes its held frame, then gcs. */
  detachHost(key: string, socket: RelaySocket, now = 0): void {
    const p = this.pairs.get(key);
    if (!p || p.host !== socket) return;
    p.host = null;
    p.hostDeviceId = null;
    if (p.controller) {
      p.controller.pending = null; // zero any held frame
      try { p.controller.socket.send(stoppedStatusJson(now), false); } catch { /* */ }
    }
    this.gc(key);
  }

  /** Detach a controller socket (on disconnect). Notifies the host (viewer gone) so
   * it stops capturing, and zeroes its frame buffer. */
  detachController(key: string, deviceId: string, now = 0): void {
    const p = this.pairs.get(key);
    if (!p || p.controller?.deviceId !== deviceId) return;
    p.controller.pending = null;
    p.controller = null;
    if (p.host) { try { p.host.send(stopControlJson(now), false); } catch { /* */ } }
    this.gc(key);
  }

  /** Expire idle / over-age pairs. Call periodically. Returns keys torn down. */
  sweep(now: number): string[] {
    const dead: string[] = [];
    for (const [key, p] of this.pairs) {
      const overAge = now - p.createdAt > SCREEN_RELAY_MAX_SESSION_MS;
      const idle = p.controller ? now - p.controller.lastActiveAt > SCREEN_RELAY_IDLE_MS : false;
      if (overAge || idle) {
        try { p.host?.close(1000, 'expired'); } catch { /* */ }
        try { p.controller?.socket.close(1000, 'expired'); } catch { /* */ }
        if (p.controller) p.controller.pending = null;
        this.pairs.delete(key);
        dead.push(key);
      }
    }
    return dead;
  }

  private gc(key: string): void {
    const p = this.pairs.get(key);
    if (p && !p.host && !p.controller) this.pairs.delete(key);
  }

  metrics(): ScreenRelayMetricsSnapshot {
    let controllers = 0;
    for (const p of this.pairs.values()) if (p.controller) controllers += 1;
    return { pairs: this.pairs.size, controllers, framesRouted: this.framesRouted, framesDropped: this.framesDropped };
  }

  controllerStats(key: string): { sent: number; dropped: number } | null {
    const c = this.pairs.get(key)?.controller;
    return c ? { sent: c.sent, dropped: c.dropped } : null;
  }
}

/** The process-wide singleton (mirrors routing.ts's in-memory `pending` map). */
export const screenRelayHub = new ScreenRelayHub();
