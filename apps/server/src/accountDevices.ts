/* Account-scoped device registry. Every read is filtered by user_id, so an
   account can only ever see or target its own devices — the isolation guarantee.
   (Replaces the per-deck DeviceRegistry in devices.ts during the cutover.) */
import { getDb, type DeviceTable } from './db.js';
import { isOnline } from './redis.js';

export interface UpsertDeviceInput {
  id: string;
  userId: string;
  role: 'host' | 'remote';
  name: string;
  platform: string;
  deckId?: string | null;
}

export interface DeviceView {
  id: string;
  role: 'host' | 'remote';
  name: string;
  platform: string;
  deckId: string | null;
  online: boolean;
  lastSeen: number;
}

export async function upsertDevice(input: UpsertDeviceInput): Promise<void> {
  const now = new Date();
  await getDb()
    .insertInto('device')
    .values({
      id: input.id,
      user_id: input.userId,
      role: input.role,
      name: input.name,
      platform: input.platform,
      deck_id: input.deckId ?? null,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        user_id: input.userId,
        role: input.role,
        name: input.name,
        platform: input.platform,
        deck_id: input.deckId ?? null,
        last_seen_at: now,
        updated_at: now,
      }),
    )
    .execute();
}

export async function listDevicesForUser(userId: string): Promise<DeviceView[]> {
  const rows = await getDb()
    .selectFrom('device')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      role: r.role,
      name: r.name,
      platform: r.platform,
      deckId: r.deck_id,
      online: await isOnline(r.id),
      lastSeen: new Date(r.last_seen_at).getTime(),
    })),
  );
}

/** Resolve a host that MUST belong to this account, else throw 404 (never reveal
    another account's devices). Used by every routing path. */
export async function assertHostInAccount(userId: string, hostId: string): Promise<DeviceTable> {
  const row = await getDb()
    .selectFrom('device')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', '=', hostId)
    .where('role', '=', 'host')
    .executeTakeFirst();
  if (!row) throw Object.assign(new Error('host not found'), { statusCode: 404 });
  return row;
}

/** Assert any device (host or remote) belongs to this account (signaling targets). */
export async function assertDeviceInAccount(userId: string, deviceId: string): Promise<DeviceTable> {
  const row = await getDb()
    .selectFrom('device')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!row) throw Object.assign(new Error('device not found'), { statusCode: 404 });
  return row;
}
