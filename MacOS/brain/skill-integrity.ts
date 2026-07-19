import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type SkillProvenanceKind = 'registry' | 'bundled-native' | 'project-local' | 'local-operator' | 'legacy-registry';
export type IntegrityStatus = 'verified' | 'legacy-unverified' | 'unverified-local' | 'failed' | 'quarantined';
export type PolicyDecision = 'allow' | 'block' | 'local-trust' | 'legacy-block';

export interface SkillAuditEvidence {
  identity?: string | null;
  status?: string | null;
  auditedDigest?: string | null;
  checkedAt?: string | null;
}

export interface RegistrySkillContent {
  id: string;
  name: string;
  skillMd: string;
  sha256?: string | null;
  expectedDigest?: string | null;
  provenance?: {
    kind?: 'registry';
    source?: string | null;
    version?: string | null;
    commit?: string | null;
  };
  audit?: SkillAuditEvidence | null;
  auditEvidence?: SkillAuditEvidence | null;
  risk?: string | null;
  source?: string | null;
  enabled?: boolean;
  disabledReason?: string | null;
}

export interface SkillIntegrityRecord {
  algorithm: 'sha256';
  digest: string;
  status: IntegrityStatus;
  checkedAt: number;
  failure?: string | null;
}

export interface SkillPolicyRecord {
  decision: PolicyDecision;
  risk?: string | null;
  reason?: string | null;
  checkedAt: number;
}

export interface VerifiedSkillInstallRecord {
  id: string;
  slug: string;
  name: string;
  sha256: string;
  version?: string;
  source?: string;
  risk?: string | null;
  enabled: boolean;
  integrity: SkillIntegrityRecord;
  provenance: {
    kind: SkillProvenanceKind;
    source?: string | null;
    version?: string | null;
    commit?: string | null;
  };
  auditEvidence: {
    identity: string;
    status: string;
    auditedDigest: string;
    checkedAt?: string | null;
  };
  policy: SkillPolicyRecord;
}

export interface SkillTrustInput {
  id: string;
  slug: string;
  name: string;
  enabled?: boolean;
  addedBy?: string;
  risk?: string | null;
  source?: string | null;
  version?: string | null;
  sha256?: string | null;
  integrity?: SkillIntegrityRecord;
  provenance?: {
    kind?: SkillProvenanceKind | string;
    source?: string | null;
    version?: string | null;
    commit?: string | null;
  };
  auditEvidence?: SkillAuditEvidence | null;
}

export type SkillExecutionDecision =
  | { ok: true; trust: 'registry-audited' | 'bundled-native' | 'local-operator'; reason: string }
  | { ok: false; trust: 'blocked'; reason: string };

export interface RegistrySkillReplacementOptions {
  existing?: SkillTrustInput | null;
}

const SHA_RE = /^[a-f0-9]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const BLOCKED_RISKS = new Set(['HIGH', 'CRITICAL', 'BLOCKED']);
const PASS_AUDITS = new Set(['passed', 'pass', 'ok', 'clean', 'approved']);

export function computeSkillDigest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalSkillSlug(idOrSlug: string): string {
  const input = String(idOrSlug || '');
  if (input.includes('..') || input.startsWith('/') || input.includes('\\')) throw new Error('invalid skill slug');
  const raw = input.split('/').pop() || '';
  const slug = raw.toLowerCase();
  if (!SLUG_RE.test(slug) || slug === '.' || slug === '..') {
    throw new Error('invalid skill slug');
  }
  return slug;
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || resolve(rel) === rel) {
    throw new Error('path escapes skill root');
  }
}

function assertNoSymlinkPath(root: string, target: string): void {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  assertInside(dirname(rootAbs), rootAbs);
  assertInside(rootAbs, targetAbs);
  const relParts = relative(rootAbs, targetAbs).split(sep).filter(Boolean);
  let cur = rootAbs;
  for (const part of relParts) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) throw new Error('symlink skill path rejected');
    } catch (e) {
      if (e instanceof Error && e.message.includes('symlink skill path rejected')) throw e;
    }
  }
}

export function skillsRoot(projectRoot: string): string {
  return join(projectRoot, '.claude', 'skills');
}

export function skillDir(projectRoot: string, idOrSlug: string): string {
  const dir = join(skillsRoot(projectRoot), canonicalSkillSlug(idOrSlug));
  assertInside(skillsRoot(projectRoot), dir);
  return dir;
}

