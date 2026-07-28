/* Provider-owned model registry.

   The model list "comes from the providers": each provider (Claude Code, Codex,
   Cursor) owns its own catalog here, and `buildModelGroups()` surfaces them
   grouped, marking each provider runnable/not from the live engine status — the
   same honest "sign in" reasoning the rest of the app uses. The renderer never
   hardcodes the list; it renders whatever this returns.

   Claude entries start with Claude Code's stable aliases (opus/fable/sonnet/
   haiku), then add provider-discovered exact IDs. Codex discovers the installed
   CLI's live model catalog via `codex debug models`, falling back only when the
   CLI cannot answer. Cursor is listed but only runnable when its CLI is
   actually installed — never faked. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { bundledBinary, enginesRoot, managedBinary, systemBinary } from './engines.js';
import type { EngineId } from './store';
import type { Providers } from './providers.js';

export type ModelProviderId = 'claude' | 'codex' | 'cursor';

export interface ModelDescriptor {
  /** Stable picker id, e.g. 'claude:opus'. */
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

const DEFAULT_CLAUDE_MODEL_KEY = 'claude:opus';
const DEFAULT_CODEX_MODEL_KEY = 'codex:gpt-5.6-sol';

/* Claude Code owns these aliases. They are intentionally preferred over exact
   dated IDs so the app follows the installed CLI's current Opus/Sonnet/Fable
   mapping instead of pinning the UI to an old baked full model name. */
const CLAUDE_CODE_ALIAS_MODELS: ModelDescriptor[] = [
  { key: 'claude:opus',   id: 'opus',   label: 'Claude Opus 5',    provider: 'claude', family: 'Opus',   badge: 'NEW', tierNote: '1M context' },
  { key: 'claude:fable',  id: 'fable',  label: 'Claude Fable 5',   provider: 'claude', family: 'Fable',  badge: 'NEW', tierNote: 'Claude Code' },
  { key: 'claude:sonnet', id: 'sonnet', label: 'Claude Sonnet 5',  provider: 'claude', family: 'Sonnet', tierNote: 'Efficient' },
  { key: 'claude:haiku',  id: 'haiku',  label: 'Claude Haiku 4.5', provider: 'claude', family: 'Haiku',  tierNote: 'Fastest' },
];

const CLAUDE_ALIAS_TARGET_IDS = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-20251001-v1',
]);

const FALLBACK_CLAUDE_MODELS: ModelDescriptor[] = [...CLAUDE_CODE_ALIAS_MODELS];

/* Codex runs on the ChatGPT login via `codex exec -m <model>`. The app asks the
   installed CLI for its current catalog. These are only the offline fallback. */
