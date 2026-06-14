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

export function registerRegistry(app: FastifyInstance): void {
  const manifest = loadManifest();
  const byId = new Map(manifest.skills.map(s => [s.id, s]));
  const contentCache = new Map<string, { name: string; skillMd: string }>();

  app.get('/registry/meta', async () => ({
    count: manifest.count, generatedAt: manifest.generatedAt, source: manifest.source, note: manifest.note,
  }));

  // Search / list — the discovery surface the agent + UI hit.
  app.get('/registry/skills', async (req) => {
    const { q = '', limit } = (req.query ?? {}) as { q?: string; limit?: string };
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
    return { count: manifest.count, results: search(manifest.skills, q, n).map(summary) };
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
