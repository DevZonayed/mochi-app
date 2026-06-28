/* Provider-owned model registry.

   The model list "comes from the providers": each provider (Claude Code, Codex,
   Cursor) owns its own catalog here, and `buildModelGroups()` surfaces them
   grouped, marking each provider runnable/not from the live engine status — the
   same honest "sign in" reasoning the rest of the app uses. The renderer never
   hardcodes the list; it renders whatever this returns.

   Claude entries are discovered at runtime from Anthropic's Models API when an
   API key is configured, then from the installed Claude Code binary, and only
   then from a concrete fallback list. Codex runs your ChatGPT login via the
   Codex CLI. Cursor is listed but only runnable when its CLI is actually
   installed — never faked. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { bundledBinary, enginesRoot, managedBinary, systemBinary } from './engines.js';
import type { EngineId } from './store';
import type { Providers } from './providers.js';

export type ModelProviderId = 'claude' | 'codex' | 'cursor';

export interface ModelDescriptor {
  /** Stable picker id, e.g. 'claude:claude-opus-4-8'. */
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

const FALLBACK_CLAUDE_MODELS: ModelDescriptor[] = [
  { key: 'claude:claude-fable-5', id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'claude', family: 'Fable', badge: 'NEW', tierNote: 'Claude Code' },
  { key: 'claude:claude-opus-4-8', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'claude', family: 'Opus', tierNote: 'Most capable' },
  { key: 'claude:claude-opus-4-7', id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'claude', family: 'Opus' },
  { key: 'claude:claude-opus-4-6', id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'claude', family: 'Opus' },
  { key: 'claude:claude-opus-4-5-20251101', id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5 20251101', provider: 'claude', family: 'Opus' },
  { key: 'claude:claude-opus-4-1-20250805', id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1 20250805', provider: 'claude', family: 'Opus' },
  { key: 'claude:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'claude', family: 'Sonnet', tierNote: 'Balanced speed & depth' },
  { key: 'claude:claude-sonnet-4-5', id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'claude', family: 'Sonnet' },
  { key: 'claude:claude-sonnet-3-7-20250219', id: 'claude-sonnet-3-7-20250219', label: 'Claude Sonnet 3.7 20250219', provider: 'claude', family: 'Sonnet' },
  { key: 'claude:claude-haiku-4-5-20251001', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 20251001', provider: 'claude', family: 'Haiku', tierNote: 'Fastest' },
  { key: 'claude:claude-3-5-haiku-20241022', id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku 20241022', provider: 'claude', family: 'Haiku' },
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

let claudeModels: ModelDescriptor[] = FALLBACK_CLAUDE_MODELS;
let dynamicAll: ModelDescriptor[] = [...claudeModels, ...CODEX_MODELS, ...CURSOR_MODELS];
let claudeRefresh: Promise<void> | null = null;
let claudeFetchedAt = 0;
let claudeSource: 'fallback' | 'api' | 'cli' = 'fallback';
const CLAUDE_REFRESH_MS = 60_000;

function setClaudeModels(models: ModelDescriptor[], source: typeof claudeSource): void {
  if (!models.length) return;
  const seen = new Set<string>();
  claudeModels = models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  claudeSource = source;
  claudeFetchedAt = Date.now();
  dynamicAll = [...claudeModels, ...CODEX_MODELS, ...CURSOR_MODELS];
}

function familyOfClaudeId(id: string): string {
  const s = id.toLowerCase();
  if (s.includes('fable')) return 'Fable';
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  return 'Claude';
}

function labelForClaudeId(id: string, displayName?: string): string {
  if (displayName?.trim()) return displayName.trim();
  return id
    .replace(/^claude-/, 'Claude ')
    .split('-')
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function descriptorForClaudeId(id: string, displayName?: string, newest = false): ModelDescriptor {
  return {
    key: `claude:${id}`,
    id,
    label: labelForClaudeId(id, displayName),
    provider: 'claude',
    family: familyOfClaudeId(id),
    ...(newest ? { badge: 'NEW' as const } : {}),
  };
}

function compareClaudeModels(a: ModelDescriptor, b: ModelDescriptor): number {
  const score = (m: ModelDescriptor) => {
    const id = m.id.toLowerCase();
    const fam = id.includes('fable') ? 500 : id.includes('opus') ? 400 : id.includes('sonnet') ? 300 : id.includes('haiku') ? 200 : 100;
    const nums = [...id.matchAll(/\d+/g)].map((x) => Number(x[0])).filter(Number.isFinite);
    return fam * 1e12 + nums.reduce((n, x) => n * 1000 + Math.min(x, 999), 0);
  };
  return score(b) - score(a);
}

function claudeBinary(): string | null {
  return managedBinary(enginesRoot(), 'claude') ?? systemBinary('claude') ?? bundledBinary('claude');
}

function discoverClaudeModelsFromBinary(): ModelDescriptor[] {
  const bin = claudeBinary();
  if (!bin) return [];
  try {
    const out = execFileSync('/usr/bin/strings', [bin], { encoding: 'utf8', timeout: 4000, maxBuffer: 24 * 1024 * 1024 });
    const ids = new Set<string>();
    const re = /\bclaude-(?:(?:fable|mythos)-\d+(?:-[a-z0-9]+)?|(?:opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?)(?:-v\d+)?\b/g;
    for (const m of out.matchAll(re)) {
      const id = m[0];
      if (/^(claude-(?:fable|mythos|opus|sonnet|haiku)-)/.test(id) && !id.endsWith('-')) ids.add(id);
    }
    return [...ids].map((id) => descriptorForClaudeId(id)).sort(compareClaudeModels);
  } catch {
    return [];
  }
}

async function discoverClaudeModelsFromApi(providers?: Providers): Promise<ModelDescriptor[]> {
  const apiKey = providers?.getLocalKey('anthropic') ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const client = new Anthropic({ apiKey });
  const out: ModelDescriptor[] = [];
  for await (const m of client.models.list({ limit: 100 })) {
    if (typeof m.id === 'string' && m.id.startsWith('claude-')) out.push(descriptorForClaudeId(m.id, m.display_name, out.length === 0));
  }
  return out.sort(compareClaudeModels);
}

export async function refreshModelGroups(providers?: Providers, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - claudeFetchedAt < CLAUDE_REFRESH_MS) return;
  if (claudeRefresh) return claudeRefresh;
  claudeRefresh = (async () => {
    try {
      const apiModels = await discoverClaudeModelsFromApi(providers);
      if (apiModels.length) { setClaudeModels(apiModels, 'api'); return; }
      const cliModels = discoverClaudeModelsFromBinary();
      if (cliModels.length) { setClaudeModels(cliModels, 'cli'); return; }
      setClaudeModels(FALLBACK_CLAUDE_MODELS, 'fallback');
    } finally {
      claudeRefresh = null;
    }
  })();
  return claudeRefresh;
}

export function modelByKey(key: string | undefined): ModelDescriptor | undefined {
  return key ? dynamicAll.find(m => m.key === key) : undefined;
}

/** Picker key → the engine + model the runner understands. Unrunnable providers
    (Cursor today) resolve to engine undefined so callers fall back honestly. */
export function resolveModelKey(key: string | undefined): { engine?: EngineId; model?: string } {
  if (key?.startsWith('claude:')) return { engine: 'claude', model: key.slice('claude:'.length) || undefined };
  if (key?.startsWith('codex:')) return { engine: 'codex', model: key.slice('codex:'.length) || undefined };
  const d = modelByKey(key);
  if (!d) return {};
  if (d.provider === 'claude') return { engine: 'claude', model: d.id || undefined };
  if (d.provider === 'codex') return { engine: 'codex', model: d.id || undefined };
  return {}; // cursor — not a runnable engine yet
}

/** Reverse: an engine + model id → the picker key, to show the current selection. */
export function keyForRun(engine: EngineId | undefined, model: string | undefined): string {
  if (engine === 'codex') { const d = CODEX_MODELS.find(m => m.id === model); return d?.key ?? 'codex:gpt-5.5'; }
  const d = claudeModels.find(m => m.id === model);
  return d?.key ?? (model ? `claude:${model}` : claudeModels[0]?.key ?? 'claude:claude-opus-4-8');
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
    { provider: 'claude', label: claudeSource === 'api' ? 'Claude models' : claudeSource === 'cli' ? 'Claude Code models' : 'Claude models', runnable: s.claude.available, reason: s.claude.reason, models: claudeModels },
    { provider: 'codex',  label: 'Codex',       runnable: s.codex.available,  reason: s.codex.reason,  models: CODEX_MODELS },
    { provider: 'cursor', label: 'Cursor',      runnable: cur.available,      reason: cur.reason,      models: CURSOR_MODELS },
  ];
}
