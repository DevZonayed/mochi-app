/* Closed-app push for the account multi-tenant server.

   The mobile app's in-app banner + chime (LiveNotifier) only fires while the JS
   runtime is alive. Once the OS kills/swaps the app the SSE WebSocket goes with
   it, and the user stops hearing about job completions, failed runs, and
   pending approvals. This module mirrors those alert-worthy host events to
   Expo's push service so a closed app still gets a real OS notification.

   Architecture (account model, not the legacy per-deck server.ts):
   - Each remote device stores its Expo push token on its `device` row
     (see migration 0002_push_token.ts). Postgres, not in-memory, so the token
     survives instance restart AND every stateless server instance can see it.
   - When a Mac (host) publishes an event via wsHost.ts → routing.publishEvent,
     wsHost.ts also calls `maybePush(hostId, name, data)`. We look up which
     account owns this host, gather every remote device's push_token in that
     account, and POST to Expo's batch API.
   - Token cleanup: Expo's batch reply lists DeviceNotRegistered tokens. We
     null them in the device row so future events don't keep trying.

   This is intentionally minimal — no per-channel preferences, no analytics —
   matching the existing LiveNotifier's "loud on completion/failure/approval"
   shape. If the operator wants finer control we layer it on top later. */
import { getDb } from './db.js';

/** What lands in Expo's `data` field so a notification tap can deep-link the
    phone to the right session chat (or Approvals when no session applies). The
    mobile pushNav.ts reader expects this exact shape. Capped at <4KB by Expo. */
export interface PushNavData {
  kind: 'job-done' | 'job-failed' | 'approval' | 'schedule-late';
  projectId?: string;
  sessionId?: string;
  jobId?: string;
  approvalId?: string;
}

/* ── Token storage on the device row ──────────────────────────────────────── */

/** Persist a remote device's Expo push token.

    Upserts the device row: on first sign-in the phone calls this BEFORE its
    WS ever connects (the WS is gated on having picked an active host), so
    wsRemote.upsertDevice hasn't run yet and a plain UPDATE would silently
    match 0 rows and drop the token forever. We insert the device with the
    metadata the request already carries (name + platform from headers) so
    the row is ready by the time the WS connects (which will then UPDATE the
    same row with fresher last_seen_at).

    Idempotent: re-registering the same token just touches updated_at. The
    `(id, user_id)` pair is the natural key — same device id under a
    different account is a different device. Returns true on success. */
