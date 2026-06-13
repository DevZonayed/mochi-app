/* Local engines — jobs execute ON THIS MAC on the operator's own logins:
   - claude → Claude Agent SDK riding the Claude Code subscription (`claude login`)
             or, if only an Anthropic API key is connected, on that key.
   - codex  → `codex exec` riding the Codex (ChatGPT) sign-in.
   Routing decides which engine plays which role (master agent / reviewer);
   a per-job override can force either. The reviewer role, when enabled, runs a
   real second pass on the other engine and appends its verdict to the output.

   engineStatus() is the SINGLE source of truth for "is this engine runnable" —
   the Settings pane, the run path, and every error string read from it, so the
   UI can never claim "signed in" in one place and "not signed in" in another. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Store, Job, Effort, EngineId, TranscriptItem, RoleChoice } from './store.js';
import { claudeLoggedIn, codexLoggedIn } from './providers.js';
import type { Providers } from './providers.js';

const require = createRequire(__filename);
// Agent-loop turn budget per effort. Every tool call consumes a turn, so a
// coding agent needs real headroom — 4 turns dies mid-`ls`.
const EFFORT_TURNS: Record<string, number> = { fast: 8, balanced: 24, deep: 48, max: 96 };
// Goal mode: pursue the goal autonomously over a long horizon — far more turns.
const GOAL_MAX_TURNS = 240;
const GOAL_DIRECTIVE =
  `\n\n---\n\n[Goal mode] Pursue the request above as a goal: work autonomously to ` +
  `completion. Don't stop to ask for confirmation on routine steps; plan, implement, ` +
  `test, and self-correct in a loop until the goal is fully met or you are genuinely ` +
  `blocked. If blocked, state precisely what's needed.`;
/* Streaming cadences: local windows get a frame every ≤50ms (perceptually
   realtime); disk + relay get a checkpoint every ~1s. */
const STREAM_THROTTLE_MS = 50;
const CHECKPOINT_MS = 1000;

export interface EngineStatus {
  engine: EngineId;
  available: boolean;
  method: 'subscription' | 'apiKey' | 'none';
  detail: string;
  /** Actionable hint when unavailable (empty when available). */
  reason: string;
}

interface EngineRun {
  text: string;
  tokens: number;
  cost: number;
  model: string;
  /** Claude Agent SDK session id (for chat continuity via Options.resume). */
  sdkSessionId?: string;
  /** Structured run log: text blocks, tool calls (with timings), result. */
  transcript: TranscriptItem[];
}

/** Running totals streamed during a run so the UI counts cost/tokens live. */
export interface LiveUsage { tokens: number; cost: number }

interface RunHooks {
  /** Live progress: prose-so-far + the structured transcript + running usage. Throttled by the caller. */
  onProgress?: (output: string, transcript: TranscriptItem[], usage?: LiveUsage) => void;
  signal?: AbortSignal;
  /** Receives the child process for codex so the caller can kill it on cancel. */
  onChild?: (child: ChildProcess) => void;
}

/* Per-1M-token prices for a live cost ESTIMATE (the SDK's exact total_cost_usd
   replaces it when the run finishes). Standard Anthropic pricing; cache reads
   ~10% of input, cache writes ~25% over input. */
