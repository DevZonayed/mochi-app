/* Conversation sync — import past agent conversations into a Maestro project.

   When a project points at a real folder on this Mac, the coding tools you
   already use (Claude Code, Codex) and the Conductor app have very likely run
   inside that folder — and left their full conversation history on disk:

     • Claude Code  → ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
     • Codex        → ~/.codex/sessions/<Y>/<M>/<D>/rollout-…-<uuid>.jsonl
     • Conductor    → ~/Library/Application Support/com.conductor.app/conductor.db (SQLite)

   This module SCANS those stores for conversations whose working directory is
   the project's folder, and PARSES a selected conversation into ordered turns
   (one user message + the assistant's reply/tools) that map 1:1 onto Maestro's
   Job/transcript model. Everything is best-effort and read-only: a missing
   store, an unreadable file, or an absent sqlite3 binary just yields nothing
   for that source — never an error. Nothing here writes to those stores. */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ConvSource = 'claude' | 'codex' | 'conductor';

/** A conversation found on disk, before import (metadata only — cheap to scan). */
export interface ScannedConversation {
  source: ConvSource;
  /** Stable id used to dedupe re-imports (session uuid for all three sources). */
  externalId: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** Claude/Codex: the .jsonl path to parse on import. Conductor: unused. */
  filePath?: string;
}

export interface ScanResult {
  /** Which sources are present on this Mac (data dir / db exists). */
  available: Record<ConvSource, boolean>;
  conversations: ScannedConversation[];
}

/** One parsed turn: a user message and the assistant's response blocks. Maps
    directly onto a Maestro Job (input/output/transcript). */
export interface ImportedTurn {
  input: string;
  output: string;
  transcript: ImportedBlock[];
  createdAt: number;
}
export interface ImportedBlock {
  kind: 'text' | 'tool' | 'result';
  text: string;
  name?: string;
  ts: number;
}

/* ── paths ──────────────────────────────────────────────────────────────── */

const CLAUDE_PROJECTS = () => join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS = () => join(homedir(), '.codex', 'sessions');
const CODEX_INDEX = () => join(homedir(), '.codex', 'session_index.jsonl');
const CONDUCTOR_DB = () => join(homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');

/** Claude encodes an absolute cwd as the folder name by replacing every
    non-alphanumeric run with '-' (so /Users/x/my.app → -Users-x-my-app). */
function encodeClaudeDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function toMs(iso: unknown): number {
  if (typeof iso === 'number') return iso > 1e12 ? iso : iso * 1000;
  if (typeof iso === 'string') {
    const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** Max characters kept per transcript text block, to keep imported history from
    bloating the store (tool details are capped separately at 400). */
const BLOCK_CAP = 4000;
const cap = (s: string, n = BLOCK_CAP): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** Strip the system/environment/instruction wrapper blocks that the harnesses
    prepend to the first user message, so an imported chat opens with the real
    human prompt rather than a wall of boilerplate. */
function stripSystemWrappers(text: string): string {
  return (text || '')
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, '')
    .replace(/<permissions[\s\S]*?(?:<\/permissions[^>]*>|$)/gi, '')
    .trim();
}

/** First human-readable line of a message — strips wrappers and XML-ish tags so
    the title reads like what the user actually typed. */
function cleanTitle(text: string): string {
  const t = stripSystemWrappers(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 80);
}

function parseJsonl(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as Record<string, unknown>); } catch { /* skip bad line */ }
  }
  return out;
}

/* ── Claude Code ────────────────────────────────────────────────────────── */

function claudeTextOf(content: unknown): { text: string; tools: { name: string; detail: string }[] } {
  // user content is usually a string; assistant content is a block array.
  if (typeof content === 'string') return { text: content, tools: [] };
  const tools: { name: string; detail: string }[] = [];
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const bb = b as Record<string, unknown>;
      if (bb.type === 'text' && typeof bb.text === 'string') parts.push(bb.text);
      else if (bb.type === 'thinking' && typeof bb.thinking === 'string') parts.push(bb.thinking);
      else if (bb.type === 'tool_use' && typeof bb.name === 'string') {
        const input = bb.input && typeof bb.input === 'object' ? JSON.stringify(bb.input) : '';
        tools.push({ name: bb.name, detail: input.slice(0, 400) });
      } else if (bb.type === 'tool_result') {
        const c = bb.content;
        const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && typeof x === 'object' && typeof (x as Record<string, unknown>).text === 'string' ? (x as Record<string, string>).text : '')).join('') : '';
        if (txt.trim()) parts.push(txt);
      }
    }
  }
  return { text: parts.join('\n\n'), tools };
}