export async function registerPushToken(
  userId: string,
  deviceId: string,
  token: string,
  name: string,
  platform: string,
): Promise<boolean> {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const now = new Date();
  await getDb()
    .insertInto('device')
    .values({
      id: deviceId,
      user_id: userId,
      role: 'remote',
      name: name || 'Remote',
      platform: platform || 'unknown',
      deck_id: null,
      push_token: trimmed,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      // Only refresh the token + audit timestamps. Do NOT clobber role/name/
      // platform — wsRemote/wsHost own those, and stamping role='remote' over
      // a 'host' row (shouldn't happen — different ids — but defensive) would
      // break routing. The user_id guard in the WHERE is enforced by the
      // implicit `(id) PK` conflict target — a row owned by another account
      // would conflict on id, and our `where` clause filters it out.
      oc.column('id').doUpdateSet((eb) => ({
        push_token: trimmed,
        updated_at: now,
      })).where('device.user_id', '=', userId),
    )
    .execute();
  return true;
}

/** Drop this device's push token (sign-out / unpair). Same scoping rules. */
export async function unregisterPushToken(userId: string, deviceId: string): Promise<boolean> {
  const res = await getDb()
    .updateTable('device')
    .set({ push_token: null, updated_at: new Date() })
    .where('id', '=', deviceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return (res.numUpdatedRows ?? 0n) > 0n;
}

/** Every push token belonging to an account's REMOTE devices (a host's own
    token, if it ever got one, is intentionally excluded — we never push back
    to the Mac itself). */
export async function tokensForAccount(userId: string): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('device')
    .select(['push_token'])
    .where('user_id', '=', userId)
    .where('role', '=', 'remote')
    .where('push_token', 'is not', null)
    .execute();
  return rows.map((r) => r.push_token).filter((t): t is string => !!t);
}

/** Resolve the account that owns a host id, or null if the host is gone or
    cross-account. Used to scope maybePush() — events for host X only fan out
    to the account that owns X. */
async function accountForHost(hostId: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom('device')
    .select(['user_id'])
    .where('id', '=', hostId)
    .where('role', '=', 'host')
    .executeTakeFirst();
  return row?.user_id ?? null;
}

/** Best-effort fetch of a job in this host's mirrored snapshot so an approval
    push can carry sessionId for deep-linking. Returns null when the snapshot is
    cold (no recent state frame yet) — the push still goes out with whatever it
    had, just without the sessionId enrichment. */
async function jobFromSnapshot(hostId: string, jobId: string): Promise<{ projectId?: string; sessionId?: string } | null> {
  // Lazy import keeps this module testable without redis.
  const { getSnapshot } = await import('./redis.js');
  const snap = (await getSnapshot(hostId)) as { jobs?: { id?: string; projectId?: string; sessionId?: string }[] } | null;
  const job = snap?.jobs?.find((j) => j.id === jobId);
  return job ? { projectId: job.projectId, sessionId: job.sessionId } : null;
}

/* ── Expo push API ─────────────────────────────────────────────────────────── */

/** Drop tokens that Expo reports as gone (DeviceNotRegistered) so we don't keep
    re-trying them on every future event. */
async function pruneToken(token: string): Promise<void> {
  try {
    await getDb()
      .updateTable('device')
      .set({ push_token: null, updated_at: new Date() })
      .where('push_token', '=', token)
      .executeTakeFirst();
  } catch { /* db hiccup — next push retries pruning */ }
}

/** Override hook for tests so we can capture push fan-out without hitting
    Expo. Production code always goes through `fetch`. */
export type ExpoFetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ json: () => Promise<unknown> }>;
let fetcher: ExpoFetcher | null = null;
/** @internal — only the unit tests should set this. */
export function setExpoFetcherForTests(f: ExpoFetcher | null): void { fetcher = f; }

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  priority: 'high';
  channelId: 'alerts';
  data?: PushNavData;
}

/** POST to Expo's batch push API. Caps at 100 messages/request (the documented
    limit); we batch in case a single account has more than 100 remotes (in
    practice 1-3). Silently swallows network failures — push best-effort, the
    SSE banner is the source of truth for the foreground app. */
async function sendExpoPush(tokens: string[], title: string, body: string, data?: PushNavData): Promise<void> {
  if (!tokens.length) return;
  const messages: ExpoMessage[] = tokens.map((to) => ({ to, title, body, sound: 'default', priority: 'high', channelId: 'alerts', ...(data ? { data } : {}) }));
  // Chunk to 100 per Expo's documented batch ceiling.
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await (fetcher ?? defaultFetch)('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(chunk),
      });
      const json = (await res.json().catch(() => null)) as { data?: { status?: string; details?: { error?: string } }[] } | null;
      if (Array.isArray(json?.data)) {
        await Promise.all(json!.data!.map((r, idx) => {
          if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') return pruneToken(chunk[idx].to);
          return Promise.resolve();
        }));
      }
    } catch { /* Expo unreachable — SSE still carries the foreground alert */ }
  }
}

const defaultFetch: ExpoFetcher = async (url, init) => {
  // Node 18+ has global fetch.
  const res = await fetch(url, init);
  return { json: () => res.json() as Promise<unknown> };
};

/* ── Dedupe — never push the same event twice ─────────────────────────────── */

/** Many event sources can re-emit the same `job:done` (the Mac retries, a
    redis pub/sub replay, a transient reconnect). A small in-memory key TTL
    cache makes maybePush idempotent within a 5-minute window — far longer
    than any legitimate burst, far shorter than risking a missed re-fire after
    a long pause. Keyed by `<hostId>:<event-specific-id>` so two accounts
    sharing a phone (rare) never collide. */
