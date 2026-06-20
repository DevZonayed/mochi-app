/* Account session + active-host state for the mobile app.

   Replaces the old pairing-code model: the phone now signs in to an account on the
   server at API_BASE and controls one of the account's HOSTS (Macs) at a time.

   - The session token (Better Auth) is sent as `Authorization: Bearer <token>` on
     every /api/* request and as `?token=<token>` on the /ws/remote stream.
   - A stable per-install device id (`?did=` / `x-maestro-device-id`) identifies
     THIS phone so the account can list + manage it.
   - The "active host" is the device id of the Mac this phone is currently driving;
     ALL sync/commands/live-stream are scoped to it.

   Auth calls use raw `fetch` (no SDK). On a 200 sign-in/up the token arrives in the
   `set-auth-token` response header (and `body.token`); we persist whichever we get.

   Storage note: the app has no `expo-secure-store` dependency (and the task forbids
   adding one), so the token is persisted via the existing AsyncStorage-backed
   `storage.ts` layer — the same place the pairing token lived. Swap `getStr/setStr`
   here for SecureStore if/when that dependency is added. */

import { Platform } from 'react-native';
import { getStr, setStr, SESSION_TOKEN, ACTIVE_HOST, DEVICE_ID } from './storage';

export const API_BASE = 'https://api.nexalance.cloud';

/** A human label for this device, sent so the account can show "iPhone connected". */
export const DEVICE_NAME = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Web remote';
/** Coarse platform tag the server stores on the device row. */
export const DEVICE_PLATFORM = Platform.OS;

/* ── Session token ─────────────────────────────────────────────────────── */

let sessionToken = getStr(SESSION_TOKEN);
export function getSessionToken(): string { return sessionToken; }
export function setSessionToken(token: string): void {
  sessionToken = (token ?? '').trim();
  setStr(SESSION_TOKEN, sessionToken);
}
/** Re-read the token from storage after async hydration (see storage.hydrate). */
export function reloadSessionToken(): void { sessionToken = getStr(SESSION_TOKEN); }
export function isAuthed(): boolean { return !!sessionToken; }

/* ── Per-device identity ────────────────────────────────────────────────── */

function mintDeviceId(): string {
  return `dev-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
/** Stable id for THIS phone (minted once, persisted). Unlike the old pairing flow
    it is NOT rotated on sign-in — the account owns the device list across logins. */
export function getDeviceId(): string {
  let id = getStr(DEVICE_ID);
  if (!id) { id = mintDeviceId(); setStr(DEVICE_ID, id); }
  return id;
}

/* ── Active host (which Mac this phone controls) ────────────────────────── */

let activeHost = getStr(ACTIVE_HOST);
const hostSubs = new Set<() => void>();
export function getActiveHost(): string { return activeHost; }
export function reloadActiveHost(): void { activeHost = getStr(ACTIVE_HOST); }
/** Set (or clear, with '') the active host. Notifies subscribers so the live
    stream + screens re-scope. No-op when unchanged. */
export function setActiveHost(hostId: string): void {
  const next = (hostId ?? '').trim();
  if (next === activeHost) return;
  activeHost = next;
  setStr(ACTIVE_HOST, activeHost);
  for (const cb of hostSubs) { try { cb(); } catch { /* ignore broken listener */ } }
}
export function subscribeActiveHost(cb: () => void): () => void { hostSubs.add(cb); return () => { hostSubs.delete(cb); }; }

/* ── Auth API (raw fetch) ───────────────────────────────────────────────── */

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'AuthError'; }
}

/** Pull the token out of a Better Auth response — header first, then body. */
async function tokenFromResponse(res: Response): Promise<string> {
  const header = res.headers.get('set-auth-token');
  if (header) return header.trim();
  try {
    const body = (await res.clone().json()) as { token?: string };
    if (body?.token) return body.token.trim();
  } catch { /* non-JSON body */ }
  return '';
}

async function authPost(path: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText || 'Request failed';
    try {
      const j = (await res.clone().json()) as { message?: string; error?: string };
      detail = j?.message || j?.error || detail;
    } catch { /* non-JSON error */ }
    throw new AuthError(res.status, detail);
  }
  return res;
}

/** Create an account, then persist the returned session token. */
export async function signUp(input: { name: string; email: string; password: string }): Promise<void> {
  const res = await authPost('/api/auth/sign-up/email', { name: input.name, email: input.email, password: input.password });
  const token = await tokenFromResponse(res);
  if (!token) throw new AuthError(res.status, 'No session token returned by the server.');
  setSessionToken(token);
}

/** Sign in, then persist the returned session token. */
export async function signIn(input: { email: string; password: string }): Promise<void> {
  const res = await authPost('/api/auth/sign-in/email', { email: input.email, password: input.password });
  const token = await tokenFromResponse(res);
  if (!token) throw new AuthError(res.status, 'No session token returned by the server.');
  setSessionToken(token);
}

/** End the session on the server (best-effort) and clear local auth/host state. */
export async function signOut(): Promise<void> {
  const had = sessionToken;
  setSessionToken('');
  setActiveHost('');
  if (!had) return;
  try {
    await fetch(API_BASE + '/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${had}` },
      body: '{}',
    });
  } catch { /* network down — token is cleared locally anyway */ }
}