function scanClaude(projectPath: string): ScannedConversation[] {
  const dir = join(CLAUDE_PROJECTS(), encodeClaudeDir(projectPath));
  if (!existsSync(dir)) return [];
  const out: ScannedConversation[] = [];
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  for (const f of files) {
    const file = join(dir, f);
    const rows = parseJsonl(file);
    if (!rows.length) continue;
    const externalId = f.replace(/\.jsonl$/, '');
    let title = '';
    let createdAt = 0;
    let count = 0;
    for (const r of rows) {
      const type = r.type;
      if (type === 'summary' && typeof r.summary === 'string' && !title) title = cleanTitle(r.summary as string);
      if (type !== 'user' && type !== 'assistant') continue;
      count++;
      if (!createdAt) createdAt = toMs(r.timestamp);
      if (!title && type === 'user') {
        const m = r.message as Record<string, unknown> | undefined;
        const { text } = claudeTextOf(m?.content);
        const c = cleanTitle(text);
        if (c && !c.startsWith('Caveat')) title = c;
      }
    }
    if (!count) continue;
    let updatedAt = createdAt;
    try { updatedAt = statSync(file).mtimeMs; } catch { /* keep createdAt */ }
    out.push({ source: 'claude', externalId, title: title || 'Claude session', messageCount: count, createdAt, updatedAt, filePath: file });
  }
  return out;
}

function parseClaude(file: string): ImportedTurn[] {
  const rows = parseJsonl(file);
  const turns: ImportedTurn[] = [];
  let cur: ImportedTurn | null = null;
  for (const r of rows) {
    const type = r.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const ts = toMs(r.timestamp);
    const m = r.message as Record<string, unknown> | undefined;
    const { text, tools } = claudeTextOf(m?.content);
    if (type === 'user') {
      // A tool_result-only user turn belongs to the running assistant turn.
      const isToolResult = Array.isArray(m?.content) && (m!.content as unknown[]).every(b => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result');
      if (isToolResult && cur) { if (text.trim()) cur.transcript.push({ kind: 'result', text: cap(text), ts }); continue; }
      const clean = stripSystemWrappers(text);
      if (!clean) { cur = null; continue; } // pure system/boilerplate — not a human turn
      cur = { input: cap(clean), output: '', transcript: [], createdAt: ts };
      turns.push(cur);
    } else {
      if (!cur) { cur = { input: '', output: '', transcript: [], createdAt: ts }; turns.push(cur); }
      if (text.trim()) { cur.transcript.push({ kind: 'text', text: cap(text), ts }); cur.output = cap(text); }
      for (const t of tools) cur.transcript.push({ kind: 'tool', text: t.detail, name: t.name, ts });
    }
  }
  return turns.filter(t => t.input.trim() || t.transcript.length);
}

/* ── Codex ──────────────────────────────────────────────────────────────── */

function codexTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(b => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, string>).text : ''))
    .filter(Boolean)
    .join('\n');
}

function codexIndexTitles(): Map<string, string> {
  const map = new Map<string, string>();
  const idx = CODEX_INDEX();
  if (!existsSync(idx)) return map;
  for (const r of parseJsonl(idx)) {
    if (typeof r.id === 'string' && typeof r.thread_name === 'string' && r.thread_name.trim()) {
      map.set(r.id, cleanTitle(r.thread_name));
    }
  }
  return map;
}