const pushedKeys = new Map<string, number>();
const PUSH_DEDUPE_TTL_MS = 5 * 60 * 1000;
function rememberPushKey(key: string): boolean {
  const now = Date.now();
  // Sweep expired entries opportunistically (cheap when the map is small).
  if (pushedKeys.size > 256) {
    for (const [k, ts] of pushedKeys) if (now - ts > PUSH_DEDUPE_TTL_MS) pushedKeys.delete(k);
  }
  const prev = pushedKeys.get(key);
  if (prev !== undefined && now - prev < PUSH_DEDUPE_TTL_MS) return false;
  pushedKeys.set(key, now);
  return true;
}
/** @internal — only the unit tests should reach in here. */
export function _resetDedupeForTests(): void { pushedKeys.clear(); }

/* ── The fan-out entry point ──────────────────────────────────────────────── */

/** Mirror an alert-worthy host event to every remote device's Expo push token.
    Called from wsHost.ts right after publishEvent. Silent no-op for events
    that aren't alert-worthy (state pings, non-terminal job updates), so the
    caller can fire-and-forget on every event without filtering itself. */
export async function maybePush(hostId: string, name: string, data: unknown): Promise<void> {
  // Cheap pre-checks before any DB work.
  if (name !== 'job' && name !== 'approval' && name !== 'schedule-late') return;

  // Decide whether THIS specific payload is alert-worthy. Job updates fire on
  // every progress tick — we only want the terminal transitions.
  let title = '';
  let body = '';
  let dedupeKey = '';
  let nav: PushNavData | null = null;

  if (name === 'job') {
    const j = data as { id?: string; status?: string; title?: string; projectId?: string; sessionId?: string } | null;
    if (!j?.id) return;
    const base = { projectId: j.projectId, sessionId: j.sessionId, jobId: j.id };
    if (j.status === 'done') {
      title = 'Conversation complete';
      body = j.title || 'A run finished on your Mac.';
      dedupeKey = `${hostId}:${j.id}:done`;
      nav = { kind: 'job-done', ...base };
    } else if (j.status === 'failed') {
      title = 'Job failed';
      body = j.title || 'A run failed on your Mac.';
      dedupeKey = `${hostId}:${j.id}:failed`;
      nav = { kind: 'job-failed', ...base };
    } else {
      return; // running/pending/cancelled — not push-worthy
    }
  } else if (name === 'approval') {
    const a = data as { id?: string; status?: string; title?: string; projectId?: string | null; jobId?: string | null } | null;
    if (!a?.id || a.status !== 'pending') return;
    title = 'Needs your attention';
    body = a.title || 'An approval is waiting.';
    dedupeKey = `${hostId}:appr:${a.id}`;
    // Approval payloads carry projectId + jobId but no direct sessionId — try
    // to recover it from the host's mirrored snapshot so the tap lands on the
    // originating chat (falls back to the Approvals tab if we don't have it).
    const enriched = a.jobId ? await jobFromSnapshot(hostId, a.jobId).catch(() => null) : null;
    nav = {
      kind: 'approval',
      approvalId: a.id,
      projectId: a.projectId ?? enriched?.projectId ?? undefined,
      sessionId: enriched?.sessionId,
      jobId: a.jobId ?? undefined,
    };
  } else if (name === 'schedule-late') {
    const s = data as { id?: string; title?: string; firedAt?: number; projectId?: string; sessionId?: string } | null;
    title = 'Scheduled task ran late';
    body = s?.title ? `“${s.title}” caught up.` : 'A schedule caught up after a missed time.';
    dedupeKey = `${hostId}:late:${s?.id ?? ''}:${s?.firedAt ?? ''}`;
    nav = { kind: 'schedule-late', projectId: s?.projectId, sessionId: s?.sessionId };
  }

  if (!rememberPushKey(dedupeKey)) return;

  // Only NOW do we hit the DB — dedupe and trigger filtering above keep the
  // common case (most events are not push-worthy) cheap.
  const userId = await accountForHost(hostId).catch(() => null);
  if (!userId) return;
  const tokens = await tokensForAccount(userId).catch(() => [] as string[]);
  if (!tokens.length) return;
  await sendExpoPush(tokens, title, body, nav ?? undefined);
}
