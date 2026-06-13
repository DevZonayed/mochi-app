/* Provider-owned model registry.

   The model list "comes from the providers": each provider (Claude Code, Codex,
   Cursor) owns its own catalog here, and `buildModelGroups()` surfaces them
   grouped, marking each provider runnable/not from the live engine status — the
   same honest "sign in" reasoning the rest of the app uses. The renderer never
   hardcodes the list; it renders whatever this returns.

   Claude entries send the CLI's stable aliases (opus/sonnet/haiku) so they
   resolve to your plan's current version, plus Fable 5 by its full id. Codex
   runs your ChatGPT default (no -m). Cursor is listed but only runnable when its
   CLI is actually installed — never faked. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { EngineId } from './store';

export type ModelProviderId = 'claude' | 'codex' | 'cursor';

export interface ModelDescriptor {
  /** Stable picker id, e.g. 'claude:opus' — survives label/version changes. */
  key: string;
  /** Engine-native model arg passed to the runner ('' = the engine's default). */
  id: string;
  label: string;
  provider: ModelProviderId;
  family?: string;
  badge?: 'NEW';
  tierNote?: string;
  /** Runs out-of-process via a provider CLI → show the ↗ glyph. */
  external?: boolean;
}

export interface ModelGroup {
  provider: ModelProviderId;
  label: string;
  /** Whether this provider can run right now (signed in / CLI present). */
  runnable: boolean;
  /** When not runnable, the actionable reason. */
  reason: string;
  models: ModelDescriptor[];
}

const CLAUDE_MODELS: ModelDescriptor[] = [
  { key: 'claude:fable-5', id: 'claude-fable-5', label: 'Fable 5',   provider: 'claude', family: 'Fable',  badge: 'NEW', tierNote: 'Most capable' },
  { key: 'claude:opus',    id: 'opus',           label: 'Opus 4.8',  provider: 'claude', family: 'Opus',   tierNote: 'Best for coding' },
  { key: 'claude:sonnet',  id: 'sonnet',         label: 'Sonnet 4.6', provider: 'claude', family: 'Sonnet', tierNote: 'Balanced speed & depth' },
  { key: 'claude:haiku',   id: 'haiku',          label: 'Haiku 4.5', provider: 'claude', family: 'Haiku',  tierNote: 'Fastest' },
];
/* Codex runs on the ChatGPT login via `codex exec -m <model>`. These are the
   models the Codex CLI accepts; gpt-5.5 is the CLI's own configured default.
   An unavailable model surfaces as an honest run error (same as Claude). */
const CODEX_MODELS: ModelDescriptor[] = [
  { key: 'codex:gpt-5.5',     id: 'gpt-5.5',      label: 'GPT-5.5',     provider: 'codex', family: 'GPT', badge: 'NEW', tierNote: 'Codex default' },
  { key: 'codex:gpt-5.4',     id: 'gpt-5.4',      label: 'GPT-5.4',     provider: 'codex', family: 'GPT' },
  { key: 'codex:gpt-5-codex', id: 'gpt-5-codex',  label: 'GPT-5 Codex', provider: 'codex', family: 'GPT', tierNote: 'Coding-tuned' },
  { key: 'codex:o3',          id: 'o3',           label: 'o3',          provider: 'codex', family: 'o-series', tierNote: 'Reasoning' },
];
const CURSOR_MODELS: ModelDescriptor[] = [
  { key: 'cursor:composer', id: 'composer',      label: 'Composer',  provider: 'cursor', family: 'Composer', external: true, tierNote: 'Cursor agent' },
];

const ALL: ModelDescriptor[] = [...CLAUDE_MODELS, ...CODEX_MODELS, ...CURSOR_MODELS];

export function modelByKey(key: string | undefined): ModelDescriptor | undefined {
  return key ? ALL.find(m => m.key === key) : undefined;
}

/** Picker key → the engine + model the runner understands. Unrunnable providers
    (Cursor today) resolve to engine undefined so callers fall back honestly. */
export function resolveModelKey(key: string | undefined): { engine?: EngineId; model?: string } {
  const d = modelByKey(key);
  if (!d) return {};
  if (d.provider === 'claude') return { engine: 'claude', model: d.id || undefined };
  if (d.provider === 'codex') return { engine: 'codex', model: d.id || undefined };
  return {}; // cursor — not a runnable engine yet
}

/** Reverse: an engine + model id → the picker key, to show the current selection. */
export function keyForRun(engine: EngineId | undefined, model: string | undefined): string {
  if (engine === 'codex') { const d = CODEX_MODELS.find(m => m.id === model); return d?.key ?? 'codex:gpt-5.5'; }
  const d = CLAUDE_MODELS.find(m => m.id === model);
  return d?.key ?? 'claude:opus';
}

let cursorCache: { available: boolean; reason: string } | undefined;
export function cursorAvailability(): { available: boolean; reason: string } {
  if (cursorCache) return cursorCache;
  let bin: string | null = null;
  try {
    bin = execFileSync('/bin/zsh', ['-lc', 'command -v cursor-agent || command -v cursor'], { encoding: 'utf8' }).trim() || null;
  } catch { bin = null; }
  if (!bin) for (const p of ['/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent']) if (existsSync(p)) { bin = p; break; }
  cursorCache = bin
    ? { available: true, reason: '' }
    : { available: false, reason: 'Cursor CLI not found — install the Cursor agent CLI on this Mac to run Composer.' };
  return cursorCache;
}

export interface ModelStatuses {
  claude: { available: boolean; reason: string };
  codex: { available: boolean; reason: string };
}

/** The grouped catalog, with per-provider runnable flags from live engine status. */
export function buildModelGroups(s: ModelStatuses): ModelGroup[] {
  const cur = cursorAvailability();
  return [
    { provider: 'claude', label: 'Claude Code', runnable: s.claude.available, reason: s.claude.reason, models: CLAUDE_MODELS },
    { provider: 'codex',  label: 'Codex',       runnable: s.codex.available,  reason: s.codex.reason,  models: CODEX_MODELS },
    { provider: 'cursor', label: 'Cursor',      runnable: cur.available,      reason: cur.reason,      models: CURSOR_MODELS },
  ];
}