const FALLBACK_CODEX_MODELS: ModelDescriptor[] = [
  { key: 'codex:gpt-5.6-sol',         id: 'gpt-5.6-sol',         label: 'GPT-5.6-Sol',         provider: 'codex', family: 'GPT', badge: 'NEW', tierNote: 'Latest frontier agentic coding model' },
  { key: 'codex:gpt-5.6-terra',       id: 'gpt-5.6-terra',       label: 'GPT-5.6-Terra',       provider: 'codex', family: 'GPT' },
  { key: 'codex:gpt-5.6-luna',        id: 'gpt-5.6-luna',        label: 'GPT-5.6-Luna',        provider: 'codex', family: 'GPT' },
  { key: 'codex:gpt-5.5',             id: 'gpt-5.5',             label: 'GPT-5.5',             provider: 'codex', family: 'GPT' },
  { key: 'codex:gpt-5.4',             id: 'gpt-5.4',             label: 'GPT-5.4',             provider: 'codex', family: 'GPT' },
  { key: 'codex:gpt-5.4-mini',        id: 'gpt-5.4-mini',        label: 'GPT-5.4-Mini',        provider: 'codex', family: 'GPT' },
  { key: 'codex:gpt-5.3-codex-spark', id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', provider: 'codex', family: 'GPT', tierNote: 'Coding-tuned' },
];
const CURSOR_MODELS: ModelDescriptor[] = [
  { key: 'cursor:composer', id: 'composer',      label: 'Composer',  provider: 'cursor', family: 'Composer', external: true, tierNote: 'Cursor agent' },
];

let claudeModels: ModelDescriptor[] = FALLBACK_CLAUDE_MODELS;
let codexModels: ModelDescriptor[] = FALLBACK_CODEX_MODELS;
let dynamicAll: ModelDescriptor[] = [...claudeModels, ...codexModels, ...CURSOR_MODELS];
let catalogRefresh: Promise<void> | null = null;
let catalogFetchedAt = 0;
let claudeSource: 'fallback' | 'api' | 'cli' = 'fallback';
let codexSource: 'fallback' | 'cli' = 'fallback';
const MODEL_REFRESH_MS = 60_000;

function rebuildDynamicAll(): void {
  dynamicAll = [...claudeModels, ...codexModels, ...CURSOR_MODELS];
}

function setClaudeModels(models: ModelDescriptor[], source: typeof claudeSource): void {
  if (!models.length) return;
  const seen = new Set<string>();
  const merged = [
    ...CLAUDE_CODE_ALIAS_MODELS,
    ...models.filter((m) => !CLAUDE_ALIAS_TARGET_IDS.has(m.id)),
  ];
  claudeModels = merged.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  claudeSource = source;
  rebuildDynamicAll();
}

function setCodexModels(models: ModelDescriptor[], source: typeof codexSource): void {
  if (!models.length) return;
  const seen = new Set<string>();
  codexModels = models.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  codexSource = source;
  rebuildDynamicAll();
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
    if (id === 'opus') return 900 * 1e12;
    if (id === 'fable') return 850 * 1e12;
    if (id === 'sonnet') return 800 * 1e12;
    if (id === 'haiku') return 750 * 1e12;
    const fam = id.includes('fable') ? 500 : id.includes('opus') ? 400 : id.includes('sonnet') ? 300 : id.includes('haiku') ? 200 : 100;
    const nums = [...id.matchAll(/\d+/g)].map((x) => Number(x[0])).filter(Number.isFinite);
    return fam * 1e12 + nums.reduce((n, x) => n * 1000 + Math.min(x, 999), 0);
  };
  return score(b) - score(a);
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

function codexBinary(): string | null {
  return systemBinary('codex') ?? managedBinary(enginesRoot(), 'codex') ?? bundledBinary('codex');
}

function familyOfCodexId(id: string): string {
  const s = id.toLowerCase();
  if (s.startsWith('gpt-')) return 'GPT';
  if (/^o\d/.test(s)) return 'o-series';
  return 'Codex';
}

function labelForCodexId(id: string, displayName?: string): string {
  if (displayName?.trim()) return displayName.trim();
  return id
    .split('-')
    .map((part) => part.toLowerCase() === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function discoverCodexModelsFromCli(): ModelDescriptor[] {
  const bin = codexBinary();
  if (!bin) return [];
  try {
    const raw = execFileSync(bin, ['debug', 'models'], { encoding: 'utf8', timeout: 6000, maxBuffer: 16 * 1024 * 1024 });
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    const rows = parsed.models
      .map((entry, index) => {
        const m = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const id = typeof m.slug === 'string' ? m.slug.trim() : '';
        if (!id || m.visibility === 'hide') return null;
        const priority = typeof m.priority === 'number' && Number.isFinite(m.priority) ? m.priority : 10_000 + index;
        const displayName = typeof m.display_name === 'string' ? m.display_name : undefined;
        const description = typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').trim() : '';
        const desc: ModelDescriptor = {
          key: `codex:${id}`,
          id,
          label: labelForCodexId(id, displayName),
          provider: 'codex',
          family: familyOfCodexId(id),
          ...(description ? { tierNote: description.replace(/\.$/, '') } : {}),
        };
        return { desc, priority, index };
      })
      .filter((row): row is { desc: ModelDescriptor; priority: number; index: number } => !!row)
      .sort((a, b) => a.priority - b.priority || a.index - b.index);
    return rows.map((row, index) => ({ ...row.desc, ...(index === 0 ? { badge: 'NEW' as const } : {}) }));
  } catch {
    return [];
  }
}

export async function refreshModelGroups(providers?: Providers, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - catalogFetchedAt < MODEL_REFRESH_MS) return;
  if (catalogRefresh) return catalogRefresh;
  catalogRefresh = (async () => {
    try {
      let apiModels: ModelDescriptor[] = [];
      try { apiModels = await discoverClaudeModelsFromApi(providers); } catch { apiModels = []; }
      if (apiModels.length) { setClaudeModels(apiModels, 'api'); return; }
      setClaudeModels(FALLBACK_CLAUDE_MODELS, 'fallback');
    } finally {
      const cliCodexModels = discoverCodexModelsFromCli();
      if (cliCodexModels.length) setCodexModels(cliCodexModels, 'cli');
      else setCodexModels(FALLBACK_CODEX_MODELS, 'fallback');
      catalogFetchedAt = Date.now();
      catalogRefresh = null;
    }
  })();
  return catalogRefresh;
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
  if (engine === 'codex') { const d = codexModels.find(m => m.id === model); return d?.key ?? DEFAULT_CODEX_MODEL_KEY; }
  const d = claudeModels.find(m => m.id === model);
  return d?.key ?? (model ? `claude:${model}` : claudeModels[0]?.key ?? DEFAULT_CLAUDE_MODEL_KEY);
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
    { provider: 'codex',  label: codexSource === 'cli' ? 'Codex models' : 'Codex', runnable: s.codex.available,  reason: s.codex.reason,  models: codexModels },
    { provider: 'cursor', label: 'Cursor',      runnable: cur.available,      reason: cur.reason,      models: CURSOR_MODELS },
  ];
}
