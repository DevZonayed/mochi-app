/* Closed-app push notifications via Expo's push service.

   The phone (mobile/src/push.ts) mints an Expo push token at launch and POSTs
   it to /api/push/register. Tokens are stored per ACCOUNT (not per device or
   per host) so when ANY of the user's Macs publishes an alert-worthy event,
   ALL of their phones get a notification — even with the app fully closed.

   The store lives in Redis (key: `push:user:<userId>`), so the N-instance
   stateless server keeps working: whichever instance holds the host's WS reads
   the tokens and POSTs to exp.host. Cross-instance dedupe uses `SET NX EX` on
   a per-event key so a brief reconnect that re-fires the same `job:done` event
   doesn't double-buzz the phone.

   This module DOES NOT depend on the deprecated pairing-deck server.ts — that
   file is dead code (apps/server/src/index.ts boots accountServer.ts). Until
   this module existed, /api/push/register was a 404 on the live relay and no
   host event ever reached Expo, which is why a closed app got nothing while
   the in-app SSE-driven banner kept working. */
import { sAdd, sRem, sMembers, sCard, setNxEx } from './redis.js';

/** Payload the mobile push-tap handler (mobile/src/pushNav.ts) reads to deep-
    link the right session chat (or Approvals when no session applies). Keep
    small — Expo caps push data at 4KB. */
export interface PushNavData {
  kind: 'job-done' | 'job-failed' | 'approval' | 'schedule-late';
  hostId?: string;          // so the phone can switch active host on tap
  projectId?: string;
  sessionId?: string;
  jobId?: string;
  approvalId?: string;
}

/** One Expo push message (shape mirrors exp.host's /api/v2/push/send). */
interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound?: 'default';
  priority?: 'high';
  channelId?: string;
  data?: PushNavData;
}

interface ExpoReceipt { status?: 'ok' | 'error'; details?: { error?: string } }
interface ExpoResponse { data?: ExpoReceipt[] }

const EXPO_PUSH_URL = process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
/** Dedupe TTL — long enough to catch a brief WS reconnect re-emitting the same
    job-done event, short enough that the same job id reused months later still
    pushes. 1h matches the old pairing server. */
const DEDUPE_TTL_SEC = 3600;

/** Swappable HTTP transport so tests can capture pushes without hitting exp.host.
    Defaults to global fetch in production; setPushTransport(spy) overrides it. */
let pushTransport: typeof fetch = (...a) => fetch(...a);
export function setPushTransport(impl: typeof fetch): () => void {
  const prev = pushTransport;
  pushTransport = impl;
  return () => { pushTransport = prev; };
}

function tokenKey(userId: string): string { return `push:user:${userId}`; }
function dedupeKey(userId: string, k: string): string { return `push:dedupe:${userId}:${k}`; }

/** Register (or refresh) one Expo push token under this account. Idempotent. */
export async function addPushToken(userId: string, token: string): Promise<number> {
  const t = (token ?? '').trim();
  if (!userId || !t) return await tokenCount(userId);
  await sAdd(tokenKey(userId), t);
  return tokenCount(userId);
}

/** Drop a token (called on sign-out / unpair, or after Expo says it's dead). */
export async function removePushToken(userId: string, token: string): Promise<number> {
  const t = (token ?? '').trim();
  if (!userId || !t) return tokenCount(userId);
  await sRem(tokenKey(userId), t);
  return tokenCount(userId);
}

/** Tokens currently registered for this account (any number of phones). */
export async function listPushTokens(userId: string): Promise<string[]> {
  if (!userId) return [];
  return sMembers(tokenKey(userId));
}

export async function tokenCount(userId: string): Promise<number> {
  if (!userId) return 0;
  return sCard(tokenKey(userId));
}

/* ── Expo HTTP sender ─────────────────────────────────────────────────── */

/** Low-level: POST one batch to Expo and prune any token Expo says is gone.
    Goes through the module-level pushTransport so tests can intercept it. */
