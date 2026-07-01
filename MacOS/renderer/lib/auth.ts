/* Account auth for the desktop app.

   The Maestro desktop now connects to an account-based server (Better Auth) at
   API_BASE. The renderer owns the session: it signs in / registers over raw
   fetch, reads the session token from the `set-auth-token` response header
   (falling back to the JSON body's `token`), persists it in localStorage, and
   pushes it down to the MAIN process over IPC so the host WebSocket can
   authenticate (`Authorization: Bearer <token>` on REST, `?token=<token>` on the
   WS). The Mac stays the brain — this only gates WHO the Mac mirrors to. */

import { API_BASE } from './api';

const SESSION_KEY = 'maestro.session';

/** The small bridge the preload exposes (a superset of the api.ts Bridge). */
interface SessionBridge { setSession?: (token: string | null) => void }
const bridge: SessionBridge | undefined =
  typeof window !== 'undefined' ? (window as unknown as { maestro?: SessionBridge }).maestro : undefined;

/** Read the persisted session token (empty string when signed out). */
export function getSessionToken(): string {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; }
}

/** True once the operator has a stored session (the app is unlocked). */
export function hasSession(): boolean { return getSessionToken().length > 0; }

/** Persist the token locally AND push it to the main process so the host
    connection (re)starts with it. Pass '' to sign out (closes the host WS). */
function setSessionToken(token: string): void {
  const t = token.trim();
  try {
    if (t) localStorage.setItem(SESSION_KEY, t);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage unavailable — the in-memory push below still works */ }
  try { bridge?.setSession?.(t || null); } catch { /* main not ready */ }
}

/** Re-push the stored token to main on app launch so the host connects without
    forcing a re-login. No-op when signed out. Call once at startup. */
export function primeSession(): void {
  const t = getSessionToken();
  if (t) { try { bridge?.setSession?.(t); } catch { /* main not ready */ } }
}

/** A small set of auth-session change listeners so the gate re-renders on
    login / logout from anywhere (e.g. Settings → Sign out). */
const listeners = new Set<() => void>();
export function onAuthChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function notify(): void { for (const cb of listeners) { try { cb(); } catch { /* ignore */ } } }

/** Pull the session token out of a Better Auth response: the `set-auth-token`
    header is authoritative; fall back to the JSON body's `token`. */
function tokenFromResponse(res: Response, body: unknown): string {
  const header = res.headers.get('set-auth-token');
  if (header) return header.trim();
  const t = (body as { token?: unknown })?.token;
  return typeof t === 'string' ? t.trim() : '';
}

async function authPost(path: string, payload: Record<string, unknown>): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* some endpoints (sign-out) return no/empty body */ }
  return { res, body };
}

/** Turn a non-200 auth response into a human message. */
function authError(res: Response, body: unknown): Error {
  const msg = (body as { message?: string; error?: string })?.message
    ?? (body as { error?: string })?.error
    ?? (res.status === 401 ? 'Incorrect email or password.' : `Sign-in failed (${res.status}).`);
  return new Error(msg);
}

export interface Credentials { email: string; password: string }

/** Register a new account, then store the returned session. */
export async function signUp(input: { name: string } & Credentials): Promise<void> {
  const { res, body } = await authPost('/api/auth/sign-up/email', {
    name: input.name.trim(), email: input.email.trim(), password: input.password,
  });
  if (!res.ok) throw authError(res, body);
  const token = tokenFromResponse(res, body);
  if (!token) throw new Error('Account created but no session was returned — try signing in.');
  setSessionToken(token);
  notify();
}

/** Sign in with email + password and store the returned session. */
export async function signIn(input: Credentials): Promise<void> {
  const { res, body } = await authPost('/api/auth/sign-in/email', {
    email: input.email.trim(), password: input.password,
  });
  if (!res.ok) throw authError(res, body);
  const token = tokenFromResponse(res, body);
  if (!token) throw new Error('Signed in but no session token was returned.');
  setSessionToken(token);
  notify();
}

/** Sign out: tell the server (best-effort), then clear the local session +
    close the host connection. Always clears locally even if the call fails. */
export async function signOut(): Promise<void> {
  const token = getSessionToken();
  try {
    await fetch(API_BASE + '/api/auth/sign-out', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch { /* offline — drop the session locally anyway */ }
  setSessionToken('');
  notify();
}
