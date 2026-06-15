/* Desktop side of the skill registry. Search hits the remote relay's read-only
 * /registry/* surface (the curated, security-filtered index scraped from
 * skills.sh — see apps/server). "Add to a project" pulls the SKILL.md from the
 * author's GitHub (proxied + cached by the relay) and writes it into the
 * project's `.claude/skills/<skill>/SKILL.md`, where the Claude Agent SDK
 * auto-discovers it (settingSources:['project']) and Codex gets it via prompt
 * injection (see engine.ts). Mac-is-the-brain: the install writes real files on
 * this Mac; only the catalog lives on the server.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import localIndex from './skills-index.json';

export interface RegistrySkillSummary {
  id: string; name: string; description: string; tags: string[]; license: string;
  risk: string; source: string; directory: string; installCmd: string; rank: number;
  enabled?: boolean; disabledReason?: string | null; version?: string; sha256?: string | null;
  sourceRepo?: string | null; sourceStatus?: string | null;
  mirrorRepo?: string | null; forkStatus?: string | null; lastSyncAt?: string | null; auditStatus?: string | null;
}

/* Mac-local fallback. The Mac is the brain: a snapshot of the registry index is
   bundled with the app, so search + install work even before the relay's
   /registry/* surface is deployed (or when offline). When the relay IS reachable
   we prefer it (single source of truth, refreshable); otherwise we search this
   copy and pull content straight from each skill's GitHub. */
interface IndexSkill {
  id: string; name: string; description: string; tags: string[]; license: string;
  security: { risk: string }; source: string; directory: string; installCmd: string;
  rank: number; rawBase: string; excerpt?: string;
}
const LOCAL = localIndex as unknown as { count: number; skills: IndexSkill[] };
const toSummary = (s: IndexSkill): RegistrySkillSummary => ({
  id: s.id, name: s.name, description: s.description, tags: s.tags || [], license: s.license || '',
  risk: s.security?.risk || 'UNKNOWN', source: s.source, directory: s.directory, installCmd: s.installCmd, rank: s.rank,
  enabled: true, version: 'latest', sourceRepo: s.id.split('/').slice(0, 2).join('/'), sourceStatus: 'bundled',
});
function localSearch(q: string, limit: number): { count: number; results: RegistrySkillSummary[] } {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { count: LOCAL.count, results: LOCAL.skills.slice(0, limit).map(toSummary) };
  const scored: { s: IndexSkill; score: number }[] = [];
  for (const s of LOCAL.skills) {
    const name = s.name.toLowerCase(), desc = (s.description || '').toLowerCase();
    const tags = (s.tags || []).join(' ').toLowerCase(), exc = (s.excerpt || '').toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name === t) score += 60; else if (name.includes(t)) score += 30;
      if (tags.includes(t)) score += 14; if (desc.includes(t)) score += 10; if (exc.includes(t)) score += 3;
    }
    if (score > 0) { score += Math.max(0, 12 - Math.log2(s.rank + 1)); scored.push({ s, score }); }
  }
  scored.sort((a, b) => b.score - a.score || a.s.rank - b.s.rank);
  return { count: LOCAL.count, results: scored.slice(0, limit).map(x => toSummary(x.s)) };
}

/** Derive the registry HTTP base from the relay WS url (or an explicit env override). */
export function registryBase(relayUrl?: string): string {
  const env = process.env['MAESTRO_REGISTRY_BASE'];
  if (env) return env.replace(/\/$/, '');
  const r = relayUrl || process.env['MAESTRO_RELAY_URL'] || 'wss://api.nexalance.cloud/ws';
  return r.replace(/^ws(s?):/, 'http$1:').replace(/\/ws$/, '').replace(/\/$/, '');
}

async function getJSON<T>(url: string, timeout = 15000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) {
      let message = `registry ${r.status}`;
      try {
        const j = await r.json() as { error?: string };
        if (j?.error) message = j.error;
      } catch { /* non-json */ }
      throw Object.assign(new Error(message), { statusCode: r.status });
    }
    return (await r.json()) as T;
  } finally { clearTimeout(t); }
}

export async function searchRegistry(base: string, q: string, limit = 30): Promise<{ count: number; results: RegistrySkillSummary[] }> {
  const u = `${base}/registry/skills?q=${encodeURIComponent(q || '')}&limit=${Math.min(Math.max(limit, 1), 100)}`;
  try { return await getJSON(u); } catch { return localSearch(q, limit); }
}

export async function registryMeta(base: string): Promise<{ count: number; generatedAt: string; source: string; note: string }> {
  try { return await getJSON(`${base}/registry/meta`); }
  catch { return { count: LOCAL.count, generatedAt: '', source: 'bundled', note: 'using the app\'s bundled index (relay registry not reachable)' }; }
}

export async function getRegistrySkill(base: string, id: string): Promise<RegistrySkillSummary & { rawBase?: string; skillPath?: string; branch?: string; excerpt?: string }> {
  try { return await getJSON(`${base}/registry/skill?id=${encodeURIComponent(id)}`); }
  catch {
    const s = LOCAL.skills.find(x => x.id === id);
    if (!s) throw Object.assign(new Error('skill not found'), { statusCode: 404 });
    return { ...toSummary(s), rawBase: s.rawBase };
  }
}

export async function fetchSkillContent(base: string, id: string): Promise<{ id: string; name: string; skillMd: string; sha256?: string; enabled?: boolean }> {
  try { return await getJSON(`${base}/registry/skill/content?id=${encodeURIComponent(id)}`); }
  catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    // A reachable registry explicitly blocking a disabled/quarantined skill is
    // authoritative. Do not bypass it with the bundled fallback.
    if (status === 401 || status === 403) throw e;
    // Fall back to pulling the SKILL.md straight from the author's GitHub.
    const s = LOCAL.skills.find(x => x.id === id);
    if (!s) throw Object.assign(new Error('skill not found'), { statusCode: 404 });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${s.rawBase}/SKILL.md`, { signal: ctrl.signal, headers: { 'user-agent': 'MaestroSkillRegistry/1.0' } });
      if (!r.ok) throw new Error(`github ${r.status}`);
      return { id, name: s.name, skillMd: await r.text() };
    } finally { clearTimeout(t); }
  }
}

/** A safe on-disk folder name for a skill (the last path segment of its id). */
export function skillSlug(id: string): string {
  return (id.split('/').pop() || id).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

/** Write a skill's SKILL.md into <projectRoot>/.claude/skills/<slug>/SKILL.md. */
export function installSkillFiles(projectRoot: string, id: string, skillMd: string): string {
  const slug = skillSlug(id);
  const dir = join(projectRoot, '.claude', 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');
  return slug;
}

export function removeSkillFiles(projectRoot: string, id: string): void {
  const slug = skillSlug(id);
  const dir = join(projectRoot, '.claude', 'skills', slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Slugs of skills physically present in the project (source of truth on disk). */
export function listInstalledSlugs(projectRoot: string): string[] {
  const dir = join(projectRoot, '.claude', 'skills');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
      .map(e => e.name);
  } catch { return []; }
}
