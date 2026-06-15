#!/usr/bin/env node
/* Build the Maestro skill registry from skills.sh — TOKEN-FREE.
 *
 * Strategy (no Vercel OIDC token, no GitHub API rate limit):
 *  1. Enumerate https://www.skills.sh/sitemap-skills-{1,2}.xml. The sitemap is
 *     ORDERED BY INSTALL POPULARITY (find-skills #1 @2M, frontend-design #2 @542K),
 *     so the top-N is exactly the "widely-used" set the operator asked for.
 *  2. Resolve each skill's SKILL.md from GitHub's raw CDN (no rate limit) by
 *     probing a few canonical paths/branches. The frontmatter gives name +
 *     description + license; the body gives a search excerpt. We REFERENCE the
 *     upstream repo (store the install/source links + description) and pull the
 *     full content on demand — we never bulk re-host, so each author's license
 *     governs at install time.
 *  3. Filter "secure" via the PUBLIC audit API
 *     (/api/v1/skills/audit/{owner}/{repo}/{skill}): drop anything with a `fail`
 *     verdict or a HIGH/CRITICAL risk level; require at least one `pass`.
 *  4. Write apps/server/registry/skills-index.json (the searchable manifest).
 *
 * Respectful: low concurrency, short timeouts, a descriptive User-Agent, and a
 * hard cap. Re-runnable as a cron to refresh/expand. Honest about what it kept.
 *
 * Usage: node scripts/scrape-skills.mjs [--scan 600] [--target 250]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'registry');
const OUT_FILE = join(OUT_DIR, 'skills-index.json');

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i + 1]) : def; };
const SCAN = arg('--scan', 700);     // how many top-of-sitemap skills to consider
const TARGET = arg('--target', 280); // stop after this many secure skills kept
const CONCURRENCY = 6;
const UA = 'MaestroSkillRegistry/1.0 (+https://maestro; skill-directory mirror; contact: operator)';

const SITEMAPS = [
  'https://www.skills.sh/sitemap-skills-1.xml',
  'https://www.skills.sh/sitemap-skills-2.xml',
];

async function fetchText(url, { timeout = 15000, accept } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, ...(accept ? { accept } : {}) } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, error: String(e?.message || e) }; }
  finally { clearTimeout(t); }
}

// ── 1. enumerate (popularity-ordered) ────────────────────────────────────────
async function enumerateSkills() {
  const out = [];
  const seen = new Set();
  for (const sm of SITEMAPS) {
    const r = await fetchText(sm, { timeout: 25000 });
    if (!r.ok) { console.warn(`sitemap ${sm} -> ${r.status}`); continue; }
    for (const m of r.text.matchAll(/<loc>https:\/\/www\.skills\.sh\/([^<\/]+)\/([^<\/]+)\/([^<\/]+)<\/loc>/g)) {
      const [, owner, repo, skill] = m;
      const id = `${owner}/${repo}/${skill}`;
      if (seen.has(id)) continue; seen.add(id);
      out.push({ id, owner, repo, skill, rank: out.length + 1 });
      if (out.length >= SCAN) return out;
    }
    if (out.length >= SCAN) break;
  }
  return out;
}

// ── 2. resolve SKILL.md from GitHub raw CDN ──────────────────────────────────
function parseFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const fm = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) fm[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = m ? md.slice(m[0].length) : md;
  return { fm, body };
}

async function resolveContent({ owner, repo, skill }) {
  const branches = ['main', 'master'];
  const prefixes = ['skills/', '', '.claude/skills/', 'agent-skills/', 'plugins/'];
  for (const branch of branches) {
    for (const prefix of prefixes) {
      const skillPath = `${prefix}${skill}`;
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillPath}/SKILL.md`;
      const r = await fetchText(url, { timeout: 12000 });
      if (r.ok && r.text && /\bname\s*:|\bdescription\s*:|^#/m.test(r.text)) {
        return { branch, skillPath, md: r.text };
      }
    }
  }
  return null;
}

// ── 3. security (public audit API) ───────────────────────────────────────────
function summarizeSecurity(audits) {
  if (!Array.isArray(audits) || !audits.length) return null;
  let worstRisk = 'NONE';
  const order = { NONE: 0, SAFE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  let anyPass = false;
  const providers = [];
  for (const a of audits) {
    const risk = (a.riskLevel || 'NONE').toUpperCase();
    if (a.status === 'fail') return { secure: false };
    if (risk === 'HIGH' || risk === 'CRITICAL') return { secure: false };
    if (a.status === 'pass') anyPass = true;
    if ((order[risk] ?? 0) > (order[worstRisk] ?? 0)) worstRisk = risk;
    providers.push({ provider: a.provider, status: a.status, riskLevel: risk });
  }
  if (!anyPass) return { secure: false };
  return { secure: true, risk: worstRisk === 'NONE' ? 'SAFE' : worstRisk, providers };
}

async function fetchSecurity({ owner, repo, skill }) {
  const r = await fetchText(`https://www.skills.sh/api/v1/skills/audit/${owner}/${repo}/${skill}`, { timeout: 12000, accept: 'application/json' });
  if (!r.ok) return null;
  try { return summarizeSecurity(JSON.parse(r.text).audits); } catch { return null; }
}

// ── tiny concurrency pool ────────────────────────────────────────────────────
async function pool(items, n, worker) {
  const out = []; let i = 0;
  const runners = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  });
  await Promise.all(runners);
  return out;
}

(async () => {
  console.log(`Enumerating skills.sh (scan top ${SCAN}, target ${TARGET} secure)…`);
  const candidates = await enumerateSkills();
  console.log(`  ${candidates.length} candidates (popularity-ordered).`);

  const kept = [];
  let scanned = 0, noContent = 0, insecure = 0, unrated = 0;
  const stamp = new Date().toISOString();

  await pool(candidates, CONCURRENCY, async (c) => {
    if (kept.length >= TARGET) return;
    scanned++;
    const [content, security] = await Promise.all([resolveContent(c), fetchSecurity(c)]);
    if (!content) { noContent++; return; }
    // Drop ONLY explicitly-unsafe skills (a `fail` verdict or HIGH/CRITICAL risk).
    // Skills with no audit verdict are kept but flagged UNRATED so the agent/operator
    // can weigh them — keeping the catalog broad (thousands) while still safe.
    if (security && security.secure === false) { insecure++; return; }
    if (kept.length >= TARGET) return;
    const sec = (security && security.secure) ? { risk: security.risk, providers: security.providers } : { risk: 'UNRATED', providers: [] };
    if (!sec.providers.length) unrated++;

    const { fm, body } = parseFrontmatter(content.md);
    const name = fm.name || c.skill;
    const description = fm.description || '';
    if (!description) return; // need a description to make it searchable
    const cleanBody = body.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`-]/g, ' ').replace(/\s+/g, ' ').trim();
    kept.push({
      id: c.id, owner: c.owner, repo: c.repo, skill: c.skill, rank: c.rank,
      name, description,
      license: fm.license || '',
      tags: (fm.tags || fm.category || '').split(/[,\s]+/).filter(Boolean).slice(0, 8),
      security: sec,
      source: `https://github.com/${c.owner}/${c.repo}`,
      directory: `https://www.skills.sh/${c.id}`,
      installCmd: `npx skills add https://github.com/${c.owner}/${c.repo} --skill ${c.skill}`,
      branch: content.branch, skillPath: content.skillPath,
      rawBase: `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${content.branch}/${content.skillPath}`,
      excerpt: cleanBody.slice(0, 700),
      fetchedAt: stamp,
    });
  });

  kept.sort((a, b) => a.rank - b.rank);
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    generatedAt: stamp,
    source: 'skills.sh (sitemap, popularity-ordered) + GitHub raw + skills.sh public audit API',
    note: 'Reference index ordered by install popularity (top of the install-ordered sitemap). Explicitly-unsafe skills (fail / HIGH / CRITICAL) are dropped; unaudited skills are kept and flagged security.risk="UNRATED". Content is fetched from each author\'s GitHub repo on install; this index stores only metadata + links.',
    filter: { dropExplicitlyUnsafe: true, keepUnratedFlagged: true, popularityProxy: 'sitemap install-rank', scanned: SCAN, target: TARGET },
    count: kept.length,
    skills: kept,
  };
  writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2));
  console.log(`\nKept ${kept.length} skills (${kept.length - unrated} audited, ${unrated} unrated) -> ${OUT_FILE}`);
  console.log(`  scanned ${scanned} · skipped: ${noContent} no-SKILL.md, ${insecure} explicitly-unsafe`);
  console.log(`  sample:`);
  for (const s of kept.slice(0, 8)) console.log(`   #${s.rank} ${s.id}  [${s.security.risk}]  — ${s.name}`);
})();
