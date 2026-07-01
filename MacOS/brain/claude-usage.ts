/* Claude subscription usage/limits — the SAME data Claude Code's `/status` shows.
   The CLI calls `GET https://api.anthropic.com/api/oauth/usage` with the subscription
   OAuth token (the `fetchUtilization` path in the bundled `claude` binary). We replicate
   that read-only call so the native app can surface "session / weekly limit remaining"
   without shelling out to the CLI. Token is resolved the way the CLI stores it:
   env → ~/.claude/.credentials.json → macOS keychain ("Claude Code-credentials"). */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** One limit bucket: percent USED (0–100) + when it resets (ISO) — `remaining = 100 - percent`. */
export interface ClaudeLimit { percent: number; resetsAt: string | null }
export interface ClaudeUsage {
  /** 5-hour rolling session limit (`five_hour`). */
  session?: ClaudeLimit | null;
  /** 7-day all-models weekly limit (`seven_day`). */
  weekly?: ClaudeLimit | null;
  /** Per-model weekly limits, when the plan scopes them. */
  weeklyOpus?: ClaudeLimit | null;
  weeklySonnet?: ClaudeLimit | null;
  fetchedAt: number;
  /** Set when usage couldn't be read (no token / signed out / HTTP error) — the UI hides the
      subscription rows and falls back to context-fill only. */
  error?: string;
}

async function resolveToken(): Promise<string | null> {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (env && env.trim()) return env.trim();
  // ~/.claude/.credentials.json → { claudeAiOauth: { accessToken } }
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    if (existsSync(p)) {
      const t = JSON.parse(readFileSync(p, 'utf8'))?.claudeAiOauth?.accessToken;
      if (typeof t === 'string' && t) return t;
    }
  } catch { /* fall through */ }
  // macOS keychain: the `claude` binary stores the same JSON blob there.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await pexec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 4000 });
      const t = JSON.parse(stdout.trim())?.claudeAiOauth?.accessToken;
      if (typeof t === 'string' && t) return t;
    } catch { /* fall through */ }
  }
  return null;
}

let cache: { at: number; data: ClaudeUsage } | null = null;
const TTL_MS = 30_000;

const bucket = (x: { utilization?: number; resets_at?: string } | null | undefined): ClaudeLimit | null =>
  x ? { percent: Math.round(x.utilization ?? 0), resetsAt: x.resets_at ?? null } : null;

/** Fetch (≤30 s cached) the live subscription utilization. Never throws — failures come back
    as `{ error }` so the caller can degrade gracefully. */
export async function getClaudeUsage(force = false): Promise<ClaudeUsage> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const token = await resolveToken();
  if (!token) { const d: ClaudeUsage = { fetchedAt: Date.now(), error: 'no-token' }; cache = { at: Date.now(), data: d }; return d; }
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-cli (maestro-desktop)',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) { const d: ClaudeUsage = { fetchedAt: Date.now(), error: `http-${res.status}` }; cache = { at: Date.now(), data: d }; return d; }
    const j = await res.json() as {
      five_hour?: { utilization?: number; resets_at?: string } | null;
      seven_day?: { utilization?: number; resets_at?: string } | null;
      seven_day_opus?: { utilization?: number; resets_at?: string } | null;
      seven_day_sonnet?: { utilization?: number; resets_at?: string } | null;
    };
    const data: ClaudeUsage = {
      session: bucket(j.five_hour),
      weekly: bucket(j.seven_day),
      weeklyOpus: bucket(j.seven_day_opus),
      weeklySonnet: bucket(j.seven_day_sonnet),
      fetchedAt: Date.now(),
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (e) {
    const d: ClaudeUsage = { fetchedAt: Date.now(), error: e instanceof Error ? e.message : 'fetch-failed' };
    cache = { at: Date.now(), data: d };
    return d;
  }
}
