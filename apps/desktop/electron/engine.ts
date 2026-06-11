/* Local engines — jobs execute ON THIS MAC on the operator's own logins:
   - claude → Claude Agent SDK riding the Claude Code subscription (`claude login`)
   - codex  → `codex exec` riding the Codex (ChatGPT) sign-in
   Routing decides which engine plays which role (master agent / reviewer);
   a per-job override can force either. The reviewer role, when enabled, runs a
   real second pass on the other engine and appends its verdict to the output. */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Store, Job, Effort, EngineId } from './store.js';
import { claudeLoggedIn, codexLoggedIn } from './providers.js';

const EFFORT_TURNS: Record<string, number> = { fast: 2, balanced: 4, deep: 8, max: 16 };

interface EngineRun {
  text: string;
  tokens: number;
  cost: number;
  model: string;
}

function workDirFor(projectName?: string): string {
  const safe = (projectName || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  const dir = path.join(homedir(), 'Maestro', safe);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
}

/* ── Claude (Agent SDK on the subscription login) ───────────────────── */
async function runClaude(prompt: string, cwd: string, effort: Effort, maxTurnsOverride?: number): Promise<EngineRun> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const it = query({
    prompt,
    options: { cwd, maxTurns: maxTurnsOverride ?? EFFORT_TURNS[effort] ?? 4, permissionMode: 'bypassPermissions' },
  });
  let text = '';
  let usage: { input_tokens?: number; output_tokens?: number } | null = null;
  let cost = 0;
  let model = 'claude';
  for await (const raw of it as AsyncIterable<Record<string, unknown>>) {
    const m = raw as { type?: string; message?: { content?: { type: string; text?: string }[]; model?: string }; usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number; result?: unknown };
    if (m.type === 'assistant' && m.message?.content) {
      for (const b of m.message.content) if (b.type === 'text' && b.text) text += b.text;
      model = m.message.model ?? model;
    } else if (m.type === 'result') {
      usage = m.usage ?? usage;
      cost = m.total_cost_usd ?? 0;
      if (typeof m.result === 'string' && m.result) text = m.result;
    }
  }
  return {
    text: text || '(no output)',
    tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    cost: Math.round(cost * 100) / 100,
    model,
  };
}

/* ── Codex (`codex exec` on the ChatGPT login) ──────────────────────── */
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
export function codexAvailable(): boolean {
  return codexLoggedIn() && resolveCodex() !== null;
}

function runCodex(prompt: string, cwd: string, readOnly = false): Promise<EngineRun> {
  const bin = resolveCodex();
  if (!bin) return Promise.reject(Object.assign(new Error('Codex CLI not found on this Mac'), { statusCode: 503 }));
  const outFile = path.join(tmpdir(), `maestro-codex-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check',
    '-s', readOnly ? 'read-only' : 'workspace-write',
    '-C', cwd, '-o', outFile,
    prompt,
  ];
  return new Promise<EngineRun>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15 * 60 * 1000);
    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(killer); reject(Object.assign(new Error(`Codex failed to start: ${e.message}`), { statusCode: 500 })); });
    child.on('close', (code) => {
      clearTimeout(killer);
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
        reject(Object.assign(new Error(`Codex exited ${code}: ${stderr.slice(0, 300) || 'no output'}`), { statusCode: 500 }));
        return;
      }
      // Subscription run — Codex doesn't bill per-token, so cost stays 0.
      resolve({ text: text || '(no output)', tokens, cost: 0, model: 'codex' });
    });
  });
}

/* ── Engine selection + the job runner ──────────────────────────────── */
export function engineAvailable(engine: EngineId): boolean {
  return engine === 'claude' ? claudeLoggedIn() : codexAvailable();
}

const ENGINE_LABEL: Record<EngineId, string> = { claude: 'Claude Code', codex: 'Codex' };

export class LocalEngine {
  constructor(private store: Store, private emit: (name: string, data: unknown) => void) {}

  /** Run an existing job to completion on this Mac. Resolves with the final job. */
  async run(jobId: string, opts: { effort?: Effort; engine?: EngineId } = {}): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw Object.assign(new Error('job not found'), { statusCode: 404 });
    const project = this.store.getProject(job.projectId);
    const routing = this.store.routing();

    let master: EngineId = opts.engine ?? routing.master;
    if (!engineAvailable(master)) {
      const other: EngineId = master === 'claude' ? 'codex' : 'claude';
      if (!opts.engine && engineAvailable(other)) {
        master = other; // routing target unavailable — fall back to the signed-in engine
      } else {
        const hint = master === 'claude' ? 'run `claude login` once on this Mac' : 'sign into Codex (`codex login`) on this Mac';
        const failed = this.store.updateJob(jobId, { status: 'failed', phase: 'Failed', stage: '', error: `${ENGINE_LABEL[master]} is not signed in — ${hint}, then retry.` });
        this.emit('job', failed);
        return failed;
      }
    }

    let cur = this.store.updateJob(jobId, {
      status: 'running', phase: 'Working', progress: 20, output: null, error: null,
      stage: `running on this Mac via ${ENGINE_LABEL[master]}…`,
    });
    this.emit('job', cur);

    try {
      const effort = opts.effort ?? cur.effort;
      const cwd = workDirFor(project?.name);
      const prompt = project?.instructions ? `${project.instructions}\n\n---\n\n${cur.input}` : cur.input;

      const main = master === 'claude' ? await runClaude(prompt, cwd, effort) : await runCodex(prompt, cwd);
      let output = main.text;
      let tokens = main.tokens;
      let cost = main.cost;

      // Reviewer pass — a REAL second opinion from the configured engine.
      const reviewer = routing.reviewer;
      if (reviewer !== 'off' && engineAvailable(reviewer)) {
        cur = this.store.updateJob(jobId, { progress: 80, stage: `reviewer pass via ${ENGINE_LABEL[reviewer]}…` });
        this.emit('job', cur);
        try {
          const reviewPrompt =
            `You are the reviewer. Briefly review the result below for correctness and completeness (3-5 tight bullets), ` +
            `then end with exactly one line: "Verdict: APPROVED" or "Verdict: NEEDS WORK".\n\n` +
            `## Task\n${cur.input}\n\n## Result\n${output.slice(0, 12000)}`;
          const review = reviewer === 'claude' ? await runClaude(reviewPrompt, cwd, 'fast', 1) : await runCodex(reviewPrompt, cwd, true);
          output += `\n\n―― Reviewer (${ENGINE_LABEL[reviewer]}) ――\n${review.text}`;
          tokens += review.tokens;
          cost = Math.round((cost + review.cost) * 100) / 100;
        } catch (re) {
          output += `\n\n―― Reviewer (${ENGINE_LABEL[reviewer]}) ――\n(review failed: ${re instanceof Error ? re.message : String(re)})`;
        }
      }

      const done = this.store.updateJob(jobId, {
        status: 'done', phase: 'Done', progress: 100, stage: '',
        output, tokens, cost,
      });
      this.emit('job', done);
      return done;
    } catch (e) {
      const failed = this.store.updateJob(jobId, {
        status: 'failed', phase: 'Failed', stage: '',
        error: e instanceof Error ? e.message : String(e),
      });
      this.emit('job', failed);
      return failed;
    }
  }
}
