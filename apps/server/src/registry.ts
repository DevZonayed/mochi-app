/* Skill Registry — the ONE sanctioned exception to "the server owns nothing".
 *
 * This is read-only REFERENCE CONTENT (a curated, security-filtered index of
 * agent skills scraped from skills.sh, see scripts/scrape-skills.mjs), not
 * operator domain data. It is namespaced under /registry/* — strictly distinct
 * from the Mac-mirroring /api/* surface — and is intentionally PUBLIC (outside
 * the pairing-token gate) because the desktop AGENT must be able to search and
 * fetch skills even when no Mac is paired. We never re-host skill source: the
 * index stores metadata + links, and content is proxied from each author's
 * GitHub repo on demand (governed by that repo's license).
 */

import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers';

export interface RegistrySkill {
  id: string; owner: string; repo: string; skill: string; rank: number;
  name: string; description: string; license: string; tags: string[];
  security: { risk: string; providers: { provider: string; status: string; riskLevel: string }[] };
  source: string; directory: string; installCmd: string;
  branch: string; skillPath: string; rawBase: string; excerpt: string; fetchedAt: string;
}
interface Manifest { generatedAt: string; source: string; note: string; count: number; skills: RegistrySkill[] }

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadManifest(): Manifest {
  // Resolve the index next to src/ (dev) or dist/ (prod) or the cwd.
  const candidates = [
    join(__dirname, '..', 'registry', 'skills-index.json'),
    join(__dirname, '..', '..', 'registry', 'skills-index.json'),
    join(process.cwd(), 'registry', 'skills-index.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')) as Manifest; } catch { /* try next */ }
    }
  }
  return { generatedAt: '', source: '', note: 'registry index not built — run scripts/scrape-skills.mjs', count: 0, skills: [] };
}

/** Lightweight ranked search over name + tags + description + excerpt. */
function search(skills: RegistrySkill[], q: string, limit: number): RegistrySkill[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return skills.slice(0, limit);
  const scored: { s: RegistrySkill; score: number }[] = [];
  for (const s of skills) {
    const name = s.name.toLowerCase(), desc = s.description.toLowerCase();
    const tags = s.tags.join(' ').toLowerCase(), exc = s.excerpt.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name === t) score += 60;
      else if (name.includes(t)) score += 30;
      if (tags.includes(t)) score += 14;
      if (desc.includes(t)) score += 10;
      if (exc.includes(t)) score += 3;
    }
    // popularity nudge (lower rank = more installed)
    if (score > 0) { score += Math.max(0, 12 - Math.log2(s.rank + 1)); scored.push({ s, score }); }
  }
  scored.sort((a, b) => b.score - a.score || a.s.rank - b.s.rank);
  return scored.slice(0, limit).map(x => x.s);
}

const summary = (s: RegistrySkill) => ({
  id: s.id, name: s.name, description: s.description, tags: s.tags, license: s.license,
  risk: s.security?.risk ?? 'UNKNOWN', source: s.source, directory: s.directory,
  installCmd: s.installCmd, rank: s.rank,
});

/* ── Semantic search (embeddings) ──────────────────────────────────────────
   Precomputed int8 vectors (scripts/embed-skills.mjs) + a tiny local model
   (all-MiniLM-L6-v2) embed the QUERY at request time → cosine top-K. Only the
   top few results are returned, so it scales to thousands of skills with a tiny
   context footprint. The relay is plain Node, so the model loads cleanly here
   (it does NOT in Electron's main process). Falls back to keyword search until
   the model is warm or if anything fails. */
const MODEL = 'Xenova/all-MiniLM-L6-v2';
interface Vectors { dim: number; scale: number; ids: string[]; mat: Int8Array }

function loadVectors(): Vectors | null {
  const candidates = [
    join(__dirname, '..', 'registry', 'skills-vectors.json'),
    join(__dirname, '..', '..', 'registry', 'skills-vectors.json'),
    join(process.cwd(), 'registry', 'skills-vectors.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { dim: number; scale: number; ids: string[]; data: string };
      return { dim: j.dim, scale: j.scale || 127, ids: j.ids, mat: new Int8Array(Buffer.from(j.data, 'base64').buffer) };
    } catch { /* try next */ }
  }
  return null;
}

