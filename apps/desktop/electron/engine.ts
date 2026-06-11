/* Local engine — jobs execute ON THIS MAC via the Claude Agent SDK, riding the
   operator's own Claude Code subscription login (`claude login`). No API key in
   the app; single-operator individual use, exactly Anthropic's licensed model.

   Proven on this machine: claude-opus-4-8, real usage + cost from the SDK. */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Store, Job, Effort } from './store.js';
import { claudeLoggedIn } from './providers.js';

const EFFORT_TURNS: Record<string, number> = { fast: 2, balanced: 4, deep: 8, max: 16 };

function workDirFor(projectName?: string): string {
  const safe = (projectName || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  const dir = path.join(homedir(), 'Maestro', safe);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
}

export class LocalEngine {
  constructor(private store: Store, private emit: (name: string, data: unknown) => void) {}

  /** Run an existing job to completion on this Mac. Resolves with the final job. */
  async run(jobId: string, effortOverride?: Effort): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw Object.assign(new Error('job not found'), { statusCode: 404 });
    const project = this.store.getProject(job.projectId);

    if (!claudeLoggedIn()) {
      const failed = this.store.updateJob(jobId, {
        status: 'failed', phase: 'Failed', stage: '',
        error: 'Claude Code is not signed in on this Mac — run `claude login` once, then retry.',
      });
      this.emit('job', failed);
      return failed;
    }

    let cur = this.store.updateJob(jobId, { status: 'running', phase: 'Working', progress: 20, output: null, error: null, stage: 'running on this Mac via Claude Code…' });
    this.emit('job', cur);

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const effort = effortOverride ?? cur.effort;
      const prompt = project?.instructions ? `${project.instructions}\n\n---\n\n${cur.input}` : cur.input;
      const it = query({
        prompt,
        options: { cwd: workDirFor(project?.name), maxTurns: EFFORT_TURNS[effort] ?? 4, permissionMode: 'bypassPermissions' },
      });

      let text = '';
      let usage: { input_tokens?: number; output_tokens?: number } | null = null;
      let cost = 0;
      for await (const raw of it as AsyncIterable<Record<string, unknown>>) {
        const m = raw as { type?: string; message?: { content?: { type: string; text?: string }[] }; usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number; result?: unknown };
        if (m.type === 'assistant' && m.message?.content) {
          for (const b of m.message.content) if (b.type === 'text' && b.text) text += b.text;
          cur = this.store.updateJob(jobId, { progress: 60, stage: 'streaming output…' });
          this.emit('job', cur);
        } else if (m.type === 'result') {
          usage = m.usage ?? usage;
          cost = m.total_cost_usd ?? 0;
          if (typeof m.result === 'string' && m.result) text = m.result;
        }
      }
      const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
      const done = this.store.updateJob(jobId, {
        status: 'done', phase: 'Done', progress: 100, stage: '',
        output: text || '(no output)', tokens, cost: Math.round(cost * 100) / 100,
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
