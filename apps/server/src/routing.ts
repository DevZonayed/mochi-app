/* Cross-instance command/event/signal bridge over Redis pub/sub.

   A remote's command for a host is published on `cmd:host:<hostId>`; whichever
   instance holds that host's WS delivers it and publishes the host's reply on the
   shared `result:cmd` channel; the instance that issued the command (and holds the
   pending promise) resolves it. EVERY command is bounded by a timeout — a dead or
   half-open host yields a fast 504, never an infinite hang (the original bug). */
import { publish, subscribe, isOnline } from './redis.js';
import { assertHostInAccount } from './accountDevices.js';

export const CMD_TIMEOUT_MS = Number(process.env.CMD_TIMEOUT_MS) || 10 * 60 * 1000;

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }
const pending = new Map<string, Pending>();

let seq = 0;
function newCmdId(): string { return `cmd-${Date.now()}-${(seq = (seq + 1) % 1e6)}-${Math.round(Math.random() * 1e6)}`; }

let resultSubReady = false;
function ensureResultSub(): void {
  if (resultSubReady) return;
  resultSubReady = true;
  subscribe('result:cmd', (raw) => {
    const m = raw as { cmdId?: string; ok?: boolean; result?: unknown; error?: string; statusCode?: number };
    if (!m.cmdId) return;
    const p = pending.get(m.cmdId);
    if (!p) return; // another instance owns this command
    clearTimeout(p.timer);
    pending.delete(m.cmdId);
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error ?? 'host error'), { statusCode: m.statusCode ?? 500 }));
  });
}

/** Forward a command to a host the caller owns, awaiting the host's reply.
    Rejects {statusCode:404} cross-account, {503} host offline, {504} on timeout. */
export async function forwardCommand(
  userId: string,
  hostId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = CMD_TIMEOUT_MS,
): Promise<unknown> {
  await assertHostInAccount(userId, hostId);
  if (!(await isOnline(hostId))) {
    throw Object.assign(new Error('Your Mac is offline'), { statusCode: 503 });
  }
  ensureResultSub();
  const cmdId = newCmdId();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(cmdId);
      reject(Object.assign(new Error('Your Mac did not respond in time'), { statusCode: 504 }));
    }, timeoutMs);
    pending.set(cmdId, { resolve, reject, timer });
    void publish(`cmd:host:${hostId}`, { cmdId, method, params });
  });
}

/** Called by the instance holding a host's WS when the host replies to a command. */
export function submitResult(cmdId: string, ok: boolean, result?: unknown, error?: string, statusCode?: number): void {
  void publish('result:cmd', { cmdId, ok, result, error, statusCode });
}

/** Host→remote event fan-out for an account's active-host subscribers. */
export function publishEvent(hostId: string, name: string, data: unknown): void {
  void publish(`events:host:${hostId}`, { name, data });
}

/** WebRTC signaling to one device (offer/answer/ICE). */
export function publishSignal(toDeviceId: string, fromDeviceId: string, signal: unknown): void {
  void publish(`signal:device:${toDeviceId}`, { fromDeviceId, signal });
}
