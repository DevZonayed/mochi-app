/* Chat + project-memory mirror.
 *
 * Why this exists: the Mac is still the source of truth — chats land first
 * inside `.continuum/` and the agent's live session JSONLs on disk. But when
 * the Mac is asleep / offline, the phone has nothing to read. This module is
 * the cloud-side read-through cache: the desktop pushes chat + memory deltas
 * here as they're written; remote clients (mobile, web) read from here while
 * the Mac is unavailable, and from the Mac directly when it's up.
 *
 * Two backends:
 *   - InMemoryMirrorStore — default; used in tests and when no Postgres URL
 *     is configured. Zero-config, but state evaporates on restart.
 *   - PostgresMirrorStore — used when MAESTRO_PG_URL is set. Idempotent
 *     upserts so the desktop's `SyncWorker` can safely re-send anything on a
 *     restart without dup rows. Schema is `IF NOT EXISTS` + auto-migrated on
 *     boot; small surface so we don't reach for a migration tool yet.
 *
 * Conflict policy: Mac wins. The mirror is push-only from the Mac; any read
 * from the cloud is "best-known" view of what the Mac last told us. */

import type { Pool, PoolClient } from 'pg';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatRecord {
  id: string;
  accountId: string;       // 'self' until Better Auth is wired
  projectId: string | null;
  title: string;
  archived: boolean;
  createdAt: number;       // ms
  updatedAt: number;       // ms
}

export interface MessageRecord {
  id: string;
  chatId: string;
  accountId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;       // ms
}

export type MemoryKind = 'state' | 'checkpoint';

export interface MemoryRecord {
  id: string;
  accountId: string;
  projectId: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  commitSha: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Cursor + page for paginated reads. */
export interface MessagePage {
  messages: MessageRecord[];
  /** True if there are MORE older messages beyond this page. */
  hasMore: boolean;
}

/* ── Inputs (smaller than the records — the desktop omits server-managed
   fields like createdAt). ─────────────────────────────────────────────── */

export interface UpsertChat {
  id: string;
  accountId?: string;
  projectId?: string | null;
  title?: string;
  archived?: boolean;
  /** Override updatedAt; defaults to now. Used by the desktop to preserve
      ordering when it replays a backlog after the relay was offline. */
  updatedAt?: number;
}

export interface UpsertMessage {
  id: string;
  chatId: string;
  accountId?: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface UpsertMemory {
  projectId: string;
  kind: MemoryKind;
  content: string;
  accountId?: string;
  /** Optional id; defaults to `${projectId}:${kind}` for kind='state' (one
      row per project) or `${projectId}:${commitSha}` for checkpoints. */
  id?: string;
  tags?: string[];
  commitSha?: string | null;
  updatedAt?: number;
}

export interface MirrorStore {
  /* Writes — called by the Mac's SyncWorker. */
  upsertChat(input: UpsertChat): Promise<ChatRecord>;
  upsertMessages(messages: UpsertMessage[]): Promise<number>;
  upsertMemory(input: UpsertMemory): Promise<MemoryRecord>;

  /* Reads — called by mobile / web clients. */
  listChats(accountId: string, projectId?: string | null): Promise<ChatRecord[]>;
  getChat(id: string): Promise<ChatRecord | null>;
  listMessages(chatId: string, opts?: { limit?: number; beforeCreatedAt?: number }): Promise<MessagePage>;
  listMemories(accountId: string, projectId: string): Promise<MemoryRecord[]>;