export function validateRegistryContent(content: RegistrySkillContent): VerifiedSkillInstallRecord {
  const expected = (content.expectedDigest || content.sha256 || '').toLowerCase();
  const digest = content.skillMd === '' && SHA_RE.test(expected) ? expected : computeSkillDigest(content.skillMd);
  if (!SHA_RE.test(expected)) throw new Error('registry content missing canonical sha256');
  if (expected !== digest) throw new Error('digest mismatch for registry skill content');
  const audit = content.auditEvidence ?? content.audit ?? null;
  const status = String(audit?.status ?? '').toLowerCase();
  const auditedDigest = String(audit?.auditedDigest ?? '').toLowerCase();
  const identity = String(audit?.identity ?? '').trim();
  if (!identity) throw new Error('audit evidence identity required');
  if (!PASS_AUDITS.has(status)) throw new Error('audit evidence did not pass');
  if (!SHA_RE.test(auditedDigest) || auditedDigest !== digest) throw new Error('audit evidence digest mismatch');
  const risk = String(content.risk ?? '').toUpperCase();
  if (BLOCKED_RISKS.has(risk)) throw new Error(`risk policy blocked ${risk}`);
  const slug = canonicalSkillSlug(content.id);
  const now = Date.now();
  return {
    id: content.id,
    slug,
    name: content.name,
    sha256: digest,
    version: content.provenance?.version ?? undefined,
    source: content.provenance?.source ?? content.source ?? undefined,
    risk: risk || content.risk || null,
    enabled: content.enabled !== false,
    integrity: { algorithm: 'sha256', digest, status: 'verified', checkedAt: now },
    provenance: {
      kind: 'registry',
      source: content.provenance?.source ?? content.source ?? null,
      version: content.provenance?.version ?? null,
      commit: content.provenance?.commit ?? null,
    },
    auditEvidence: { identity, status, auditedDigest, checkedAt: audit?.checkedAt ?? null },
    policy: { decision: 'allow', risk: risk || content.risk || null, checkedAt: now },
  };
}

export function assertRegistrySkillInstallable(content: RegistrySkillContent): VerifiedSkillInstallRecord {
  return validateRegistryContent(content);
}

export function isRegistryManagedSkill(rec: SkillTrustInput): boolean {
  const kind = rec.provenance?.kind;
  return kind === 'registry'
    || kind === 'legacy-registry'
    || !!rec.auditEvidence
    || rec.integrity?.status === 'legacy-unverified'
    || rec.integrity?.status === 'quarantined'
    || (!!rec.source && rec.addedBy !== 'native' && rec.provenance?.kind !== 'project-local' && rec.provenance?.kind !== 'local-operator');
}

export function buildRegistryReverifyContent(rec: SkillTrustInput): RegistrySkillContent {
  return {
    id: rec.id,
    name: rec.name,
    skillMd: '',
    sha256: rec.sha256,
    expectedDigest: rec.sha256,
    provenance: { kind: 'registry', source: rec.source, version: rec.version, commit: rec.provenance?.commit },
    audit: rec.auditEvidence,
    risk: rec.risk,
    source: rec.source,
  };
}

function assertVerifiedRegistryReplacement(
  projectRoot: string,
  next: VerifiedSkillInstallRecord,
  finalDir: string,
  existing?: SkillTrustInput | null,
): void {
  if (!existing) throw new Error('registry skill collision: explicit verified registry replacement required');
  if (existing.provenance?.kind !== 'registry') throw new Error('registry skill collision: existing record is not registry-managed');
  if (canonicalSkillSlug(existing.slug || existing.id) !== next.slug) throw new Error('registry skill collision: existing record target mismatch');
  if (existing.id !== next.id) throw new Error('registry skill collision: different registry skill identity');
  if (!existing.sha256 || existing.integrity?.digest !== existing.sha256 || existing.integrity?.status !== 'verified') {
    throw new Error('registry skill replacement rejected: existing verified digest required');
  }
  validateRegistryContent(buildRegistryReverifyContent(existing));
  const active = join(finalDir, 'SKILL.md');
  assertNoSymlinkPath(projectRoot, active);
  if (lstatSync(finalDir).isSymbolicLink()) throw new Error('registry skill collision: symlink skill path rejected');
  if (lstatSync(active).isSymbolicLink()) throw new Error('registry skill collision: symlink skill file rejected');
  const current = computeSkillDigest(readFileSync(active));
  if (current !== existing.sha256) throw new Error('registry skill replacement rejected: existing disk digest mismatch');
}

export function evaluateSkillTrustForExecution(rec: SkillTrustInput): SkillExecutionDecision {
  if (rec.enabled === false) return { ok: false, trust: 'blocked', reason: 'skill disabled' };
  if (rec.addedBy === 'native' || rec.provenance?.kind === 'bundled-native') {
    return { ok: true, trust: 'bundled-native', reason: 'bundled native skill' };
  }
  if (isRegistryManagedSkill(rec)) {
    if (rec.provenance?.kind !== 'registry') return { ok: false, trust: 'blocked', reason: 'registry-managed skill lacks verified registry provenance' };
    if (rec.integrity?.status !== 'verified') return { ok: false, trust: 'blocked', reason: 'registry-managed skill is not verified' };
    try {
      validateRegistryContent(buildRegistryReverifyContent(rec));
      return { ok: true, trust: 'registry-audited', reason: 'exact digest audit verified' };
    } catch (e) {
      return { ok: false, trust: 'blocked', reason: e instanceof Error ? e.message : 'registry integrity validation failed' };
    }
  }
  if (rec.provenance?.kind === 'project-local' || rec.provenance?.kind === 'local-operator' || !rec.provenance?.kind) {
    return { ok: true, trust: 'local-operator', reason: 'local operator skill; not registry-audited' };
  }
  return { ok: false, trust: 'blocked', reason: 'unknown skill provenance' };
}

