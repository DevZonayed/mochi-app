/* Skill Registry.
 *
 * The relay still mirrors Mac-owned product data under /api/*, but the skill
 * registry is now an owned network service backed by embedded SQLite. The JSON
 * files under apps/server/registry are import/export artifacts only: a fresh
 * Dokploy volume seeds from them once, then SQLite is the runtime source of
 * truth for metadata, admin state, upstream source status, audits, and embeddings.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

export interface RegistrySkill {
  id: string;
  owner: string;
  repo: string;
  skill: string;
  rank: number;
  name: string;
  description: string;
  license: string;
  tags: string[];
  security: { risk: string; providers: { provider: string; status: string; riskLevel?: string; summary?: string; auditedAt?: string }[] };
  source: string;
  directory: string;
  installCmd: string;
  branch: string;
  skillPath: string;
  rawBase: string;
  excerpt: string;
  fetchedAt: string;
  enabled: boolean;
  disabledReason?: string | null;
  sourceRepo?: string | null;
  sourceStatus?: string | null;
  mirrorRepo?: string | null;
  forkStatus?: string | null;
  lastSyncAt?: string | null;
  commitSha?: string | null;
  sha256?: string | null;
  auditStatus?: string | null;
}

interface Manifest { generatedAt: string; source: string; note: string; count: number; skills: RegistrySkill[] }
interface VectorManifest { model?: string; dim: number; scale: number; count: number; ids: string[]; data: string }

interface SkillRow {
  id: string;
  owner: string;
  repo: string;
  skill: string;
  rank: number;
  name: string;
  description: string;
  license: string;
  tags_json: string;
  risk: string;
  source: string;
  directory: string;
  install_cmd: string;
  branch: string;
  skill_path: string;
  raw_base: string;
  excerpt: string;
  fetched_at: string;
  enabled: 0 | 1;
  disabled_reason: string | null;
  mirror_repo: string | null;
  fork_status: string | null;
  last_sync_at: string | null;
  commit_sha: string | null;
  sha256: string | null;
  audit_status: string | null;
  created_at: string;
  updated_at: string;
}

interface EmbeddingRow { skill_id: string; dim: number; scale: number; vector: Buffer }

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DB = process.env.NODE_ENV === 'production'
  ? '/data/maestro-registry.sqlite'
  : join(process.cwd(), 'registry', 'maestro-registry.sqlite');
const DB_PATH = process.env.MAESTRO_REGISTRY_DB || DEFAULT_DB;
const ADMIN_TOKEN = process.env.MAESTRO_REGISTRY_ADMIN_TOKEN || '';
const UA = 'MaestroSkillRegistry/1.0';

let extractorP: Promise<FeatureExtractionPipeline> | null = null;
function ensureExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorP) {
    env.allowLocalModels = false;
    extractorP = pipeline('feature-extraction', MODEL, { quantized: true })
      .catch((e: unknown) => { extractorP = null; throw e; }) as Promise<FeatureExtractionPipeline>;
  }
  return extractorP;
}

async function embedText(text: string): Promise<Float32Array> {
  const ex = await ensureExtractor();
  const o = await ex(text.slice(0, 800), { pooling: 'mean', normalize: true });
  return o.data as Float32Array;
}

function now(): string { return new Date().toISOString(); }
function sha256(s: string | Buffer): string { return createHash('sha256').update(s).digest('hex'); }
function json<T>(s: string, fallback: T): T { try { return JSON.parse(s) as T; } catch { return fallback; } }
function clampLimit(v: unknown, def = 30, max = 100): number {
  return Math.min(Math.max(Number(v) || def, 1), max);
}

function registryPath(name: string): string | null {
  const candidates = [
    join(__dirname, '..', 'registry', name),
    join(__dirname, '..', '..', 'registry', name),
    join(process.cwd(), 'registry', name),
  ];
  return candidates.find(existsSync) ?? null;
}

function parseFrontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const fm: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) fm[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m ? md.slice(m[0].length) : md };
}

function bodyExcerpt(md: string): string {
  const { body } = parseFrontmatter(md);
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700);
}

function scoreRisk(risk: string): number {
  const r = risk.toUpperCase();
  if (r === 'SAFE' || r === 'NONE' || r === 'LOW') return 4;
  if (r === 'MEDIUM') return 2;
  if (r === 'UNRATED' || r === 'UNKNOWN') return 0;
  return -4;
}

function rowToSkill(r: SkillRow, audits?: RegistrySkill['security']['providers']): RegistrySkill {
  const tags = json<string[]>(r.tags_json || '[]', []);
  return {
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    skill: r.skill,
    rank: r.rank,
    name: r.name,
    description: r.description,
    license: r.license,
    tags,
    security: { risk: r.risk || 'UNKNOWN', providers: audits ?? [] },
    source: r.source,
    directory: r.directory,
    installCmd: r.install_cmd,
    branch: r.branch,
    skillPath: r.skill_path,
    rawBase: r.raw_base,
    excerpt: r.excerpt,
    fetchedAt: r.fetched_at,
    enabled: r.enabled === 1,
    disabledReason: r.disabled_reason,
    sourceRepo: `${r.owner}/${r.repo}`,
    sourceStatus: r.fork_status,
    mirrorRepo: r.mirror_repo,
    forkStatus: r.fork_status,
    lastSyncAt: r.last_sync_at,
    commitSha: r.commit_sha,
    sha256: r.sha256,
    auditStatus: r.audit_status,
  };
}

const summary = (s: RegistrySkill) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  tags: s.tags,
  license: s.license,
  risk: s.security?.risk ?? 'UNKNOWN',
  source: s.source,
  directory: s.directory,
  installCmd: s.installCmd,
  rank: s.rank,
  enabled: s.enabled,
  disabledReason: s.disabledReason ?? null,
  sourceRepo: s.sourceRepo ?? `${s.owner}/${s.repo}`,
  sourceStatus: s.sourceStatus ?? s.forkStatus ?? null,
  mirrorRepo: s.mirrorRepo ?? null,
  forkStatus: s.forkStatus ?? null,
  lastSyncAt: s.lastSyncAt ?? null,
  version: 'latest',
  sha256: s.sha256 ?? null,
  auditStatus: s.auditStatus ?? null,
});

class RegistryStore {
  readonly db: Database.Database;

  constructor(file = DB_PATH) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.importSeedIfNeeded();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        skill TEXT NOT NULL,
        rank INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        license TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        risk TEXT NOT NULL DEFAULT 'UNKNOWN',
        source TEXT NOT NULL,
        directory TEXT NOT NULL,
        install_cmd TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        skill_path TEXT NOT NULL,
        raw_base TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        fetched_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        disabled_reason TEXT,
        mirror_repo TEXT,
        fork_status TEXT,
        last_sync_at TEXT,
        commit_sha TEXT,
        sha256 TEXT,
        audit_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version TEXT NOT NULL DEFAULT 'latest',
        sha256 TEXT,
        commit_sha TEXT,
        skill_md TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, version)
      );
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        scale REAL NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_sources (
        skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
        upstream_repo TEXT NOT NULL,
        mirror_repo TEXT,
        branch TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        raw_base TEXT NOT NULL,
        fork_status TEXT,
        last_sync_at TEXT,
        failure_reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT,
        summary TEXT,
        audited_at TEXT,
        raw_json TEXT,
        UNIQUE(skill_id, provider)
      );
      CREATE TABLE IF NOT EXISTS registry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        skill_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS admin_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skills_enabled_rank ON skills(enabled, rank);
      CREATE INDEX IF NOT EXISTS idx_skills_repo ON skills(owner, repo);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON registry_events(ts);
    `);
  }

  importSeedIfNeeded(): void {
    const count = this.countAll();
    if (count > 0 && process.env.MAESTRO_REGISTRY_REIMPORT !== '1') return;
    const idxFile = registryPath('skills-index.json');
    if (!idxFile) return;
    const manifest = JSON.parse(readFileSync(idxFile, 'utf8')) as Manifest;
    const vectorFile = registryPath('skills-vectors.json');
    const vectors = vectorFile ? JSON.parse(readFileSync(vectorFile, 'utf8')) as VectorManifest : null;
    const vectorById = new Map<string, Buffer>();
    if (vectors?.ids?.length && vectors.data) {
      const all = Buffer.from(vectors.data, 'base64');
      for (let i = 0; i < vectors.ids.length; i++) {
        const start = i * vectors.dim;
        vectorById.set(vectors.ids[i], Buffer.from(all.subarray(start, start + vectors.dim)));
      }
    }

    const ts = manifest.generatedAt || now();
    const insertSkill = this.db.prepare(`
      INSERT INTO skills (
        id, owner, repo, skill, rank, name, description, license, tags_json, risk,
        source, directory, install_cmd, branch, skill_path, raw_base, excerpt,
        fetched_at, enabled, created_at, updated_at
      ) VALUES (
        @id, @owner, @repo, @skill, @rank, @name, @description, @license, @tags_json, @risk,
        @source, @directory, @install_cmd, @branch, @skill_path, @raw_base, @excerpt,
        @fetched_at, 1, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        rank=excluded.rank, name=excluded.name, description=excluded.description,
        license=excluded.license, tags_json=excluded.tags_json, risk=excluded.risk,
        source=excluded.source, directory=excluded.directory, install_cmd=excluded.install_cmd,
        branch=excluded.branch, skill_path=excluded.skill_path, raw_base=excluded.raw_base,
        excerpt=excluded.excerpt, fetched_at=excluded.fetched_at, updated_at=excluded.updated_at
    `);
    const insertSource = this.db.prepare(`
      INSERT INTO skill_sources (skill_id, upstream_repo, branch, skill_path, raw_base, fork_status, updated_at)
      VALUES (@skill_id, @upstream_repo, @branch, @skill_path, @raw_base, 'pending', @updated_at)
      ON CONFLICT(skill_id) DO UPDATE SET
        upstream_repo=excluded.upstream_repo, branch=excluded.branch,
        skill_path=excluded.skill_path, raw_base=excluded.raw_base, updated_at=excluded.updated_at
    `);
    const insertAudit = this.db.prepare(`
      INSERT INTO skill_audits (skill_id, provider, status, risk_level, summary, audited_at, raw_json)
      VALUES (@skill_id, @provider, @status, @risk_level, @summary, @audited_at, @raw_json)
      ON CONFLICT(skill_id, provider) DO UPDATE SET
        status=excluded.status, risk_level=excluded.risk_level, summary=excluded.summary,
        audited_at=excluded.audited_at, raw_json=excluded.raw_json
    `);
    const insertVec = this.db.prepare(`
      INSERT INTO skill_embeddings (skill_id, model, dim, scale, vector, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        model=excluded.model, dim=excluded.dim, scale=excluded.scale, vector=excluded.vector, updated_at=excluded.updated_at
    `);

    const tx = this.db.transaction(() => {
      if (process.env.MAESTRO_REGISTRY_REIMPORT === '1') {
        this.db.exec('DELETE FROM skill_audits; DELETE FROM skill_embeddings; DELETE FROM skill_sources; DELETE FROM skill_versions; DELETE FROM skills;');
      }
      for (const s of manifest.skills) {
        const risk = s.security?.risk || 'UNKNOWN';
        insertSkill.run({
          id: s.id,
          owner: s.owner,
          repo: s.repo,
          skill: s.skill,
          rank: s.rank,
          name: s.name,
          description: s.description,
          license: s.license || '',
          tags_json: JSON.stringify(s.tags || []),
          risk,
          source: s.source,
          directory: s.directory,
          install_cmd: s.installCmd,
          branch: s.branch,
          skill_path: s.skillPath,
          raw_base: s.rawBase,
          excerpt: s.excerpt || '',
          fetched_at: s.fetchedAt || ts,
          created_at: ts,
          updated_at: ts,
        });
        insertSource.run({
          skill_id: s.id,
          upstream_repo: `${s.owner}/${s.repo}`,
          branch: s.branch,
          skill_path: s.skillPath,
          raw_base: s.rawBase,
          updated_at: ts,
        });
        for (const a of s.security?.providers ?? []) {
          insertAudit.run({
            skill_id: s.id,
            provider: a.provider || 'unknown',
            status: a.status || 'unknown',
            risk_level: a.riskLevel || '',
            summary: a.summary || '',
            audited_at: a.auditedAt || '',
            raw_json: JSON.stringify(a),
          });
        }
        const vec = vectorById.get(s.id);
        if (vec && vectors) insertVec.run(s.id, vectors.model || MODEL, vectors.dim, vectors.scale || 127, vec, ts);
      }
      this.event('seed-import', null, {
        count: manifest.skills.length,
        vectors: vectorById.size,
        source: manifest.source,
        generatedAt: manifest.generatedAt,
      });
    });
    tx();
  }

  event(kind: string, skillId: string | null, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO registry_events (ts, kind, skill_id, detail_json) VALUES (?, ?, ?, ?)')
      .run(now(), kind, skillId, JSON.stringify(detail));
  }

  countAll(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n || 0);
  }

  countEnabled(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM skills WHERE enabled=1').get() as { n: number }).n || 0);
  }

  uniqueRepos(): number {
    return Number((this.db.prepare("SELECT COUNT(DISTINCT owner || '/' || repo) AS n FROM skills").get() as { n: number }).n || 0);
  }

  allRows(includeDisabled = false, limit = 5000): SkillRow[] {
    return this.db.prepare(`SELECT * FROM skills ${includeDisabled ? '' : 'WHERE enabled=1'} ORDER BY rank ASC LIMIT ?`).all(limit) as SkillRow[];
  }

  get(id: string, includeDisabled = true): RegistrySkill | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE id=? ${includeDisabled ? '' : 'AND enabled=1'}`).get(id) as SkillRow | undefined;
    if (!row) return null;
    const audits = this.db.prepare('SELECT provider, status, risk_level AS riskLevel, summary, audited_at AS auditedAt FROM skill_audits WHERE skill_id=? ORDER BY provider')
      .all(id) as RegistrySkill['security']['providers'];
    return rowToSkill(row, audits);
  }

  keywordSearch(q: string, limit: number, includeDisabled = false): RegistrySkill[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.allRows(includeDisabled, 5000);
    if (!terms.length) return rows.slice(0, limit).map(r => rowToSkill(r));
    const scored: { r: SkillRow; score: number }[] = [];
    for (const r of rows) {
      const name = r.name.toLowerCase();
      const desc = r.description.toLowerCase();
      const tags = json<string[]>(r.tags_json, []).join(' ').toLowerCase();
      const exc = r.excerpt.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name === t) score += 60; else if (name.includes(t)) score += 30;
        if (tags.includes(t)) score += 14;
        if (desc.includes(t)) score += 10;
        if (exc.includes(t)) score += 3;
      }
      if (score > 0) {
        score += Math.max(0, 12 - Math.log2(r.rank + 1));
        score += scoreRisk(r.risk);
        if (r.fork_status === 'source-ok') score += 2;
        if (r.enabled) score += 5;
        scored.push({ r, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.r.rank - b.r.rank);
    return scored.slice(0, limit).map(x => rowToSkill(x.r));
  }

  async semanticSearch(q: string, limit: number, includeDisabled = false): Promise<RegistrySkill[] | null> {
    if (!q.trim()) return null;
    const rows = this.db.prepare(`
      SELECT s.*, e.dim, e.scale, e.vector
      FROM skills s JOIN skill_embeddings e ON e.skill_id=s.id
      ${includeDisabled ? '' : 'WHERE s.enabled=1'}
    `).all() as Array<SkillRow & EmbeddingRow>;
    if (!rows.length) return null;
    const qVec = await withTimeout(embedText(q), 8000);
    if (!qVec) return null;
    const scored: { r: SkillRow; score: number }[] = [];
    for (const r of rows) {
      const vec = new Int8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
      let dot = 0;
      for (let d = 0; d < r.dim; d++) dot += (qVec[d] ?? 0) * (vec[d] ?? 0);
      let score = dot / (r.scale || 127);
      score += scoreRisk(r.risk) / 100;
      if (r.fork_status === 'source-ok') score += 0.03;
      if (!r.enabled) score -= 1;
      scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score || a.r.rank - b.r.rank);
    return scored.slice(0, limit).map(x => rowToSkill(x.r));
  }

  async search(q: string, limit: number, includeDisabled = false): Promise<{ count: number; mode: string; results: ReturnType<typeof summary>[] }> {
    if (q.trim()) {
      try {
        const semantic = await this.semanticSearch(q, limit, includeDisabled);
        if (semantic) return { count: includeDisabled ? this.countAll() : this.countEnabled(), mode: 'semantic-db', results: semantic.map(summary) };
      } catch {
        // Fall back to keyword when the model is not warm or the query embed fails.
      }
    }
    const results = this.keywordSearch(q, limit, includeDisabled);
    return { count: includeDisabled ? this.countAll() : this.countEnabled(), mode: 'keyword-db', results: results.map(summary) };
  }

  cachedContent(id: string, version: string): { skillMd: string; sha256: string | null } | null {
    const row = this.db.prepare('SELECT skill_md, sha256 FROM skill_versions WHERE skill_id=? AND version=? AND skill_md IS NOT NULL')
      .get(id, version) as { skill_md: string; sha256: string | null } | undefined;
    return row?.skill_md ? { skillMd: row.skill_md, sha256: row.sha256 } : null;
  }

  async content(id: string, version = 'latest'): Promise<{ id: string; name: string; skillMd: string; sha256: string; enabled: boolean }> {
    const s = this.get(id, true);
    if (!s) throw Object.assign(new Error('skill not found'), { statusCode: 404 });
    if (!s.enabled) throw Object.assign(new Error(`skill disabled${s.disabledReason ? `: ${s.disabledReason}` : ''}`), { statusCode: 403 });
    const cached = this.cachedContent(id, version);
    if (cached?.skillMd && cached.sha256) return { id, name: s.name, skillMd: cached.skillMd, sha256: cached.sha256, enabled: s.enabled };
    const skillMd = await fetchRawSkill(s.rawBase);
    const hash = sha256(skillMd);
    const commitSha = await fetchLatestCommitSha(s.owner, s.repo, s.branch, `${s.skillPath}/SKILL.md`).catch(() => null) ?? s.commitSha ?? null;
    const ts = now();
    this.db.prepare(`
      INSERT INTO skill_versions (skill_id, version, sha256, commit_sha, skill_md, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id, version) DO UPDATE SET
        sha256=excluded.sha256, commit_sha=excluded.commit_sha, skill_md=excluded.skill_md, fetched_at=excluded.fetched_at
    `).run(id, version, hash, commitSha, skillMd, ts);
    this.db.prepare('UPDATE skills SET sha256=?, commit_sha=?, updated_at=? WHERE id=?').run(hash, commitSha, ts, id);
    this.event('content-fetch', id, { version, sha256: hash, commitSha });
    return { id, name: s.name, skillMd, sha256: hash, enabled: s.enabled };
  }

  patch(id: string, patch: Record<string, unknown>): RegistrySkill {
    const cur = this.get(id, true);
    if (!cur) throw Object.assign(new Error('skill not found'), { statusCode: 404 });
    const fields: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, val: unknown) => { fields.push(`${col}=?`); vals.push(val); };
    if (typeof patch.enabled === 'boolean') set('enabled', patch.enabled ? 1 : 0);
    if (typeof patch.disabledReason === 'string') set('disabled_reason', patch.disabledReason.slice(0, 500));
    if (typeof patch.name === 'string' && patch.name.trim()) set('name', patch.name.trim().slice(0, 128));
    if (typeof patch.description === 'string' && patch.description.trim()) set('description', patch.description.trim().slice(0, 1600));
    if (Array.isArray(patch.tags)) set('tags_json', JSON.stringify(patch.tags.filter((x): x is string => typeof x === 'string').slice(0, 16)));
    if (!fields.length) return cur;
    set('updated_at', now());
    this.db.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id=?`).run(...vals, id);
    this.event('skill-patch', id, patch);
    return this.get(id, true)!;
  }

  async add(input: Record<string, unknown>): Promise<RegistrySkill> {
    const resolved = await resolveNewSkill(input);
    const t = now();
    const rank = Number((this.db.prepare('SELECT COALESCE(MAX(rank),0)+1 AS n FROM skills').get() as { n: number }).n || 1);
    const hash = sha256(resolved.skillMd);
    const excerpt = bodyExcerpt(resolved.skillMd);
    this.db.prepare(`
      INSERT INTO skills (
        id, owner, repo, skill, rank, name, description, license, tags_json, risk,
        source, directory, install_cmd, branch, skill_path, raw_base, excerpt,
        fetched_at, enabled, sha256, created_at, updated_at
      ) VALUES (
        @id, @owner, @repo, @skill, @rank, @name, @description, @license, @tags_json, 'UNRATED',
        @source, @directory, @install_cmd, @branch, @skill_path, @raw_base, @excerpt,
        @fetched_at, 1, @sha256, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, license=excluded.license,
        tags_json=excluded.tags_json, source=excluded.source, directory=excluded.directory,
        install_cmd=excluded.install_cmd, branch=excluded.branch, skill_path=excluded.skill_path,
        raw_base=excluded.raw_base, excerpt=excluded.excerpt, fetched_at=excluded.fetched_at,
        enabled=1, sha256=excluded.sha256, updated_at=excluded.updated_at
    `).run({
      id: resolved.id,
      owner: resolved.owner,
      repo: resolved.repo,
      skill: resolved.skill,
      rank,
      name: resolved.name,
      description: resolved.description,
      license: resolved.license,
      tags_json: JSON.stringify(resolved.tags),
      source: resolved.source,
      directory: resolved.directory,
      install_cmd: resolved.installCmd,
      branch: resolved.branch,
      skill_path: resolved.skillPath,
      raw_base: resolved.rawBase,
      excerpt,
      fetched_at: t,
      sha256: hash,
      created_at: t,
      updated_at: t,
    });
    this.db.prepare(`
      INSERT INTO skill_versions (skill_id, version, sha256, skill_md, fetched_at)
      VALUES (?, 'latest', ?, ?, ?)
      ON CONFLICT(skill_id, version) DO UPDATE SET sha256=excluded.sha256, skill_md=excluded.skill_md, fetched_at=excluded.fetched_at
    `).run(resolved.id, hash, resolved.skillMd, t);
    this.db.prepare(`
      INSERT INTO skill_sources (skill_id, upstream_repo, branch, skill_path, raw_base, fork_status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(skill_id) DO UPDATE SET upstream_repo=excluded.upstream_repo, branch=excluded.branch, skill_path=excluded.skill_path, raw_base=excluded.raw_base, updated_at=excluded.updated_at
    `).run(resolved.id, `${resolved.owner}/${resolved.repo}`, resolved.branch, resolved.skillPath, resolved.rawBase, t);
    try {
      const v = await embedText(`${resolved.name}. ${resolved.description} ${excerpt.slice(0, 280)}`);
      const buf = Buffer.alloc(v.length);
      for (let i = 0; i < v.length; i++) buf[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127))) & 0xff;
      this.db.prepare(`
        INSERT INTO skill_embeddings (skill_id, model, dim, scale, vector, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(skill_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, scale=excluded.scale, vector=excluded.vector, updated_at=excluded.updated_at
      `).run(resolved.id, MODEL, v.length, 127, buf, t);
    } catch {
      // Keyword search still works; semantic embedding can be regenerated later.
    }
    this.event('skill-add', resolved.id, { source: resolved.source, sha256: hash });
    return this.get(resolved.id, true)!;
  }

  async rescan(id: string): Promise<RegistrySkill> {
    const s = this.get(id, true);
    if (!s) throw Object.assign(new Error('skill not found'), { statusCode: 404 });
    const audit = await fetchAudit(s.owner, s.repo, s.skill);
    const t = now();
    if (audit) {
      const risk = audit.risk;
      const tx = this.db.transaction(() => {
        this.db.prepare('DELETE FROM skill_audits WHERE skill_id=?').run(id);
        for (const a of audit.providers) {
          this.db.prepare(`
            INSERT INTO skill_audits (skill_id, provider, status, risk_level, summary, audited_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, a.provider || 'unknown', a.status || 'unknown', a.riskLevel || '', a.summary || '', a.auditedAt || '', JSON.stringify(a));
        }
        this.db.prepare('UPDATE skills SET risk=?, audit_status=?, updated_at=? WHERE id=?').run(risk, audit.secure ? 'pass' : 'blocked', t, id);
      });
      tx();
      this.event('skill-rescan', id, { risk, secure: audit.secure });
    } else {
      this.db.prepare('UPDATE skills SET audit_status=?, updated_at=? WHERE id=?').run('unavailable', t, id);
      this.event('skill-rescan', id, { risk: 'UNRATED', secure: null });
    }
    return this.get(id, true)!;
  }

  uniqueSources(): Array<{ owner: string; repo: string; branch: string; count: number }> {
    return this.db.prepare('SELECT owner, repo, MIN(branch) AS branch, COUNT(*) AS count FROM skills GROUP BY owner, repo ORDER BY count DESC, owner, repo').all() as Array<{ owner: string; repo: string; branch: string; count: number }>;
  }

  sourceQueue(limit: number, includeFresh = false): Array<{ id: string; owner: string; repo: string; branch: string; skillPath: string; rawBase: string; name: string }> {
    return this.db.prepare(`
      SELECT id, owner, repo, branch, skill_path AS skillPath, raw_base AS rawBase, name
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
    `).all(includeFresh ? 1 : 0, limit) as Array<{ id: string; owner: string; repo: string; branch: string; skillPath: string; rawBase: string; name: string }>;
  }

  markSource(owner: string, repo: string, patch: { sourceStatus: string; failureReason?: string | null }): void {
    const t = now();
    this.db.prepare(`
      UPDATE skills SET mirror_repo=?, fork_status=?, last_sync_at=?, updated_at=?
      WHERE owner=? AND repo=?
    `).run(null, patch.sourceStatus, t, t, owner, repo);
    this.db.prepare(`
      UPDATE skill_sources SET mirror_repo=?, fork_status=?, last_sync_at=?, failure_reason=?, updated_at=?
      WHERE upstream_repo=?
    `).run(null, patch.sourceStatus, t, patch.failureReason ?? null, t, `${owner}/${repo}`);
  }

  markSkillSource(row: { id: string; owner: string; repo: string }, patch: { status: string; sha256?: string; commitSha?: string | null; skillMd?: string; error?: string }): void {
    const t = now();
    if (patch.skillMd && patch.sha256) {
      this.db.prepare(`
        INSERT INTO skill_versions (skill_id, version, sha256, commit_sha, skill_md, fetched_at)
        VALUES (?, 'latest', ?, ?, ?, ?)
        ON CONFLICT(skill_id, version) DO UPDATE SET
          sha256=excluded.sha256, commit_sha=excluded.commit_sha, skill_md=excluded.skill_md, fetched_at=excluded.fetched_at
      `).run(row.id, patch.sha256, patch.commitSha ?? null, patch.skillMd, t);
      this.db.prepare(`
        UPDATE skills
        SET mirror_repo=NULL, fork_status=?, sha256=?, commit_sha=?, last_sync_at=?, updated_at=?
        WHERE id=?
      `).run(patch.status, patch.sha256, patch.commitSha ?? null, t, t, row.id);
    } else {
      this.db.prepare(`
        UPDATE skills
        SET mirror_repo=NULL, fork_status=?, last_sync_at=?, updated_at=?
        WHERE id=?
      `).run(patch.status, t, t, row.id);
    }
    this.db.prepare(`
      UPDATE skill_sources
      SET mirror_repo=NULL, fork_status=?, last_sync_at=?, failure_reason=?, updated_at=?
      WHERE skill_id=?
    `).run(patch.status, patch.error ?? null, t, row.id);
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);

async function fetchRawSkill(rawBase: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${rawBase}/SKILL.md`, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!r.ok) throw Object.assign(new Error(`upstream ${r.status}`), { statusCode: 502 });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string, timeout = 15000): Promise<{ ok: boolean; status: number; text?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' } });
    return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : undefined };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

async function fetchLatestCommitSha(owner: string, repo: string, branch: string, path: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set('sha', branch || 'main');
  url.searchParams.set('path', path.replace(/^\/+/, ''));
  url.searchParams.set('per_page', '1');
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': UA,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!r.ok) return null;
    const rows = await r.json() as Array<{ sha?: string }>;
    const sha = rows[0]?.sha;
    return typeof sha === 'string' && sha ? sha : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolveGitHubSkill(owner: string, repo: string, skill: string): Promise<{ branch: string; skillPath: string; rawBase: string; skillMd: string }> {
  const branches = ['main', 'master'];
  const prefixes = ['skills/', '', '.claude/skills/', 'agent-skills/', 'plugins/'];
  for (const branch of branches) {
    for (const prefix of prefixes) {
      const skillPath = `${prefix}${skill}`;
      const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillPath}`;
      const r = await fetchText(`${rawBase}/SKILL.md`, 12000);
      if (r.ok && r.text && /\bname\s*:|\bdescription\s*:|^#/m.test(r.text)) return { branch, skillPath, rawBase, skillMd: r.text };
    }
  }
  throw Object.assign(new Error('SKILL.md not found in common paths'), { statusCode: 404 });
}

async function resolveNewSkill(input: Record<string, unknown>): Promise<{
  id: string; owner: string; repo: string; skill: string; name: string; description: string; license: string; tags: string[];
  source: string; directory: string; installCmd: string; branch: string; skillPath: string; rawBase: string; skillMd: string;
}> {
  let owner = typeof input.owner === 'string' ? input.owner : '';
  let repo = typeof input.repo === 'string' ? input.repo : '';
  let skill = typeof input.skill === 'string' ? input.skill : '';
  let skillMd = typeof input.skillMd === 'string' ? input.skillMd : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';

  if (url && !owner) {
    const skillSh = url.match(/skills\.sh\/([^/]+)\/([^/]+)\/([^/?#]+)/);
    const gh = url.match(/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)\/(.+))?/);
    const raw = url.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\/SKILL\.md/);
    if (skillSh) [, owner, repo, skill] = skillSh;
    else if (raw) {
      owner = raw[1]; repo = raw[2];
      const parts = raw[4].split('/');
      skill = parts[parts.length - 1] || repo;
    } else if (gh) {
      owner = gh[1]; repo = gh[2].replace(/\.git$/, '');
      skill = skill || (gh[4]?.split('/').pop() ?? repo);
    }
  }
  if (!owner || !repo) throw Object.assign(new Error('owner/repo required'), { statusCode: 400 });
  if (!skill) skill = (typeof input.name === 'string' && input.name) ? input.name : repo;

  let branch = typeof input.branch === 'string' ? input.branch : 'main';
  let skillPath = typeof input.skillPath === 'string' ? input.skillPath : `skills/${skill}`;
  let rawBase = typeof input.rawBase === 'string' ? input.rawBase : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillPath}`;
  if (!skillMd) {
    const resolved = await resolveGitHubSkill(owner, repo, skill);
    branch = resolved.branch; skillPath = resolved.skillPath; rawBase = resolved.rawBase; skillMd = resolved.skillMd;
  }

  const { fm } = parseFrontmatter(skillMd);
  const name = (typeof input.name === 'string' && input.name.trim()) || fm.name || skill;
  const description = (typeof input.description === 'string' && input.description.trim()) || fm.description || bodyExcerpt(skillMd).slice(0, 300);
  if (!description) throw Object.assign(new Error('description required'), { statusCode: 400 });
  const tags = (Array.isArray(input.tags) ? input.tags.filter((x): x is string => typeof x === 'string') : (fm.tags || fm.category || '').split(/[,\s]+/).filter(Boolean)).slice(0, 16);
  return {
    id: `${owner}/${repo}/${skill}`,
    owner, repo, skill, name, description, license: fm.license || '', tags,
    source: `https://github.com/${owner}/${repo}`,
    directory: `https://www.skills.sh/${owner}/${repo}/${skill}`,
    installCmd: `npx skills add https://github.com/${owner}/${repo} --skill ${skill}`,
    branch, skillPath, rawBase, skillMd,
  };
}

async function fetchAudit(owner: string, repo: string, skill: string): Promise<{ secure: boolean; risk: string; providers: RegistrySkill['security']['providers'] } | null> {
  const r = await fetchText(`https://www.skills.sh/api/v1/skills/audit/${owner}/${repo}/${skill}`, 12000);
  if (!r.ok || !r.text) return null;
  try {
    const audits = (JSON.parse(r.text) as { audits?: RegistrySkill['security']['providers'] }).audits ?? [];
    let worst = 'UNRATED';
    let secure = true;
    const order: Record<string, number> = { NONE: 0, SAFE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    for (const a of audits) {
      const risk = (a.riskLevel || 'NONE').toUpperCase();
      if (a.status === 'fail' || risk === 'HIGH' || risk === 'CRITICAL') secure = false;
      if ((order[risk] ?? 0) > (order[worst] ?? 0)) worst = risk;
    }
    return { secure, risk: worst === 'NONE' ? 'SAFE' : worst, providers: audits };
  } catch {
    return null;
  }
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!ADMIN_TOKEN) {
    reply.code(503).send({ error: 'MAESTRO_REGISTRY_ADMIN_TOKEN is not configured' });
    return false;
  }
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const header = typeof req.headers['x-registry-admin-token'] === 'string' ? req.headers['x-registry-admin-token'] : '';
  if ((bearer || header) !== ADMIN_TOKEN) {
    reply.code(401).send({ error: 'Unauthorized registry admin request' });
    return false;
  }
  return true;
}

function skillIdFrom(req: FastifyRequest): string {
  const raw = (req.params as { id?: string }).id ?? (req.query as { id?: string } | undefined)?.id ?? '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function syncOriginalSources(store: RegistryStore, opts: { dryRun: boolean; limit: number; includeFresh?: boolean }): Promise<{
  dryRun: boolean;
  mode: 'upstream-source';
  includeFresh: boolean;
  repos: number;
  attempted: number;
  results: Array<{ skillId: string; repo: string; status: string; sourceRepo: string; sha256?: string; commitSha?: string | null; error?: string }>;
}> {
  const includeFresh = opts.includeFresh === true;
  const rows = store.sourceQueue(opts.limit, includeFresh);
  const results: Array<{ skillId: string; repo: string; status: string; sourceRepo: string; sha256?: string; commitSha?: string | null; error?: string }> = [];
  for (const s of rows) {
    const sourceRepo = `${s.owner}/${s.repo}`;
    if (opts.dryRun) {
      results.push({ skillId: s.id, repo: sourceRepo, sourceRepo, status: 'dry-run' });
      continue;
    }
    try {
      const skillMd = await fetchRawSkill(s.rawBase);
      const hash = sha256(skillMd);
      const commitSha = await fetchLatestCommitSha(s.owner, s.repo, s.branch, `${s.skillPath}/SKILL.md`).catch(() => null);
      store.markSkillSource(s, { status: 'source-ok', sha256: hash, commitSha, skillMd });
      results.push({ skillId: s.id, repo: sourceRepo, sourceRepo, status: 'source-ok', sha256: hash, commitSha });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      store.markSkillSource(s, { status: 'source-missing', error });
      results.push({ skillId: s.id, repo: sourceRepo, sourceRepo, status: 'source-missing', error });
    }
  }
  store.event('source-sync', null, { dryRun: opts.dryRun, includeFresh, attempted: results.length });
  return { dryRun: opts.dryRun, mode: 'upstream-source', includeFresh, repos: store.uniqueRepos(), attempted: results.length, results };
}

export function registerRegistry(app: FastifyInstance): void {
  const store = new RegistryStore();
  ensureExtractor().catch(() => { /* search falls back to keyword until warm */ });

  app.get('/registry/meta', async () => ({
    count: store.countEnabled(),
    total: store.countAll(),
    uniqueRepos: store.uniqueRepos(),
    generatedAt: (store.db.prepare('SELECT MIN(fetched_at) AS at FROM skills').get() as { at?: string }).at ?? '',
    source: 'sqlite',
    note: `runtime registry database at ${DB_PATH}`,
    semantic: Number((store.db.prepare('SELECT COUNT(*) AS n FROM skill_embeddings').get() as { n: number }).n) > 0,
    dbPath: DB_PATH,
  }));

  app.get('/registry/skills', async (req) => {
    const q = String(((req.query ?? {}) as { q?: string }).q ?? '');
    const includeDisabled = String(((req.query ?? {}) as { includeDisabled?: string }).includeDisabled ?? '') === 'true';
    const limit = clampLimit(((req.query ?? {}) as { limit?: string }).limit);
    return store.search(q, limit, includeDisabled);
  });

  const getSkill = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = skillIdFrom(req);
    const s = store.get(id, true);
    if (!s) return reply.code(404).send({ error: 'skill not found' });
    return s;
  };
  app.get('/registry/skills/:id', getSkill);
  app.get('/registry/skill', getSkill);

  const getContent = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = skillIdFrom(req);
    const version = (req.query as { version?: string } | undefined)?.version ?? 'latest';
    try {
      return await store.content(id, version);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  };
  app.get('/registry/skills/:id/content', getContent);
  app.get('/registry/skill/content', getContent);

  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw.url ?? '').startsWith('/registry/admin/') && !requireAdmin(req, reply)) return reply;
  });

  app.get('/registry/admin/skills', async (req) => {
    const q = String(((req.query ?? {}) as { q?: string }).q ?? '');
    const includeDisabled = String(((req.query ?? {}) as { includeDisabled?: string }).includeDisabled ?? 'true') !== 'false';
    const limit = clampLimit(((req.query ?? {}) as { limit?: string }).limit, 250, 5000);
    return store.search(q, limit, includeDisabled);
  });

  app.post('/registry/admin/skills', async (req, reply) => {
    try {
      const skill = await store.add((req.body ?? {}) as Record<string, unknown>);
      return skill;
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.patch('/registry/admin/skills/:id', async (req, reply) => {
    try {
      return store.patch(skillIdFrom(req), (req.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });
  app.patch('/registry/admin/skill', async (req, reply) => {
    try {
      return store.patch(skillIdFrom(req), (req.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  app.post('/registry/admin/skills/:id/rescan', async (req, reply) => {
    try {
      return await store.rescan(skillIdFrom(req));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });
  app.post('/registry/admin/skill/rescan', async (req, reply) => {
    try {
      return await store.rescan(skillIdFrom(req));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  const syncSourcesRoute = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { dryRun?: boolean; includeFresh?: boolean; limit?: number };
    try {
      return await syncOriginalSources(store, {
        dryRun: body.dryRun !== false,
        includeFresh: body.includeFresh === true,
        limit: Math.min(Math.max(Number(body.limit) || 5000, 1), 5000),
      });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  };
  app.post('/registry/admin/sync/sources', syncSourcesRoute);
  app.post('/registry/admin/sync/github', syncSourcesRoute);
}