function walkJsonl(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 5) return acc;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return acc; }
  for (const e of entries) {
    const p = join(root, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkJsonl(p, depth + 1, acc);
    else if (e.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

function scanCodex(projectPath: string): ScannedConversation[] {
  const root = CODEX_SESSIONS();
  if (!existsSync(root)) return [];
  const titles = codexIndexTitles();
  const out: ScannedConversation[] = [];
  for (const file of walkJsonl(root)) {
    const rows = parseJsonl(file);
    if (!rows.length) continue;
    const meta = rows[0];
    if (meta.type !== 'session_meta') continue;
    const payload = meta.payload as Record<string, unknown> | undefined;
    if (!payload || payload.cwd !== projectPath) continue;
    const externalId = String(payload.id ?? '');
    if (!externalId) continue;
    const createdAt = toMs(payload.timestamp ?? meta.timestamp);
    let count = 0;
    let firstUser = '';
    let lastTs = createdAt;
    for (const r of rows) {
      lastTs = toMs(r.timestamp) || lastTs;
      if (r.type !== 'response_item') continue;
      const p = r.payload as Record<string, unknown> | undefined;
      if (p?.type !== 'message') continue;
      const role = p.role;
      if (role !== 'user' && role !== 'assistant') continue;
      count++;
      if (!firstUser && role === 'user') {
        const c = cleanTitle(codexTextOf(p.content));
        if (c) firstUser = c;
      }
    }
    if (!count) continue;
    out.push({ source: 'codex', externalId, title: titles.get(externalId) || firstUser || 'Codex session', messageCount: count, createdAt, updatedAt: lastTs, filePath: file });
  }
  return out;
}

function parseCodex(file: string): ImportedTurn[] {
  const rows = parseJsonl(file);
  const turns: ImportedTurn[] = [];
  let cur: ImportedTurn | null = null;
  for (const r of rows) {
    if (r.type !== 'response_item') continue;
    const p = r.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const ts = toMs(r.timestamp);
    if (p.type === 'message') {
      const role = p.role;
      const text = codexTextOf(p.content);
      if (role === 'user') {
        const clean = stripSystemWrappers(text);
        if (!clean) { cur = null; continue; } // environment/instruction wrapper — not a human turn
        cur = { input: cap(clean), output: '', transcript: [], createdAt: ts };
        turns.push(cur);
      } else if (role === 'assistant') {
        if (!cur) { cur = { input: '', output: '', transcript: [], createdAt: ts }; turns.push(cur); }
        if (text.trim()) { cur.transcript.push({ kind: 'text', text: cap(text), ts }); cur.output = cap(text); }
      }
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && cur) {
      const name = typeof p.name === 'string' ? p.name : 'tool';
      const args = typeof p.arguments === 'string' ? p.arguments : p.input && typeof p.input === 'object' ? JSON.stringify(p.input) : '';
      cur.transcript.push({ kind: 'tool', text: String(args).slice(0, 400), name, ts });
    }
  }
  // Skip the leading developer/system turn Codex injects (its first "user" is
  // the permissions/instructions blob, not something the human typed).
  return turns.filter(t => t.input.trim() || t.transcript.length);
}

/* ── Conductor (SQLite, read-only via the system sqlite3 binary) ──────────── */

const SQLITE = '/usr/bin/sqlite3';

function sqliteJson<T>(db: string, query: string): T[] {
  if (!existsSync(SQLITE) || !existsSync(db)) return [];
  try {
    const out = execFileSync(SQLITE, ['-readonly', '-json', db, query], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
    const trimmed = out.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function conductorWorkspaceId(projectPath: string): string | null {
  const db = CONDUCTOR_DB();
  const rows = sqliteJson<{ id: string }>(db, `SELECT id FROM workspaces WHERE workspace_path = ${sqlStr(projectPath)} LIMIT 1`);
  return rows[0]?.id ?? null;
}

function scanConductor(projectPath: string): ScannedConversation[] {
  const db = CONDUCTOR_DB();
  const wsId = conductorWorkspaceId(projectPath);
  if (!wsId) return [];
  const sessions = sqliteJson<{ id: string; title: string | null; created_at: string; updated_at: string }>(
    db,
    `SELECT id, title, created_at, updated_at FROM sessions WHERE workspace_id = ${sqlStr(wsId)}`,
  );
  if (!sessions.length) return [];
  const counts = new Map<string, number>();
  const ids = sessions.map(s => sqlStr(s.id)).join(',');
  for (const c of sqliteJson<{ session_id: string; c: number }>(db, `SELECT session_id, COUNT(*) c FROM session_messages WHERE session_id IN (${ids}) GROUP BY session_id`)) {
    counts.set(c.session_id, c.c);
  }
  return sessions
    .map(s => ({
      source: 'conductor' as const,
      externalId: s.id,
      title: cleanTitle(s.title || '') || 'Conductor chat',
      messageCount: counts.get(s.id) ?? 0,
      createdAt: toMs(s.created_at),
      updatedAt: toMs(s.updated_at) || toMs(s.created_at),
    }))
    .filter(s => s.messageCount > 0);
}

/** Decode a Conductor message body. User rows are plain text; assistant rows are
    a JSON-encoded Claude SDK message whose content is a text/tool block array. */
function conductorBody(role: string, content: string): { text: string; tools: { name: string; detail: string }[] } {
  if (role === 'user') return { text: content, tools: [] };
  const s = (content || '').trim();
  if (!s.startsWith('{')) return { text: content, tools: [] };
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    const msg = (obj.message as Record<string, unknown> | undefined) ?? obj;
    return claudeTextOf(msg.content);
  } catch {
    return { text: content, tools: [] };
  }
}

function parseConductor(sessionId: string): ImportedTurn[] {
  const db = CONDUCTOR_DB();
  const rows = sqliteJson<{ role: string; content: string; sent_at: string | null; created_at: string }>(
    db,
    `SELECT role, content, sent_at, created_at FROM session_messages WHERE session_id = ${sqlStr(sessionId)} ORDER BY COALESCE(sent_at, created_at), rowid`,
  );
  const turns: ImportedTurn[] = [];
  let cur: ImportedTurn | null = null;
  for (const r of rows) {
    const ts = toMs(r.sent_at ?? r.created_at);
    const { text, tools } = conductorBody(r.role, r.content);
    if (r.role === 'user') {
      const clean = stripSystemWrappers(text);
      if (!clean) { cur = null; continue; }
      cur = { input: cap(clean), output: '', transcript: [], createdAt: ts };
      turns.push(cur);
    } else {
      if (!cur) { cur = { input: '', output: '', transcript: [], createdAt: ts }; turns.push(cur); }
      if (text.trim()) { cur.transcript.push({ kind: 'text', text: cap(text), ts }); cur.output = cap(text); }
      for (const t of tools) cur.transcript.push({ kind: 'tool', text: t.detail, name: t.name, ts });
    }
  }
  return turns.filter(t => t.input.trim() || t.transcript.length);
}

/* ── public API ─────────────────────────────────────────────────────────── */

/** Scan all three stores for conversations that ran inside `projectPath`. */
export function scanConversations(projectPath: string): ScanResult {
  const available: Record<ConvSource, boolean> = {
    claude: existsSync(CLAUDE_PROJECTS()),
    codex: existsSync(CODEX_SESSIONS()),
    conductor: existsSync(SQLITE) && existsSync(CONDUCTOR_DB()),
  };
  const conversations: ScannedConversation[] = [];
  if (!projectPath) return { available, conversations };
  try { conversations.push(...scanClaude(projectPath)); } catch { /* best-effort */ }
  try { conversations.push(...scanCodex(projectPath)); } catch { /* best-effort */ }
  try { conversations.push(...scanConductor(projectPath)); } catch { /* best-effort */ }
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  return { available, conversations };
}

/** Parse one selected conversation into ordered turns ready to become Jobs. */
export function parseConversation(source: ConvSource, ref: { filePath?: string; externalId: string }): ImportedTurn[] {
  try {
    if (source === 'claude' && ref.filePath) return parseClaude(ref.filePath);
    if (source === 'codex' && ref.filePath) return parseCodex(ref.filePath);
    if (source === 'conductor') return parseConductor(ref.externalId);
  } catch { /* best-effort */ }
  return [];
}