export async function sendExpoPush(
  userId: string,
  tokens: string[],
  title: string,
  body: string,
  data?: PushNavData,
): Promise<void> {
  if (!tokens.length) return;
  const messages: ExpoMessage[] = tokens.map((to) => ({
    to,
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'alerts',
    ...(data ? { data } : {}),
  }));
  let json: ExpoResponse | null = null;
  try {
    const res = await pushTransport(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    json = (await res.json().catch(() => null)) as ExpoResponse | null;
  } catch {
    /* Expo unreachable — the in-app SSE banner still carries the open-app alert */
    return;
  }
  // Expo returns per-message receipts; prune any token it reports as dead so we
  // don't keep buzzing a phone that uninstalled.
  if (Array.isArray(json?.data)) {
    await Promise.all(
      json!.data!.map(async (r, i) => {
        if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
          await removePushToken(userId, tokens[i]);
        }
      }),
    );
  }
}

/* ── Event → push mapping (matches the phone's in-app LiveNotifier) ───── */

interface JobEvent  { id?: string; status?: string; title?: string; projectId?: string; sessionId?: string }
interface ApprovalEvent { id?: string; status?: string; title?: string; projectId?: string | null; jobId?: string | null; sessionId?: string }
interface ScheduleLateEvent { id?: string; title?: string; firedAt?: number; projectId?: string; sessionId?: string }

/** Mirror one host event into Expo push, but ONLY for the alert-worthy events
    the phone's LiveNotifier reacts to in-app (`job:done`, `job:failed`,
    `approval:pending`, `schedule-late`). Everything else is silent (the OS
    notification tray would get unmanageable otherwise).

    Returns `true` if a push was actually dispatched (used by tests). Never
    throws — push is best-effort, in-app SSE is the source of truth. */
export async function maybePush(
  userId: string,
  hostId: string,
  name: string,
  raw: unknown,
): Promise<boolean> {
  if (!userId) return false;
  const tokens = await listPushTokens(userId);
  if (!tokens.length) return false;

  let title = '';
  let body = '';
  let nav: PushNavData | null = null;
  let dedupe = '';

  if (name === 'job') {
    const j = (raw ?? {}) as JobEvent;
    if (!j.id) return false;
    const base = { hostId, projectId: j.projectId, sessionId: j.sessionId, jobId: j.id };
    if (j.status === 'done') {
      title = 'Conversation complete';
      body  = j.title || 'A run finished on your Mac.';
      nav   = { kind: 'job-done', ...base };
      dedupe = `job:${j.id}:done`;
    } else if (j.status === 'failed') {
      title = 'Job failed';
      body  = j.title || 'A run failed on your Mac.';
      nav   = { kind: 'job-failed', ...base };
      dedupe = `job:${j.id}:failed`;
    } else {
      return false; // other statuses (running/queued/…) aren't alert-worthy
    }
  } else if (name === 'approval') {
    const a = (raw ?? {}) as ApprovalEvent;
    if (!a.id || a.status !== 'pending') return false;
    title = 'Needs your attention';
    body  = a.title || 'An approval is waiting.';
    nav   = {
      kind: 'approval',
      hostId,
      approvalId: a.id,
      projectId: a.projectId ?? undefined,
      sessionId: a.sessionId,
      jobId: a.jobId ?? undefined,
    };
    dedupe = `approval:${a.id}`;
  } else if (name === 'schedule-late') {
    const s = (raw ?? {}) as ScheduleLateEvent;
    title = 'Scheduled task ran late';
    body  = s.title ? `“${s.title}” caught up.` : 'A schedule caught up after a missed time.';
    nav   = { kind: 'schedule-late', hostId, projectId: s.projectId, sessionId: s.sessionId };
    dedupe = `late:${s.id ?? ''}:${s.firedAt ?? ''}`;
  } else {
    return false;
  }

  // Cross-instance dedupe — a brief WS reconnect that re-publishes the same
  // event must not double-buzz the phones. setNxEx returns false on duplicate.
  if (!(await setNxEx(dedupeKey(userId, dedupe), '1', DEDUPE_TTL_SEC))) return false;

  await sendExpoPush(userId, tokens, title, body, nav ?? undefined);
  return true;
}