let extractorP: Promise<FeatureExtractionPipeline> | null = null;
function ensureExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorP) {
    env.allowLocalModels = false;
    extractorP = pipeline('feature-extraction', MODEL, { quantized: true })
      .catch((e: unknown) => { extractorP = null; throw e; }) as Promise<FeatureExtractionPipeline>;
  }
  return extractorP;
}
async function embedQuery(q: string): Promise<Float32Array> {
  const ex = await ensureExtractor();
  const o = await ex(q, { pooling: 'mean', normalize: true });
  return o.data as Float32Array;
}
function semanticTopK(v: Vectors, qVec: Float32Array, byId: Map<string, RegistrySkill>, limit: number): RegistrySkill[] {
  const { dim, scale, ids, mat } = v;
  const scored: { id: string; score: number }[] = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    let dot = 0; const base = i * dim;
    for (let d = 0; d < dim; d++) dot += qVec[d] * mat[base + d];
    scored[i] = { id: ids[i], score: dot / scale };
  }
  scored.sort((a, b) => b.score - a.score);
  const out: RegistrySkill[] = [];
  for (const x of scored) { const s = byId.get(x.id); if (s) out.push(s); if (out.length >= limit) break; }
  return out;
}
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);

export function registerRegistry(app: FastifyInstance): void {
  const manifest = loadManifest();
  const byId = new Map(manifest.skills.map(s => [s.id, s]));
  const contentCache = new Map<string, { name: string; skillMd: string }>();
  const vectors = loadVectors();
  if (vectors) ensureExtractor().catch(() => { /* pre-warm; falls back to keyword until ready */ });

  app.get('/registry/meta', async () => ({
    count: manifest.count, generatedAt: manifest.generatedAt, source: manifest.source, note: manifest.note,
    semantic: !!vectors,
  }));

  // Search / list — the discovery surface the agent + UI hit. Semantic (embedding)
  // ranking when a query + vectors are available; keyword otherwise / until warm.
  app.get('/registry/skills', async (req) => {
    const { q = '', limit } = (req.query ?? {}) as { q?: string; limit?: string };
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
    if (q && vectors) {
      try {
        const qVec = await withTimeout(embedQuery(q), 8000);
        if (qVec) return { count: manifest.count, mode: 'semantic', results: semanticTopK(vectors, qVec, byId, n).map(summary) };
      } catch { /* fall through to keyword */ }
    }
    return { count: manifest.count, mode: 'keyword', results: search(manifest.skills, q, n).map(summary) };
  });

  // Full record for one skill.
  app.get('/registry/skill', async (req, reply) => {
    const { id } = (req.query ?? {}) as { id?: string };
    const s = id ? byId.get(id) : undefined;
    if (!s) return reply.code(404).send({ error: 'skill not found' });
    return s;
  });

  // Proxy-fetch the SKILL.md from the author's GitHub repo (cached). This is what
  // a client writes into <project>/.claude/skills/<skill>/SKILL.md to install it.
  app.get('/registry/skill/content', async (req, reply) => {
    const { id } = (req.query ?? {}) as { id?: string };
    const s = id ? byId.get(id) : undefined;
    if (!s) return reply.code(404).send({ error: 'skill not found' });
    const cached = contentCache.get(s.id);
    if (cached) return { id: s.id, ...cached };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${s.rawBase}/SKILL.md`, { signal: ctrl.signal, headers: { 'user-agent': 'MaestroSkillRegistry/1.0' } });
      clearTimeout(t);
      if (!r.ok) return reply.code(502).send({ error: `upstream ${r.status}` });
      const skillMd = await r.text();
      const payload = { name: s.name, skillMd };
      contentCache.set(s.id, payload);
      return { id: s.id, ...payload };
    } catch (e) {
      return reply.code(502).send({ error: `fetch failed: ${String((e as Error)?.message || e)}` });
    }
  });
}