  /* Maintenance. */
  clear(): Promise<void>;
  close(): Promise<void>;
}

/* ── Defaults + helpers ───────────────────────────────────────────────── */

const DEFAULT_ACCOUNT = 'self';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const clampLimit = (n?: number): number => Math.min(Math.max(Math.floor(n ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

/** Default id when the caller doesn't provide one. We namespace by accountId
    so two accounts can keep independent state for the same projectId without
    one overwriting the other. */
const defaultMemoryId = (m: UpsertMemory): string => {
  if (m.id) return m.id;
  const acc = m.accountId ?? DEFAULT_ACCOUNT;
  return m.kind === 'state'
    ? `${acc}:${m.projectId}:state`
    : `${acc}:${m.projectId}:${m.commitSha ?? Date.now()}`;
};

/* ── In-memory backend ────────────────────────────────────────────────── */

export class InMemoryMirrorStore implements MirrorStore {
  private chats = new Map<string, ChatRecord>();
  private messages = new Map<string, MessageRecord>();
  private memories = new Map<string, MemoryRecord>();

  /* All public reads/writes return COPIES of internal records. Sharing a
     reference with the caller would let a later store mutation silently
     change a snapshot the caller is holding, which is exactly the kind of
     aliasing bug a real Postgres backend wouldn't have. */
  async upsertChat(input: UpsertChat): Promise<ChatRecord> {
    const now = Date.now();
    const existing = this.chats.get(input.id);
    const rec: ChatRecord = {
      id: input.id,
      accountId: input.accountId ?? existing?.accountId ?? DEFAULT_ACCOUNT,
      projectId: input.projectId ?? existing?.projectId ?? null,
      title: input.title ?? existing?.title ?? '',
      archived: input.archived ?? existing?.archived ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.chats.set(rec.id, rec);
    return { ...rec };
  }

  async upsertMessages(messages: UpsertMessage[]): Promise<number> {
    let written = 0;
    for (const m of messages) {
      const existing = this.messages.get(m.id);
      const rec: MessageRecord = {
        id: m.id,
        chatId: m.chatId,
        accountId: m.accountId ?? existing?.accountId ?? DEFAULT_ACCOUNT,
        role: m.role,
        content: m.content,
        metadata: m.metadata ?? existing?.metadata ?? null,
        createdAt: m.createdAt ?? existing?.createdAt ?? Date.now(),
      };
      this.messages.set(rec.id, rec);
      written++;
      // Touch the chat's updatedAt so listChats orders correctly.
      const c = this.chats.get(m.chatId);
      if (c && rec.createdAt > c.updatedAt) c.updatedAt = rec.createdAt;
    }
    return written;
  }

  async upsertMemory(input: UpsertMemory): Promise<MemoryRecord> {
    const id = defaultMemoryId(input);
    const now = Date.now();
    const existing = this.memories.get(id);
    const rec: MemoryRecord = {
      id,
      accountId: input.accountId ?? existing?.accountId ?? DEFAULT_ACCOUNT,
      projectId: input.projectId,
      kind: input.kind,
      content: input.content,
      tags: input.tags ?? existing?.tags ?? [],
      commitSha: input.commitSha ?? existing?.commitSha ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.memories.set(id, rec);
    return { ...rec, tags: [...rec.tags] };
  }

  async listChats(accountId: string, projectId?: string | null): Promise<ChatRecord[]> {
    return [...this.chats.values()]
      .filter((c) => c.accountId === accountId && (projectId === undefined || c.projectId === projectId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ ...c }));
  }

  async getChat(id: string): Promise<ChatRecord | null> {
    const c = this.chats.get(id);
    return c ? { ...c } : null;
  }

  async listMessages(chatId: string, opts: { limit?: number; beforeCreatedAt?: number } = {}): Promise<MessagePage> {
    const limit = clampLimit(opts.limit);
    const before = opts.beforeCreatedAt ?? Infinity;
    const filtered = [...this.messages.values()]
      .filter((m) => m.chatId === chatId && m.createdAt < before)
      .sort((a, b) => b.createdAt - a.createdAt);
    const page = filtered.slice(0, limit).map((m) => ({ ...m }));
    return { messages: page.reverse(), hasMore: filtered.length > limit };
  }

  async listMemories(accountId: string, projectId: string): Promise<MemoryRecord[]> {
    return [...this.memories.values()]
      .filter((m) => m.accountId === accountId && m.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({ ...m, tags: [...m.tags] }));
  }

  async clear(): Promise<void> {
    this.chats.clear();
    this.messages.clear();
    this.memories.clear();
  }

  async close(): Promise<void> { /* nothing to release */ }
}

/* ── Postgres backend ─────────────────────────────────────────────────── */

/** Async constructor pattern: factory ensures the pool is connected and the
    schema is migrated before the store is returned. */
export async function createPostgresMirrorStore(connectionString: string): Promise<MirrorStore> {
  // Dynamic import so test runs that never set MAESTRO_PG_URL don't need pg
  // loaded — and crucially, so a missing libpq in CI doesn't break the build.
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  await migrate(pool);
  return new PostgresMirrorStore(pool);
}

async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL DEFAULT 'self',
        project_id  TEXT,
        title       TEXT NOT NULL DEFAULT '',
        archived    BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_account_project ON chats(account_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id          TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        account_id  TEXT NOT NULL DEFAULT 'self',
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        metadata    JSONB,
        created_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created ON chat_messages(chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS project_memories (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL DEFAULT 'self',
        project_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        content     TEXT NOT NULL,
        tags        TEXT[] NOT NULL DEFAULT '{}',
        commit_sha  TEXT,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_memories_proj_kind ON project_memories(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_project_memories_updated ON project_memories(updated_at DESC);
    `);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

class PostgresMirrorStore implements MirrorStore {
  constructor(private readonly pool: Pool) {}

  async upsertChat(input: UpsertChat): Promise<ChatRecord> {
    const now = Date.now();
    const accountId = input.accountId ?? DEFAULT_ACCOUNT;
    const updatedAt = input.updatedAt ?? now;
    const { rows } = await this.pool.query(
      `INSERT INTO chats (id, account_id, project_id, title, archived, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         account_id = COALESCE(EXCLUDED.account_id, chats.account_id),
         project_id = COALESCE(EXCLUDED.project_id, chats.project_id),
         title      = COALESCE(NULLIF(EXCLUDED.title, ''), chats.title),
         archived   = EXCLUDED.archived,
         updated_at = GREATEST(EXCLUDED.updated_at, chats.updated_at)
       RETURNING id, account_id, project_id, title, archived, created_at, updated_at`,
      [input.id, accountId, input.projectId ?? null, input.title ?? '', input.archived ?? false, now, updatedAt],
    );
    return rowToChat(rows[0] as ChatRow);
  }

  async upsertMessages(messages: UpsertMessage[]): Promise<number> {
    if (!messages.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let written = 0;
      for (const m of messages) {
        const { rowCount } = await client.query(
          `INSERT INTO chat_messages (id, chat_id, account_id, role, content, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             content  = EXCLUDED.content,
             metadata = EXCLUDED.metadata`,
          [m.id, m.chatId, m.accountId ?? DEFAULT_ACCOUNT, m.role, m.content, m.metadata ?? null, m.createdAt ?? Date.now()],
        );
        written += rowCount ?? 0;
        // Touch chat updated_at to bump it in the chat list.
        await client.query(
          `UPDATE chats SET updated_at = GREATEST(updated_at, $1) WHERE id = $2`,
          [m.createdAt ?? Date.now(), m.chatId],
        );
      }
      await client.query('COMMIT');
      return written;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async upsertMemory(input: UpsertMemory): Promise<MemoryRecord> {
    const id = defaultMemoryId(input);
    const now = Date.now();
    const { rows } = await this.pool.query(
      `INSERT INTO project_memories (id, account_id, project_id, kind, content, tags, commit_sha, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         content    = EXCLUDED.content,
         tags       = EXCLUDED.tags,
         commit_sha = COALESCE(EXCLUDED.commit_sha, project_memories.commit_sha),
         updated_at = GREATEST(EXCLUDED.updated_at, project_memories.updated_at)
       RETURNING id, account_id, project_id, kind, content, tags, commit_sha, created_at, updated_at`,
      [id, input.accountId ?? DEFAULT_ACCOUNT, input.projectId, input.kind, input.content, input.tags ?? [], input.commitSha ?? null, now, input.updatedAt ?? now],
    );
    return rowToMemory(rows[0] as MemoryRow);
  }

  async listChats(accountId: string, projectId?: string | null): Promise<ChatRecord[]> {
    const params: unknown[] = [accountId];
    let where = `account_id = $1`;
    if (projectId !== undefined) {
      params.push(projectId);
      where += projectId === null ? ` AND project_id IS NULL` : ` AND project_id = $2`;
    }
    const { rows } = await this.pool.query(
      `SELECT id, account_id, project_id, title, archived, created_at, updated_at
       FROM chats WHERE ${where} ORDER BY updated_at DESC LIMIT 200`,
      params,
    );
    return (rows as ChatRow[]).map(rowToChat);
  }

  async getChat(id: string): Promise<ChatRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, account_id, project_id, title, archived, created_at, updated_at FROM chats WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToChat(rows[0] as ChatRow) : null;
  }

  async listMessages(chatId: string, opts: { limit?: number; beforeCreatedAt?: number } = {}): Promise<MessagePage> {
    const limit = clampLimit(opts.limit);
    const before = opts.beforeCreatedAt ?? Number.MAX_SAFE_INTEGER;
    const { rows } = await this.pool.query(
      `SELECT id, chat_id, account_id, role, content, metadata, created_at
       FROM chat_messages WHERE chat_id = $1 AND created_at < $2
       ORDER BY created_at DESC LIMIT $3`,
      [chatId, before, limit + 1],
    );
    const more = rows.length > limit;
    const page = (rows as MessageRow[]).slice(0, limit).map(rowToMessage).reverse();
    return { messages: page, hasMore: more };
  }

  async listMemories(accountId: string, projectId: string): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, account_id, project_id, kind, content, tags, commit_sha, created_at, updated_at
       FROM project_memories WHERE account_id = $1 AND project_id = $2 ORDER BY updated_at DESC LIMIT 200`,
      [accountId, projectId],
    );
    return (rows as MemoryRow[]).map(rowToMemory);
  }

  async clear(): Promise<void> {
    // Test helper only — be loud if invoked in production.
    if (process.env.NODE_ENV === 'production') throw new Error('clear() is a test helper');
    await this.pool.query('TRUNCATE chats, chat_messages, project_memories RESTART IDENTITY CASCADE');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* ── Row mapping ──────────────────────────────────────────────────────── */

interface ChatRow {
  id: string; account_id: string; project_id: string | null;
  title: string; archived: boolean; created_at: string | number; updated_at: string | number;
}
interface MessageRow {
  id: string; chat_id: string; account_id: string;
  role: MessageRole; content: string; metadata: Record<string, unknown> | null;
  created_at: string | number;
}
interface MemoryRow {
  id: string; account_id: string; project_id: string;
  kind: MemoryKind; content: string; tags: string[];
  commit_sha: string | null; created_at: string | number; updated_at: string | number;
}

const num = (v: string | number): number => typeof v === 'number' ? v : Number(v);

const rowToChat = (r: ChatRow): ChatRecord => ({
  id: r.id, accountId: r.account_id, projectId: r.project_id,
  title: r.title, archived: !!r.archived,
  createdAt: num(r.created_at), updatedAt: num(r.updated_at),
});
const rowToMessage = (r: MessageRow): MessageRecord => ({
  id: r.id, chatId: r.chat_id, accountId: r.account_id,
  role: r.role, content: r.content, metadata: r.metadata,
  createdAt: num(r.created_at),
});
const rowToMemory = (r: MemoryRow): MemoryRecord => ({
  id: r.id, accountId: r.account_id, projectId: r.project_id,
  kind: r.kind, content: r.content, tags: r.tags ?? [], commitSha: r.commit_sha,
  createdAt: num(r.created_at), updatedAt: num(r.updated_at),
});

/* ── Factory: pick a backend based on env ─────────────────────────────── */

/** Picks Postgres when MAESTRO_PG_URL is set, otherwise an in-memory store
    (used in tests + as a "no DB yet" fallback so the relay still boots). */
export async function createMirrorStore(opts: { pgUrl?: string } = {}): Promise<MirrorStore> {
  const url = opts.pgUrl ?? process.env.MAESTRO_PG_URL;
  if (url) {
    try { return await createPostgresMirrorStore(url); }
    catch (e) {
      // Don't crash the relay if Postgres is down — fall back to in-memory and
      // log so the operator can fix it. Mobile reads degrade to "empty" until
      // PG is reachable; the desktop keeps disk as truth either way.
      console.error('[mirror] Postgres init failed, falling back to in-memory:', e instanceof Error ? e.message : e);
    }
  }
  return new InMemoryMirrorStore();
}

/** Used by tests to bypass the env check. */
export function createInMemoryMirrorStore(): MirrorStore {
  return new InMemoryMirrorStore();
}

// Re-export the Postgres pool client type so consumers can introspect during
// migrations without importing pg directly.
export type { PoolClient };