interface Price { in: number; out: number; cacheRead: number; cacheWrite: number }
const MODEL_PRICE: Record<'opus' | 'sonnet' | 'haiku', Price> = {
  opus:   { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { in: 3,  out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku:  { in: 1,  out: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
};
function priceFor(model: string): Price {
  const m = model.toLowerCase();
  if (m.includes('opus')) return MODEL_PRICE.opus;
  if (m.includes('haiku')) return MODEL_PRICE.haiku;
  return MODEL_PRICE.sonnet; // sensible mid default (also covers 'claude'/sonnet ids)
}

/** Human-sized summary of a tool invocation's input for the chat chip. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'description', 'prompt', 'name']) {
    if (typeof i[k] === 'string' && i[k]) return (i[k] as string).slice(0, 110);
  }
  const first = Object.values(i).find(v => typeof v === 'string' && v);
  return typeof first === 'string' ? first.slice(0, 110) : '';
}

const PREVIEW_CAP = 8000;
/** For file-writing tools, a capped snapshot of the content written, so the
    chat can show a file chip + hover preview. Undefined for non-write tools. */
function toolPreview(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (!/write|edit|create|patch|notebook/i.test(name || '')) return undefined;
  const i = input as Record<string, unknown>;
  let content: string | undefined;
  if (typeof i.content === 'string') content = i.content;                 // Write
  else if (typeof i.new_string === 'string') content = i.new_string;      // Edit
  else if (typeof i.new_str === 'string') content = i.new_str;            // apply_patch variants
  else if (Array.isArray(i.edits)) content = (i.edits as Record<string, unknown>[]).map(e => (typeof e?.new_string === 'string' ? e.new_string : '')).filter(Boolean).join('\n\n'); // MultiEdit
  if (typeof content !== 'string') return undefined;
  return content.length > PREVIEW_CAP ? content.slice(0, PREVIEW_CAP) + '\n… (truncated)' : content;
}

const proseOf = (items: TranscriptItem[]): string =>
  items.filter(i => i.kind === 'text').map(i => i.text.trim()).filter(Boolean).join('\n\n');

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return ''; }
}

class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

function workDirFor(project?: { name?: string; path?: string }): string {
  // A coding project with a real folder/clone runs IN that folder.
  if (project?.path && existsSync(project.path)) return project.path;
  const safe = (project?.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  const dir = path.join(homedir(), 'Maestro', safe);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
}

/* ── Claude binary resolution (bundled SDK binary first) ─────────────── */
let claudePath: string | null | undefined;
export function resolveClaude(): string | null {
  if (claudePath !== undefined) return claudePath;
  // 1) The binary the SDK bundles for this platform/arch (always present in node_modules).
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const cand = path.join(path.dirname(pkg), 'claude');
    if (existsSync(cand)) { claudePath = cand; return claudePath; }
  } catch { /* not bundled for this platform — fall through */ }
  // 2) A `claude` on the login shell PATH.
  try {
    const found = execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (found && existsSync(found)) { claudePath = found; return claudePath; }
  } catch { /* none */ }
  // 3) Common install locations.
  for (const cand of [
    path.join(homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (existsSync(cand)) { claudePath = cand; return claudePath; }
  }
  claudePath = null;
  return claudePath;
}

/* ── Codex binary resolution ─────────────────────────────────────────── */
let codexPath: string | null | undefined;
export function resolveCodex(): string | null {
  if (codexPath !== undefined) return codexPath;
  try {
    codexPath = execFileSync('/bin/zsh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim() || null;
  } catch {
    codexPath = null;
  }
  if (!codexPath) {
    for (const cand of [
      path.join(homedir(), '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ]) {
      if (existsSync(cand)) { codexPath = cand; break; }
    }
  }
  return codexPath ?? null;
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

/* ── Claude (Agent SDK on the subscription login or a connected key) ──── */
async function runClaude(
  prompt: string, cwd: string, effort: Effort,
  apiKey: string | undefined, maxTurnsOverride: number | undefined, hooks: RunHooks,
  resume?: string, modelOverride?: string, plan?: boolean,
): Promise<EngineRun> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const binary = resolveClaude();
  let stderrTail = '';
  const it = query({
    prompt,
    options: {
      cwd,
      maxTurns: maxTurnsOverride ?? EFFORT_TURNS[effort] ?? 4,
      // Run a CLEAN coding agent: load the project's own CLAUDE.md / .claude
      // config, but NOT the operator's global ~/.claude settings — otherwise the
      // user's personal plugins/hooks/skills (continuum bootstrap, brainstorming,
      // etc.) fire inside every Maestro project instead of just doing the task.
      settingSources: ['project'],
      // Plan mode → propose a plan, no execution. Otherwise run freely on this Mac.
      permissionMode: plan ? 'plan' : 'bypassPermissions',
      includePartialMessages: !!hooks.onProgress,
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(resume ? { resume } : {}),
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      ...(apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: apiKey } as NodeJS.ProcessEnv } : {}),
      ...(hooks.signal ? { abortController: abortControllerFromSignal(hooks.signal) } : {}),
      stderr: (d: string) => { stderrTail = (stderrTail + d).slice(-2000); },
    },
  });
  /* Build a STRUCTURED transcript: each assistant message is its own text
     block, each tool/skill call is a chip with status + duration, and the
     final result closes the run. Live deltas stream into the open block;
     the complete assistant message then replaces it (authoritative text). */
  const items: TranscriptItem[] = [];
  let openText: TranscriptItem | null = null;
  const toolById = new Map<string, TranscriptItem>();

  let resultText = '';
  let usage: { input_tokens?: number; output_tokens?: number } | null = null;
  let cost = 0;
  let model = 'claude';
  let sdkSessionId: string | undefined;
  // Live usage: count GENERATED (output) tokens — monotonic, unlike input which
  // collapses once context is cached. Track per-message boundaries from the
  // stream (message_start/delta/stop) so the counter never dips between steps.
  // Cost is output-dominated on a cached agent run (input is mostly cheap cache
  // reads), so estimate from output × the model's output price; the SDK's exact
  // total_cost_usd replaces it the instant the run finishes.
  let committedOut = 0, curOut = 0;
  let finalCost: number | null = null;
  const liveUsage = (): LiveUsage => {
    const tokens = committedOut + curOut;
    const cost = finalCost != null ? finalCost : (tokens * priceFor(model).out) / 1e6;
    return { tokens, cost: Math.round(cost * 1000) / 1000 };
  };
  const progress = () => hooks.onProgress?.(proseOf(items), items, liveUsage());
  try {
    for await (const raw of it as AsyncIterable<Record<string, unknown>>) {
      if (hooks.signal?.aborted) throw new CancelledError();
      const m = raw as {
        type?: string;
        session_id?: string;
        parent_tool_use_id?: string | null;
        message?: { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }[]; model?: string };
        event?: { type?: string; delta?: { type?: string; text?: string }; usage?: { output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
        total_cost_usd?: number; result?: unknown;
      };
      if (m.session_id) sdkSessionId = m.session_id;
      // Subagent traffic surfaces through its parent Task chip — don't interleave it.
      if (m.parent_tool_use_id) continue;

      if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
        if (!openText) { openText = { kind: 'text', text: '', ts: Date.now() }; items.push(openText); }
        openText.text += m.event.delta.text ?? '';
        progress();
      } else if (m.type === 'stream_event' && m.event?.type === 'message_start') {
        curOut = 0; // a new message begins
      } else if (m.type === 'stream_event' && m.event?.type === 'message_delta' && m.event.usage) {
        curOut = m.event.usage.output_tokens ?? curOut; // cumulative for the current message
        progress();
      } else if (m.type === 'stream_event' && m.event?.type === 'message_stop') {
        committedOut += curOut; curOut = 0; // lock in this message's output
        progress();
      } else if (m.type === 'assistant' && m.message?.content) {
        model = m.message.model ?? model;
        for (const b of m.message.content) {
          if (b.type === 'text' && typeof b.text === 'string') {
            if (openText) { openText.text = b.text; openText = null; }
            else if (b.text.trim()) items.push({ kind: 'text', text: b.text, ts: Date.now() });
          } else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
            // Surface the agent's question as an interactive card, not a tool chip.
            openText = null;
            items.push({ kind: 'ask', name: 'AskUserQuestion', text: '', ask: safeJson(b.input), ts: Date.now() });
          } else if (b.type === 'tool_use') {
            openText = null;
            const t: TranscriptItem = { kind: 'tool', name: b.name ?? 'tool', text: toolDetail(b.input), toolStatus: 'running', ts: Date.now() };
            const preview = toolPreview(b.name ?? '', b.input);
            if (preview !== undefined) t.preview = preview;
            items.push(t);
            if (b.id) toolById.set(b.id, t);
          }
        }
        progress();
      } else if (m.type === 'user' && m.message?.content) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const t = toolById.get(b.tool_use_id);
            if (t) { t.toolStatus = b.is_error ? 'error' : 'done'; t.durMs = Date.now() - t.ts; }
          }
        }
        progress();
      } else if (m.type === 'result') {
        usage = m.usage ?? usage;
        cost = m.total_cost_usd ?? 0;
        if (typeof m.result === 'string') resultText = m.result;
        // Snap the live counters to the SDK's authoritative totals.
        if (usage?.output_tokens != null) { committedOut = usage.output_tokens; curOut = 0; }
        if (m.total_cost_usd != null) finalCost = m.total_cost_usd;
      }
    }
  } catch (e) {
    if (e instanceof CancelledError || hooks.signal?.aborted) throw new CancelledError();
    const detail = stderrTail.trim();
    throw new Error(`${e instanceof Error ? e.message : String(e)}${detail ? `\n${detail}` : ''}`);
  }
  // Any tool left 'running' (no matching tool_result before the stream ended)
  // would otherwise spin forever in the UI — settle it.
  for (const t of items) if (t.kind === 'tool' && t.toolStatus === 'running') { t.toolStatus = 'done'; t.durMs = Date.now() - t.ts; }
  // The result usually repeats the last text block — only add it when it's new.
  const lastText = [...items].reverse().find(i => i.kind === 'text')?.text.trim();
  if (resultText && resultText.trim() !== lastText) items.push({ kind: 'result', text: resultText, ts: Date.now() });
  hooks.onProgress?.(proseOf(items), items, liveUsage()); // final flush so the last tokens are never stranded
  const prose = proseOf(items);
  return {
    text: resultText || prose || '(no output)',
    // Final figures match what ticked live: generated tokens + reconciled cost.
    tokens: committedOut || (usage?.output_tokens ?? 0),
    cost: Math.round((finalCost ?? cost) * 1000) / 1000,
    model,
    sdkSessionId,
    transcript: items,
  };
}