function writeExclusive(file: string, bytes: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function installVerifiedRegistrySkill(projectRoot: string, content: RegistrySkillContent, options: RegistrySkillReplacementOptions = {}): VerifiedSkillInstallRecord {
  const rec = validateRegistryContent(content);
  const root = skillsRoot(projectRoot);
  const finalDir = skillDir(projectRoot, rec.slug);
  mkdirSync(root, { recursive: true });
  assertNoSymlinkPath(projectRoot, root);
  let finalExists = false;
  try {
    const st = lstatSync(finalDir);
    finalExists = true;
    if (st.isSymbolicLink()) throw new Error('registry skill collision: symlink skill path rejected');
    if (!st.isDirectory()) throw new Error('registry skill collision: existing skill path is not a directory');
    assertVerifiedRegistryReplacement(projectRoot, rec, finalDir, options.existing);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'ENOENT') throw e;
  }
  const tmp = join(root, `.tmp-${rec.slug}-${process.pid}-${randomBytes(8).toString('hex')}`);
  assertInside(root, tmp);
  mkdirSync(tmp, { recursive: false });
  try {
    writeExclusive(join(tmp, 'SKILL.md'), content.skillMd);
    const reread = readFileSync(join(tmp, 'SKILL.md'));
    if (computeSkillDigest(reread) !== rec.sha256) throw new Error('digest mismatch after write');
    if (finalExists) {
      const backup = join(root, `.old-${rec.slug}-${process.pid}-${randomBytes(8).toString('hex')}`);
      renameSync(finalDir, backup);
      try {
        renameSync(tmp, finalDir);
        rmSync(backup, { recursive: true, force: true });
      } catch (e) {
        if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
        renameSync(backup, finalDir);
        throw e;
      }
    } else {
      renameSync(tmp, finalDir);
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
  return rec;
}

export function quarantineSkill(projectRoot: string, idOrSlug: string): void {
  const dir = skillDir(projectRoot, idOrSlug);
  const active = join(dir, 'SKILL.md');
  let st;
  try { st = lstatSync(active); } catch { return; }
  if (st.isSymbolicLink()) {
    rmSync(active, { force: true });
    return;
  }
  const q = join(dir, 'SKILL.md.quarantine');
  rmSync(q, { force: true });
  renameSync(active, q);
}

export function reverifyRegistrySkill(projectRoot: string, content: RegistrySkillContent): { ok: true; digest: string } | { ok: false; reason: string } {
  let rec: VerifiedSkillInstallRecord;
  try { rec = validateRegistryContent(content); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : 'integrity validation failed' }; }
  const file = join(skillDir(projectRoot, rec.slug), 'SKILL.md');
  try {
    assertNoSymlinkPath(projectRoot, file);
    if (lstatSync(file).isSymbolicLink()) throw new Error('symlink skill file rejected');
    const got = computeSkillDigest(readFileSync(file));
    if (got !== rec.sha256) {
      quarantineSkill(projectRoot, rec.slug);
      return { ok: false, reason: 'digest mismatch after install' };
    }
    return { ok: true, digest: got };
  } catch (e) {
    quarantineSkill(projectRoot, rec.slug);
    return { ok: false, reason: e instanceof Error ? e.message : 'integrity check failed' };
  }
}

export function removeConfinedSkillDir(projectRoot: string, idOrSlug: string): void {
  const dir = skillDir(projectRoot, idOrSlug);
  if (!existsSync(dir)) return;
  if (lstatSync(dir).isSymbolicLink()) throw new Error('refusing to remove symlink skill directory');
  rmSync(dir, { recursive: true, force: true });
}

export function truthfulSkillLabel(rec: { addedBy?: string; version?: string; sha256?: string; integrity?: SkillIntegrityRecord; provenance?: { kind?: string } }) {
  if (rec.addedBy === 'native' || rec.provenance?.kind === 'bundled-native') {
    return { provenance: 'bundled-native', trust: 'bundle-hash', version: rec.version || 'bundled' };
  }
  if (rec.provenance?.kind === 'registry' && rec.integrity?.status === 'verified' && rec.sha256) {
    return { provenance: 'registry', trust: 'audit-bound-digest', digest: rec.sha256.slice(0, 12), version: rec.version };
  }
  if (rec.provenance?.kind === 'legacy-registry') {
    return { provenance: 'legacy-registry', trust: 'legacy-unverified', version: rec.version };
  }
  return { provenance: 'local-operator', trust: 'not-registry-audited' };
}
