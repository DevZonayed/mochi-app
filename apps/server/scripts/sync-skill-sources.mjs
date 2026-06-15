#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

const dbPath = arg('db', process.env.MAESTRO_REGISTRY_DB || join(__dirname, '..', 'registry', 'maestro-registry.sqlite'));
const token = arg('token', process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '');
const limit = Number(arg('limit', '0')) || 3000;
const live = has('live') || has('sync');
const dryRun = !live || has('dry-run');
const includeFresh = has('all') || has('include-fresh');

if (!existsSync(dbPath)) {
  console.error(`Registry DB not found: ${dbPath}`);
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fetchLatestCommitSha(row) {
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
    const res = await fetch(`${row.raw_base}/SKILL.md`, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'MaestroSkillRegistry/1.0' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const skillMd = await res.text();
    const hash = sha256(skillMd);
    const commitSha = await fetchLatestCommitSha(row);
    const ts = new Date().toISOString();
    db.prepare(`
      INSERT INTO skill_versions (skill_id, version, sha256, commit_sha, skill_md, fetched_at)
      VALUES (?, 'latest', ?, ?, ?, ?)
      ON CONFLICT(skill_id, version) DO UPDATE SET
        sha256=excluded.sha256, commit_sha=excluded.commit_sha, skill_md=excluded.skill_md, fetched_at=excluded.fetched_at
    `).run(row.id, hash, commitSha, skillMd, ts);
    db.prepare(`
      UPDATE skills
      SET mirror_repo=NULL, fork_status='source-ok', sha256=?, commit_sha=?, last_sync_at=?, updated_at=?
      WHERE id=?
    `).run(hash, commitSha, ts, ts, row.id);
    db.prepare(`
      UPDATE skill_sources
      SET mirror_repo=NULL, fork_status='source-ok', last_sync_at=?, failure_reason=NULL, updated_at=?
      WHERE skill_id=?
    `).run(ts, ts, row.id);
    return { id: row.id, repo: `${row.owner}/${row.repo}`, status: 'source-ok', sha256: hash.slice(0, 12), commitSha: commitSha ? commitSha.slice(0, 12) : null };
  } finally {
    clearTimeout(timer);
  }
}

const rows = db.prepare(`
  SELECT id, owner, repo, branch, skill_path, raw_base, commit_sha
  FROM skills
  WHERE enabled=1
    AND (
      ?=1
      OR fork_status IS NULL
      OR fork_status!='source-ok'
      OR sha256 IS NULL
      OR sha256=''
      OR id NOT IN (
        SELECT skill_id FROM skill_versions
        WHERE version='latest' AND skill_md IS NOT NULL AND sha256 IS NOT NULL
      )
    )
  ORDER BY rank ASC
  LIMIT ?
`).all(includeFresh ? 1 : 0, limit);

console.log(JSON.stringify({
  dryRun,
  mode: 'upstream-source',
  includeFresh,
  dbPath,
  selected: rows.length,
  uniqueRepos: db.prepare("SELECT COUNT(DISTINCT owner || '/' || repo) AS n FROM skills").get().n,
}, null, 2));

const results = [];
for (const row of rows) {
  if (dryRun) {
    const item = { id: row.id, repo: `${row.owner}/${row.repo}`, status: 'dry-run', url: `${row.raw_base}/SKILL.md` };
    results.push(item);
    console.log(JSON.stringify(item));
    continue;
  }
  try {
    const result = await fetchSkill(row);
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
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
    `).run(ts, error, ts, row.id);
    const item = { id: row.id, repo: `${row.owner}/${row.repo}`, status: 'source-missing', error };
    results.push(item);
    console.log(JSON.stringify(item));
  }
}

const failed = results.filter(x => x.status === 'source-missing').length;
console.log(JSON.stringify({ done: results.length, failed, mode: 'upstream-source' }, null, 2));
db.close();
process.exit(failed ? 1 : 0);
