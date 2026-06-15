#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.MAESTRO_REGISTRY_DB || process.argv[2] || join(__dirname, '..', 'registry', 'maestro-registry.sqlite');
const hydrate = process.argv.includes('--hydrate');
const limitFlag = process.argv.indexOf('--limit');
const limit = limitFlag >= 0 ? Number(process.argv[limitFlag + 1] || 0) : 0;

if (!existsSync(dbPath)) {
  console.error(`Registry DB not found: ${dbPath}`);
  process.exit(2);
}

const db = new Database(dbPath);
const one = (sql, params = []) => db.prepare(sql).get(params);
const all = (sql, params = []) => db.prepare(sql).all(params);
const counts = {
  skills: one('SELECT COUNT(*) AS n FROM skills').n,
  enabled: one('SELECT COUNT(*) AS n FROM skills WHERE enabled=1').n,
  embeddings: one('SELECT COUNT(*) AS n FROM skill_embeddings').n,
  uniqueRepos: one("SELECT COUNT(DISTINCT owner || '/' || repo) AS n FROM skills").n,
  cachedVersions: one('SELECT COUNT(*) AS n FROM skill_versions WHERE skill_md IS NOT NULL AND sha256 IS NOT NULL').n,
  commitPinned: one("SELECT COUNT(*) AS n FROM skills WHERE commit_sha IS NOT NULL AND commit_sha != ''").n,
  disabled: one('SELECT COUNT(*) AS n FROM skills WHERE enabled=0').n,
};

async function fetchLatestCommitSha(row) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const url = new URL(`https://api.github.com/repos/${row.owner}/${row.repo}/commits`);
  url.searchParams.set('sha', row.branch || 'main');
  url.searchParams.set('path', `${row.skill_path}/SKILL.md`.replace(/^\/+/, ''));
  url.searchParams.set('per_page', '1');
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'MaestroSkillRegistry/1.0',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return row.commit_sha || null;
    const commits = await res.json();
    return commits?.[0]?.sha || row.commit_sha || null;
  } catch {
    return row.commit_sha || null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSkill(row) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${row.raw_base}/SKILL.md`, { signal: ctrl.signal, headers: { 'user-agent': 'MaestroSkillRegistry/1.0' } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const skillMd = await res.text();
    const sha = createHash('sha256').update(skillMd).digest('hex');
    const commitSha = await fetchLatestCommitSha(row);
    const ts = new Date().toISOString();
    db.prepare(`
      INSERT INTO skill_versions (skill_id, version, sha256, commit_sha, skill_md, fetched_at)
      VALUES (?, 'latest', ?, ?, ?, ?)
      ON CONFLICT(skill_id, version) DO UPDATE SET
        sha256=excluded.sha256, commit_sha=excluded.commit_sha, skill_md=excluded.skill_md, fetched_at=excluded.fetched_at
    `).run(row.id, sha, commitSha, skillMd, ts);
    db.prepare('UPDATE skills SET sha256=?, commit_sha=?, updated_at=? WHERE id=?').run(sha, commitSha, ts, row.id);
    db.prepare(`
      UPDATE skills
      SET mirror_repo=NULL, fork_status='source-ok', last_sync_at=?, updated_at=?
      WHERE id=?
    `).run(ts, ts, row.id);
    db.prepare(`
      UPDATE skill_sources
      SET mirror_repo=NULL, fork_status='source-ok', last_sync_at=?, failure_reason=NULL, updated_at=?
      WHERE skill_id=?
    `).run(ts, ts, row.id);
    return { id: row.id, ok: true, sha256: sha.slice(0, 12), commitSha: commitSha ? commitSha.slice(0, 12) : null, bytes: skillMd.length };
  } finally {
    clearTimeout(timer);
  }
}

const hydrated = [];
if (hydrate) {
  const rows = all(`
    SELECT id, owner, repo, branch, skill_path, raw_base, commit_sha
    FROM skills
    WHERE enabled=1 AND (sha256 IS NULL OR id NOT IN (SELECT skill_id FROM skill_versions WHERE version='latest' AND skill_md IS NOT NULL))
    ORDER BY rank ASC
    LIMIT ?
  `, [limit || 3000]);
  for (const row of rows) {
    try {
      const r = await fetchSkill(row);
      hydrated.push(r);
      console.log(JSON.stringify(r));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const ts = new Date().toISOString();
      db.prepare(`
        UPDATE skills
        SET mirror_repo=NULL, fork_status='source-missing', last_sync_at=?, updated_at=?
        WHERE id=?
      `).run(ts, ts, row.id);
      db.prepare(`
        UPDATE skill_sources
        SET mirror_repo=NULL, fork_status='source-missing', last_sync_at=?, failure_reason=?, updated_at=?
        WHERE skill_id=?
      `).run(ts, msg, ts, row.id);
      hydrated.push({ id: row.id, ok: false, error: msg });
      console.log(JSON.stringify({ id: row.id, ok: false, error: msg }));
    }
  }
}

const after = {
  ...counts,
  cachedVersionsAfter: one('SELECT COUNT(*) AS n FROM skill_versions WHERE skill_md IS NOT NULL AND sha256 IS NOT NULL').n,
  commitPinnedAfter: one("SELECT COUNT(*) AS n FROM skills WHERE commit_sha IS NOT NULL AND commit_sha != ''").n,
  hydrated: hydrated.length,
  hydrateFailures: hydrated.filter(x => !x.ok).length,
};

console.log(JSON.stringify(after, null, 2));
db.close();

if (after.skills !== 3000 || after.embeddings !== 3000 || after.uniqueRepos !== 444) process.exit(1);
if (hydrate && after.hydrateFailures > 0) process.exit(1);
