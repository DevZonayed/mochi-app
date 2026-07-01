/* Trend research — a real deep job on the operator's Claude/Codex login. The
   Agent SDK runs WebSearch by default, so the agent actually searches the live
   web, then returns strict-JSON content briefs which we parse (layered, with a
   fail-soft raw fallback) into the Brief feed. Runs find-or-create a single
   "Trend Research" project so runs accumulate in one place. */

import type { Store, Brief, ResearchRun } from './store.js';
import type { LocalEngine } from './engine.js';

const RESEARCH_PROJECT = 'Trend Research';

function briefsPrompt(topic: string): string {
  return [
    `You are a content strategist. Research the current state of "${topic}" using web search, then propose content ideas.`,
    `Search the live web for what's happening NOW (last few weeks). Find real, recent, specific angles — not evergreen advice.`,
    ``,
    `Return ONLY a JSON array (no prose before or after, no markdown fences) of 4-6 objects with EXACTLY these keys:`,
    `[{`,
    `  "headline": "a sharp content angle (one line)",`,
    `  "hook": "the opening line / scroll-stopper (one sentence)",`,
    `  "titles": ["three", "alternative", "titles"],`,
    `  "platforms": ["x", "linkedin", "youtube"],`,
    `  "confidence": 0.0-1.0,`,
    `  "sources": ["https://real-url-you-found", "..."]`,
    `}]`,
    ``,
    `Use real URLs you actually visited for "sources". Keep it strict JSON — it will be parsed by a machine.`,
  ].join('\n');
}

interface RawBrief { headline?: string; hook?: string; titles?: unknown; platforms?: unknown; confidence?: unknown; sources?: unknown }

/* Layered extraction: fenced ```json block → first balanced [...] array → null. */
function extractJsonArray(text: string): RawBrief[] | null {
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) return parsed as RawBrief[];
    } catch { /* try the next candidate */ }
  }
  return null;
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string').slice(0, max) as string[];
}

function toBriefs(text: string, topic: string, jobId: string): Omit<Brief, 'id' | 'createdAt'>[] {
  const raw = extractJsonArray(text);
  if (!raw || raw.length === 0) {
    // Fail-soft: keep the run useful — one raw brief holding the agent's text.
    return [{
      topic, headline: `Research notes: ${topic}`, hook: text.slice(0, 280).trim() || 'See the full transcript.',
      titles: [], platforms: [], confidence: 0, sources: [], status: 'raw', jobId,
    }];
  }
  return raw.slice(0, 8).map((b): Omit<Brief, 'id' | 'createdAt'> => ({
    topic,
    headline: typeof b.headline === 'string' ? b.headline : 'Untitled angle',
    hook: typeof b.hook === 'string' ? b.hook : '',
    titles: asStringArray(b.titles, 3),
    platforms: asStringArray(b.platforms, 6),
    confidence: typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 0.5,
    sources: asStringArray(b.sources, 8),
    status: 'ready',
    jobId,
  }));
}

export class ResearchEngine {
  constructor(private store: Store, private engine: LocalEngine, private emit: (name: string, data: unknown) => void) {}

  private findOrCreateProject(): string {
    const existing = this.store.listProjects().find(p => p.name === RESEARCH_PROJECT);
    if (existing) return existing.id;
    const p = this.store.createProject({ name: RESEARCH_PROJECT, template: 'research', kind: 'research', instructions: 'You research trends and propose content briefs as strict JSON.' });
    this.emit('project', p);
    return p.id;
  }

  /** Kick off a research run. Returns the run immediately; briefs land when the
      underlying deep job finishes (parsed from its output). */
  runResearch(topic: string): ResearchRun {
    const t = topic.trim();
    if (!t) throw Object.assign(new Error('a topic is required'), { statusCode: 400 });
    const projectId = this.findOrCreateProject();
    const job = this.store.createJob(projectId, briefsPrompt(t), `Research: ${t}`, 'deep');
    this.emit('job', job);
    const run = this.store.createResearchRun({ topic: t, jobId: job.id });
    this.emit('research', run);

    // Fire-and-forget: the engine runs the job (web search + JSON), then we parse.
    void this.engine.run(job.id, { effort: 'deep' })
      .then((done) => {
        if (done.status !== 'done' || !done.output) {
          this.store.updateResearchRun(run.id, { status: 'failed' });
          this.emit('research', this.store.listResearchRuns().find(r => r.id === run.id));
          return;
        }
        const briefs = this.store.addBriefs(toBriefs(done.output, t, job.id));
        this.store.updateResearchRun(run.id, { status: 'done', briefCount: briefs.length });
        this.emit('briefs', briefs);
        this.store.pushEvent({ kind: 'research', title: `Research ready: ${t}`, subtitle: `${briefs.length} brief${briefs.length !== 1 ? 's' : ''}`, projectId, jobId: job.id });
        this.emit('research', this.store.listResearchRuns().find(r => r.id === run.id));
      })
      .catch(() => {
        this.store.updateResearchRun(run.id, { status: 'failed' });
        this.emit('research', this.store.listResearchRuns().find(r => r.id === run.id));
      });

    return run;
  }
}