/* ── Codex (`codex exec` on the ChatGPT login) ──────────────────────── */
function runCodex(prompt: string, cwd: string, hooks: RunHooks, readOnly = false, model?: string): Promise<EngineRun> {
  const bin = resolveCodex();
  if (!bin) return Promise.reject(Object.assign(new Error('Codex CLI not found on this Mac'), { statusCode: 503 }));
  const outFile = path.join(tmpdir(), `maestro-codex-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check',
    '-s', readOnly ? 'read-only' : 'workspace-write',
    ...(model ? ['-m', model] : []),
    '-C', cwd, '-o', outFile,
    prompt,
  ];
  return new Promise<EngineRun>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    hooks.onChild?.(child);
    let stdout = '';
    let stderr = '';
    let buf = '';
    let liveTokens = 0; // accumulated from turn.completed events; codex is $0 (subscription)
    const items: TranscriptItem[] = [];
    const toolById = new Map<string, TranscriptItem>();
    const progress = () => hooks.onProgress?.(proseOf(items), items, { tokens: liveTokens, cost: 0 });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 30 * 60 * 1000);
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    if (hooks.signal) {
      if (hooks.signal.aborted) onAbort();
      else hooks.signal.addEventListener('abort', onAbort, { once: true });
    }
    const consumeLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      try {
        const ev = JSON.parse(t) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number }; item?: { id?: string; type?: string; text?: string; content?: string; command?: string; path?: string; status?: string } };
        if (ev.type === 'turn.completed' && ev.usage) { liveTokens += (ev.usage.input_tokens ?? 0) + (ev.usage.output_tokens ?? 0); progress(); }
        const item = ev.item;
        if (!item) return;
        // Best-effort codex event mapping: message text → text blocks,
        // command/file activity → tool chips. Unknown shapes are ignored;
        // the -o outfile stays the authoritative final text.
        if ((item.type === 'agent_message' || item.type === 'message') && (item.text || item.content)) {
          items.push({ kind: 'text', text: item.text ?? item.content ?? '', ts: Date.now() });
          progress();
        } else if (item.type && /command|exec|file_change|patch|tool/.test(item.type)) {
          const key = item.id ?? `${item.type}-${items.length}`;
          const started = ev.type?.endsWith('started');
          const existing = toolById.get(key);
          if (existing && !started) {
            existing.toolStatus = item.status === 'failed' ? 'error' : 'done';
            existing.durMs = Date.now() - existing.ts;
          } else if (!existing) {
            const chip: TranscriptItem = {
              kind: 'tool', name: item.type.replace(/_/g, ' '),
              text: (item.command ?? item.path ?? '').slice(0, 110),
              toolStatus: started ? 'running' : 'done', ts: Date.now(),
            };
            if (!started) chip.durMs = 0;
            items.push(chip);
            toolById.set(key, chip);
          }
          progress();
        }
      } catch { /* non-JSON line */ }
    };
    child.stdout.on('data', (d: Buffer) => {
      stdout += String(d);
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { consumeLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(killer); reject(Object.assign(new Error(`Codex failed to start: ${e.message}`), { statusCode: 500 })); });
    child.on('close', (code, sig) => {
      clearTimeout(killer);
      if (hooks.signal?.aborted) { reject(new CancelledError()); return; }
      let tokens = 0;
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number } };
          if (ev.type === 'turn.completed' && ev.usage) tokens += (ev.usage.input_tokens ?? 0) + (ev.usage.output_tokens ?? 0);
        } catch { /* non-JSON line */ }
      }
      let text = '';
      try { text = readFileSync(outFile, 'utf8').trim(); } catch { /* no file */ }
      try { rmSync(outFile, { force: true }); } catch { /* best effort */ }
      if (code !== 0 && !text) {
        reject(Object.assign(new Error(`Codex exited ${code ?? sig}: ${stderr.slice(0, 300) || 'no output'}`), { statusCode: 500 }));
        return;
      }
      // Codex has no per-tool completion event — settle anything still 'running'.
      for (const t of items) if (t.kind === 'tool' && t.toolStatus === 'running') { t.toolStatus = 'done'; t.durMs = Date.now() - t.ts; }
      const lastText = [...items].reverse().find(i => i.kind === 'text')?.text.trim();
      if (text && text !== lastText) items.push({ kind: 'result', text, ts: Date.now() });
      // Subscription run — Codex doesn't bill per-token, so cost stays 0.
      resolve({ text: text || proseOf(items) || '(no output)', tokens, cost: 0, model: model ?? 'codex', transcript: items });
    });
  });
}

/* ── The job runner + the single status source ──────────────────────── */
const ENGINE_LABEL: Record<EngineId, string> = { claude: 'Claude Code', codex: 'Codex' };

export class LocalEngine {
  /** jobId → live cancel handle (abort for claude, child for codex). */
  private running = new Map<string, { ac: AbortController; child?: ChildProcess }>();

  constructor(private store: Store, private emit: (name: string, data: unknown, opts?: { live?: boolean }) => void, private providers?: Providers) {}

  /** Is this engine actually runnable right now, and if not, exactly why. */
  status(engine: EngineId): EngineStatus {
    if (engine === 'claude') {
      if (claudeLoggedIn()) return { engine, available: true, method: 'subscription', detail: 'Claude Code login', reason: '' };
      const key = this.providers?.getLocalKey('anthropic');
      if (key) return { engine, available: true, method: 'apiKey', detail: 'Anthropic API key', reason: '' };
      return { engine, available: false, method: 'none', detail: 'Not signed in', reason: 'Run `claude login` once on this Mac, or add an Anthropic API key in Settings → Accounts.' };
    }
    // codex
    const loggedIn = codexLoggedIn();
    const bin = resolveCodex();
    if (loggedIn && bin) return { engine, available: true, method: 'subscription', detail: 'Codex (ChatGPT) login', reason: '' };
    if (!bin) return { engine, available: false, method: 'none', detail: 'CLI not found', reason: 'Install the Codex CLI (`npm i -g @openai/codex`) so it is on your PATH.' };
    return { engine, available: false, method: 'none', detail: 'Not signed in', reason: 'Sign into Codex (`codex login`) on this Mac.' };
  }

  statuses(): Record<EngineId, EngineStatus> {
    return { claude: this.status('claude'), codex: this.status('codex') };
  }

  available(engine: EngineId): boolean { return this.status(engine).available; }

  /** Cancel a running job. Returns the updated (cancelled) job, or null if not running. */
  cancel(jobId: string): Job | null {
    const h = this.running.get(jobId);
    if (!h) return null;
    h.ac.abort();
    try { h.child?.kill('SIGTERM'); } catch { /* gone */ }
    this.running.delete(jobId);
    const job = this.store.getJob(jobId);
    if (!job || job.status !== 'running') return job ?? null;
    const cancelled = this.store.updateJob(jobId, { status: 'cancelled', phase: 'Cancelled', stage: '', error: null });
    this.emit('job', cancelled);
    this.store.pushEvent({ kind: 'job-cancelled', title: `Cancelled: ${cancelled.title}`, projectId: cancelled.projectId, jobId });
    return cancelled;
  }

  isRunning(jobId: string): boolean { return this.running.has(jobId); }

  /** Recent finished turns of a chat session, formatted for prompt stitching
      (codex has no resumable session, so context rides in the prompt). */
  private chatHistory(sessionId: string, excludeJobId: string): string {
    const turns = this.store.listJobs(undefined, sessionId)
      .filter(j => j.id !== excludeJobId && j.status === 'done' && j.output)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-8);
    let total = 0;
    const parts: string[] = [];
    for (const t of turns) {
      const block = `[User]: ${t.input.slice(0, 1500)}\n[Assistant]: ${(t.output ?? '').slice(0, 2500)}`;
      total += block.length;
      if (total > 12000) break;
      parts.push(block);
    }
    return parts.join('\n\n');
  }

  /** Run an existing job to completion on this Mac. Resolves with the final job. */
  async run(jobId: string, opts: { effort?: Effort; engine?: EngineId; model?: string; reviewer?: RoleChoice | 'off'; plan?: boolean; goal?: boolean } = {}): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw Object.assign(new Error('job not found'), { statusCode: 404 });
    const project = this.store.getProject(job.projectId);
    const routing = this.store.routing();
    const roles = this.store.getRoles();

    // Primary: an explicit per-job override wins; otherwise the workspace role
    // default (engine + model). Reviewer resolves the same way.
    let master: EngineId = opts.engine ?? roles.primary.engine ?? routing.master;
    const masterModel: string | undefined = opts.engine ? opts.model : (opts.model ?? roles.primary.model);
    if (!this.available(master)) {
      const other: EngineId = master === 'claude' ? 'codex' : 'claude';
      if (!opts.engine && this.available(other)) {
        master = other; // routing target unavailable — fall back to the signed-in engine
      } else {
        const failed = this.store.updateJob(jobId, { status: 'failed', phase: 'Failed', stage: '', engine: master, error: `${ENGINE_LABEL[master]} is unavailable — ${this.status(master).reason}` });
        this.emit('job', failed);
        this.store.pushEvent({ kind: 'job-failed', title: `Failed: ${failed.title}`, subtitle: failed.error ?? undefined, projectId: failed.projectId, jobId });
        return failed;
      }
    }

    const ac = new AbortController();
    const handle: { ac: AbortController; child?: ChildProcess } = { ac };
    this.running.set(jobId, handle);

    let cur = this.store.updateJob(jobId, {
      status: 'running', phase: 'Working', progress: 20, output: '', error: null, engine: master,
      ...(masterModel ? { model: masterModel } : {}),
      stage: `running on this Mac via ${ENGINE_LABEL[master]}…`,
    });
    this.emit('job', cur);

    /* Live writer at two cadences. Every frame (≤STREAM_THROTTLE_MS apart) goes
       to the local windows in-memory — that's what makes streaming feel
       realtime. Every CHECKPOINT_MS one of those frames also persists to disk
       and feeds the relay/phone. A trailing timer guarantees the tail of a
       burst lands even if no further delta arrives. */
    let lastFrame = 0;
    let lastCheckpoint = 0;
    let trailer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const pendingRef: { out: string | null; tr: TranscriptItem[]; usage?: LiveUsage } = { out: null, tr: [] };
    const sendFrame = () => {
      if (settled || pendingRef.out === null) return;
      const t = Date.now();
      lastFrame = t;
      const patch = {
        output: pendingRef.out, transcript: pendingRef.tr.slice(-250),
        progress: Math.min(70, 20 + Math.floor(pendingRef.out.length / 80)),
        // Live cost/token counters so the UI ticks them up during the run.
        ...(pendingRef.usage ? { tokens: pendingRef.usage.tokens, cost: pendingRef.usage.cost } : {}),
      };
      if (t - lastCheckpoint >= CHECKPOINT_MS) {
        lastCheckpoint = t;
        this.emit('job', this.store.updateJob(jobId, patch)); // persist + relay
      } else {
        this.emit('job', this.store.updateJobLive(jobId, patch), { live: true }); // local frame
      }
    };
    const flush = (output: string, transcript: TranscriptItem[], usage?: LiveUsage) => {
      pendingRef.out = output;
      pendingRef.tr = transcript;
      pendingRef.usage = usage;
      const wait = STREAM_THROTTLE_MS - (Date.now() - lastFrame);
      if (wait <= 0) {
        if (trailer) { clearTimeout(trailer); trailer = null; }
        sendFrame();
      } else if (!trailer) {
        trailer = setTimeout(() => { trailer = null; sendFrame(); }, wait);
      }
    };
    const settleStream = () => { settled = true; if (trailer) { clearTimeout(trailer); trailer = null; } };

    try {
      const goalMode = opts.goal === true && !opts.plan; // goal + plan are mutually exclusive
      let effort = opts.effort ?? cur.effort;
      if (goalMode && (effort === 'fast' || effort === 'balanced')) effort = 'deep'; // goal mode wants depth
      const cwd = workDirFor(project);
      const anthropicKey = this.status(master).method === 'apiKey' ? this.providers?.getLocalKey('anthropic') : undefined;

      // Chat turns: keep the conversation. Claude resumes its own SDK session
      // (full context incl. tool use); codex gets recent turns stitched in.
      const session = cur.sessionId ? this.store.getSession(cur.sessionId) : undefined;
      const isChat = !!session;
      const resumeId = isChat && master === 'claude' ? session.sdkSessionId : undefined;
      const base = project?.instructions ? `${project.instructions}\n\n---\n\n` : '';
      let prompt: string;
      if (resumeId) {
        prompt = cur.input;
      } else if (isChat) {
        const history = this.chatHistory(session.id, cur.id);
        prompt = history
          ? `${base}Earlier conversation in this chat:\n\n${history}\n\n---\n\nCurrent message:\n${cur.input}`
          : `${base}${cur.input}`;
      } else {
        prompt = `${base}${cur.input}`;
      }
      if (goalMode) prompt += GOAL_DIRECTIVE;

      const hooks: RunHooks = {
        signal: ac.signal,
        onProgress: flush,
        onChild: (child) => { handle.child = child; },
      };
      // Plan mode only applies to Claude (codex has no read-only planning mode).
      const main = master === 'claude'
        ? await runClaude(prompt, cwd, effort, anthropicKey, goalMode ? GOAL_MAX_TURNS : undefined, hooks, resumeId, masterModel, opts.plan)
        : await runCodex(prompt, cwd, hooks, false, masterModel);
      settleStream(); // stream is over — no trailing frame may race the final states below

      if (isChat && main.sdkSessionId && main.sdkSessionId !== session.sdkSessionId) {
        try { this.store.updateSession(session.id, { sdkSessionId: main.sdkSessionId }); } catch { /* session deleted mid-run */ }
      }

      let output = main.text;
      let tokens = main.tokens;
      let cost = main.cost;
      const model = main.model;

      // Reviewer pass — a REAL second opinion from the configured engine.
      // Skipped for chat turns: a conversation wants fast back-and-forth, not a
      // second engine appending verdicts to every reply.
      const reviewerChoice: RoleChoice | 'off' = opts.reviewer ?? roles.reviewer;
      const reviewer: EngineId | 'off' = reviewerChoice === 'off' ? 'off' : reviewerChoice.engine;
      const reviewerModel = reviewerChoice === 'off' ? undefined : reviewerChoice.model;
      let reviewVerdict: 'approved' | 'needs-work' | null = null;
      if (reviewer !== 'off' && !isChat && this.available(reviewer) && !ac.signal.aborted) {
        cur = this.store.updateJob(jobId, { progress: 85, stage: `reviewer pass via ${ENGINE_LABEL[reviewer]}…` });
        this.emit('job', cur);
        try {
          const reviewPrompt =
            `You are the reviewer. Briefly review the result below for correctness and completeness (3-5 tight bullets), ` +
            `then end with exactly one line: "Verdict: APPROVED" or "Verdict: NEEDS WORK".\n\n` +
            `## Task\n${cur.input}\n\n## Result\n${output.slice(0, 12000)}`;
          const review = reviewer === 'claude'
            ? await runClaude(reviewPrompt, cwd, 'fast', this.status('claude').method === 'apiKey' ? this.providers?.getLocalKey('anthropic') : undefined, 1, {}, undefined, reviewerModel)
            : await runCodex(reviewPrompt, cwd, {}, true, reviewerModel);
          output += `\n\n―― Reviewer (${ENGINE_LABEL[reviewer]}) ――\n${review.text}`;
          tokens += review.tokens;
          cost = Math.round((cost + review.cost) * 1000) / 1000;
          reviewVerdict = /verdict:\s*needs\s*work/i.test(review.text) ? 'needs-work' : 'approved';
        } catch (re) {
          if (re instanceof CancelledError) throw re;
          output += `\n\n―― Reviewer (${ENGINE_LABEL[reviewer]}) ――\n(review failed: ${re instanceof Error ? re.message : String(re)})`;
        }
      }

      const done = this.store.updateJob(jobId, {
        status: 'done', phase: 'Done', progress: 100, stage: '',
        output, tokens, cost, model, transcript: main.transcript.slice(-400),
      });
      this.running.delete(jobId);
      if (isChat) this.store.touchSession(session.id);
      this.emit('job', done);
      // Chat replies don't ping the events feed — per-message noise; failures still do.
      if (!isChat) this.store.pushEvent({ kind: 'job-done', title: `Done: ${done.title}`, projectId: done.projectId, jobId });

      // Reviewer flagged NEEDS WORK → open a real linked approval gate.
      if (reviewVerdict === 'needs-work' && reviewer !== 'off') {
        const ap = this.store.createApproval({
          projectId: done.projectId, kind: 'review', jobId,
          title: `Reviewer flagged: ${done.title}`,
          subtitle: `${ENGINE_LABEL[reviewer]} review · needs work`,
          detail: output.slice(-2000),
        });
        this.emit('approval', ap);
        this.store.pushEvent({ kind: 'approval-created', title: ap.title, projectId: done.projectId, jobId });
      }
      return done;
    } catch (e) {
      settleStream();
      this.running.delete(jobId);
      if (e instanceof CancelledError || ac.signal.aborted) {
        const existing = this.store.getJob(jobId);
        if (existing && existing.status !== 'cancelled') {
          const c = this.store.updateJob(jobId, {
            status: 'cancelled', phase: 'Cancelled', stage: '', error: null,
            output: pendingRef.out ?? existing.output,
            ...(pendingRef.tr.length ? { transcript: pendingRef.tr.slice(-250) } : {}),
          });
          this.emit('job', c);
          this.store.pushEvent({ kind: 'job-cancelled', title: `Cancelled: ${c.title}`, projectId: c.projectId, jobId });
          return c;
        }
        return existing as Job;
      }
      const failed = this.store.updateJob(jobId, {
        status: 'failed', phase: 'Failed', stage: '',
        error: e instanceof Error ? e.message : String(e),
      });
      this.emit('job', failed);
      this.store.pushEvent({ kind: 'job-failed', title: `Failed: ${failed.title}`, subtitle: failed.error ?? undefined, projectId: failed.projectId, jobId });
      return failed;
    }
  }
}

/* Back-compat free functions (used by cron) — prefer LocalEngine.status(). */
export function engineAvailable(engine: EngineId): boolean {
  if (engine === 'claude') return claudeLoggedIn();
  return codexLoggedIn() && resolveCodex() !== null;
}
export function codexAvailable(): boolean { return codexLoggedIn() && resolveCodex() !== null; }
