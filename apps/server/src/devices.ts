/* Per-device presence + revocation for the relay.

   The relay used to track remotes as a single anonymous aggregate (one sticky
   name + an SSE count), so it could neither list nor disconnect an individual
   device. This registry gives every remote a stable identity (the client sends
   `x-maestro-device-id` / `?did=`), so the Mac can see each device and kick any
   one of them without touching the others.

   Pure + Fastify-free so it can be unit-tested. The only Node type it touches is
   `ServerResponse` (the live SSE handle it hands back to the caller to `.end()`). */

import type { ServerResponse } from 'node:http';

/** What the Mac's Devices pane renders, one per connected/recent device. */
export interface DeviceInfo {
  id: string;
  name: string | null;
  /** Has at least one open SSE stream right now. */
  live: boolean;
  /** ms epoch of the last authenticated activity. */
  lastSeen: number;
}

interface Entry {
  id: string;
  name: string | null;
  lastSeen: number;
  streams: Set<ServerResponse>;
}

export interface DeviceRegistryOptions {
  /** A device with no open stream and no activity within this window drops off list(). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Old clients that send no device id are bucketed here so they still appear as one device. */
export const LEGACY_DEVICE_ID = 'legacy';
/** Cap the revoked set so a long-lived relay can't grow it without bound. */
const MAX_REVOKED = 500;
const MAX_ID_LEN = 64;
const MAX_NAME_LEN = 40;

export class DeviceRegistry {
  private readonly devices = new Map<string, Entry>();
  private readonly revoked = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: DeviceRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Normalize a possibly-missing/oversized id; missing → the legacy bucket. */
  private key(id: string | null | undefined): string {
    const s = (id ?? '').trim();
    return s ? s.slice(0, MAX_ID_LEN) : LEGACY_DEVICE_ID;
  }

  private static clean(name: string | null | undefined): string | undefined {
    const s = (name ?? '').trim();
    return s ? s.slice(0, MAX_NAME_LEN) : undefined;
  }

  isRevoked(id: string | null | undefined): boolean {
    return this.revoked.has(this.key(id));
  }

  /** Record authenticated REST activity. No-op for a revoked device. */
  touch(id: string | null | undefined, name?: string | null): void {
    const key = this.key(id);
    if (this.revoked.has(key)) return;
    const name2 = DeviceRegistry.clean(name);
    const e = this.devices.get(key);
    if (e) {
      e.lastSeen = this.now();
      if (name2) e.name = name2;
    } else {
      this.devices.set(key, { id: key, name: name2 ?? null, lastSeen: this.now(), streams: new Set() });
    }
  }

  /** Register an open SSE stream. No-op for a revoked device (the auth hook 401s it first). */
  addStream(id: string | null | undefined, name: string | null | undefined, res: ServerResponse): void {
    const key = this.key(id);
    if (this.revoked.has(key)) return;
    const name2 = DeviceRegistry.clean(name);
    let e = this.devices.get(key);
    if (!e) {
      e = { id: key, name: name2 ?? null, lastSeen: this.now(), streams: new Set() };
      this.devices.set(key, e);
    } else {
      e.lastSeen = this.now();
      if (name2) e.name = name2;
    }
    e.streams.add(res);
  }

  removeStream(id: string | null | undefined, res: ServerResponse): void {
    const e = this.devices.get(this.key(id));
    if (!e) return;
    e.streams.delete(res);
    e.lastSeen = this.now();
  }

  /** Disconnect + revoke a device. Returns its open streams for the caller to `.end()`. */
  kick(id: string | null | undefined): ServerResponse[] {
    const key = this.key(id);
    const e = this.devices.get(key);
    this.devices.delete(key);
    this.revoked.add(key);
    if (this.revoked.size > MAX_REVOKED) {
      // Drop the oldest revocation (insertion order). Safe: re-paired devices mint a new id.
      const oldest = this.revoked.values().next().value;
      if (oldest !== undefined) this.revoked.delete(oldest);
    }
    return e ? [...e.streams] : [];
  }

  /** New pairing epoch (the code was regenerated): forget everything. */
  reset(): void {
    this.devices.clear();
    this.revoked.clear();
  }

  /** Drop devices with no open stream that haven't been seen within ttlMs. */
  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, e] of this.devices) {
      if (e.streams.size === 0 && e.lastSeen < cutoff) this.devices.delete(key);
    }
  }

  /** Current devices, most-recently-seen first. Prunes stale entries first. */
  list(): DeviceInfo[] {
    this.prune();
    return [...this.devices.values()]
      .map((e) => ({ id: e.id, name: e.name, live: e.streams.size > 0, lastSeen: e.lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Total open SSE streams across all devices. */
  get streamCount(): number {
    let n = 0;
    for (const e of this.devices.values()) n += e.streams.size;
    return n;
  }
}
