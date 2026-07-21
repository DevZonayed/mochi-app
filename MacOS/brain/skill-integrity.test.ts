import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  assertRegistrySkillInstallable,
  computeSkillDigest,
  installVerifiedRegistrySkill,
  reverifyInstalledSkill,
  skillSlug,
  removeSkillFiles,
  setSkillFilesEnabled,
  truthfulSkillLabel,
  evaluateSkillTrustForExecution,
} from './skills-registry.js';

const body = '---\nname: demo\n---\n\n# Demo\n';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const goodEvidence = (content = body) => ({
  identity: 'audit:demo:1',
  status: 'passed',
  auditedDigest: sha(content),
  checkedAt: '2026-07-16T00:00:00.000Z',
});
const goodContent = (content = body) => ({
  id: 'owner/repo/demo',
  name: 'Demo',
  skillMd: content,
  sha256: sha(content),
  expectedDigest: sha(content),
  provenance: { kind: 'registry' as const, source: 'https://github.com/owner/repo', version: 'latest', commit: 'abc123' },
  audit: goodEvidence(content),
  risk: 'LOW',
  source: 'https://github.com/owner/repo',
});

describe('skill integrity lifecycle', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'maestro-skill-integrity-'));
  });

  it('computes exact-byte canonical sha256 and installs only matching registry content', () => {
    const rec = installVerifiedRegistrySkill(root, goodContent());
    expect(rec.slug).toBe('demo');
    expect(rec.sha256).toBe(sha(body));
    expect(readFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(body);
    expect(rec.integrity?.status).toBe('verified');
    expect(rec.auditEvidence?.auditedDigest).toBe(sha(body));
  });

  it('refuses digest mismatch before target write', () => {
    expect(() => installVerifiedRegistrySkill(root, { ...goodContent(), expectedDigest: sha('other'), sha256: sha('other') }))
      .toThrow(/digest mismatch/i);
    expect(existsSync(join(root, '.claude', 'skills', 'demo'))).toBe(false);
  });

  it('blocks stale audit evidence bound to a different digest', () => {
    expect(() => assertRegistrySkillInstallable({ ...goodContent(), audit: { ...goodEvidence('other') } }))
      .toThrow(/audit.*digest/i);
  });

  it.each(['HIGH', 'CRITICAL', 'BLOCKED'])('blocks %s risk policy', (risk) => {
    expect(() => assertRegistrySkillInstallable({ ...goodContent(), risk }))
      .toThrow(/risk/i);
  });

  it('blocks failed audit status', () => {
    expect(() => assertRegistrySkillInstallable({ ...goodContent(), audit: { ...goodEvidence(), status: 'failed' } }))
      .toThrow(/audit/i);
  });

  it('rejects traversal slug and symlink targets', () => {
    expect(() => skillSlug('../escape')).toThrow(/invalid skill slug/i);
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync('/tmp', join(root, '.claude', 'skills', 'demo'));
    expect(() => installVerifiedRegistrySkill(root, goodContent())).toThrow(/symlink/i);
  });

  it('rejects fresh registry install over an existing local directory without mutating bytes or path', () => {
    const dir = join(root, '.claude', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'local bytes', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'operator note', 'utf8');
    const before = lstatSync(dir).ino;

    expect(() => installVerifiedRegistrySkill(root, goodContent())).toThrow(/collision|existing/i);

    expect(lstatSync(dir).ino).toBe(before);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('local bytes');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('operator note');
  });

  it('rejects fresh registry install over a bundled-native collision without mutating bytes', () => {
    const dir = join(root, '.claude', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'bundled native bytes', 'utf8');
    const before = lstatSync(dir).ino;

    expect(() => installVerifiedRegistrySkill(root, goodContent(), {
      existing: {
        id: 'demo', slug: 'demo', name: 'Demo', enabled: true, addedBy: 'native',
        sha256: sha('bundled native bytes'),
        integrity: { algorithm: 'sha256', digest: sha('bundled native bytes'), status: 'verified', checkedAt: 1 },
        provenance: { kind: 'bundled-native', source: 'bundle', version: 'bundled' },
      },
    })).toThrow(/collision|registry-managed|provenance/i);

    expect(lstatSync(dir).ino).toBe(before);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('bundled native bytes');
  });

  it('rejects symlink and dangling collision entries without following moving or removing them', () => {
    const skills = join(root, '.claude', 'skills');
    mkdirSync(skills, { recursive: true });
    const liveTarget = mkdtempSync(join(tmpdir(), 'maestro-skill-live-target-'));
    writeFileSync(join(liveTarget, 'keep.txt'), 'keep', 'utf8');
    symlinkSync(liveTarget, join(skills, 'demo'));
    expect(() => installVerifiedRegistrySkill(root, goodContent())).toThrow(/symlink|collision/i);
    expect(lstatSync(join(skills, 'demo')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(liveTarget, 'keep.txt'), 'utf8')).toBe('keep');

    rmSync(join(skills, 'demo'));
    symlinkSync(join(root, 'missing-target'), join(skills, 'demo'));
    expect(() => installVerifiedRegistrySkill(root, goodContent())).toThrow(/symlink|collision/i);
    expect(lstatSync(join(skills, 'demo')).isSymbolicLink()).toBe(true);
  });

  it('allows explicit verified registry replacement only when existing disk bytes match the old digest', () => {
    const old = goodContent();
    const oldRec = installVerifiedRegistrySkill(root, old);
    const nextBody = '---\nname: demo\n---\n\n# Demo v2\n';
    const next = goodContent(nextBody);

    const updated = installVerifiedRegistrySkill(root, next, { existing: { ...oldRec, enabled: true } });

    expect(updated.sha256).toBe(sha(nextBody));
    expect(readFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(nextBody);
  });

  it('rejects registry replacement when the existing slug belongs to a different registry skill id', () => {
    const old = goodContent();
    const oldRec = installVerifiedRegistrySkill(root, old);
    const nextBody = '---\nname: demo\n---\n\n# Other registry Demo\n';
    const next = {
      ...goodContent(nextBody),
      id: 'other-owner/other-repo/demo',
      source: 'https://github.com/other-owner/other-repo',
      provenance: { kind: 'registry' as const, source: 'https://github.com/other-owner/other-repo', version: 'latest', commit: 'def456' },
      audit: { ...goodEvidence(nextBody), identity: 'audit:other-demo:1' },
    };

    expect(() => installVerifiedRegistrySkill(root, next, { existing: { ...oldRec, enabled: true } }))
      .toThrow(/registry.*identity|different registry skill/i);

    expect(readFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(body);
  });

  it('rejects explicit registry replacement when persisted old digest differs from disk and preserves disk', () => {
    const old = goodContent();
    const oldRec = installVerifiedRegistrySkill(root, old);
    const dir = join(root, '.claude', 'skills', 'demo');
    writeFileSync(join(dir, 'SKILL.md'), 'operator changed bytes', 'utf8');
    const before = lstatSync(dir).ino;
    const nextBody = '---\nname: demo\n---\n\n# Demo v2\n';

    expect(() => installVerifiedRegistrySkill(root, goodContent(nextBody), { existing: { ...oldRec, enabled: true } }))
      .toThrow(/existing.*digest|replacement/i);

    expect(lstatSync(dir).ino).toBe(before);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('operator changed bytes');
  });

  it('rejects a symlink SKILL.md before enable or reverify exposure', () => {
    installVerifiedRegistrySkill(root, goodContent());
    const dir = join(root, '.claude', 'skills', 'demo');
    rmSync(join(dir, 'SKILL.md'));
    symlinkSync('/tmp/elsewhere', join(dir, 'SKILL.md'));
    expect(reverifyInstalledSkill(root, goodContent())).toMatchObject({ ok: false, reason: expect.stringMatching(/symlink/i) });
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);
    expect(setSkillFilesEnabled(root, 'demo', true, goodContent())).toBe(false);
  });

  it('detects tamper before exposure and disables the registry skill', () => {
    installVerifiedRegistrySkill(root, goodContent());
    writeFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'tampered', 'utf8');
    const out = reverifyInstalledSkill(root, goodContent());
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/digest mismatch/i);
    expect(existsSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md.quarantine'))).toBe(true);
  });

  it('never removes through an escape symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'maestro-skill-outside-'));
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync(outside, join(root, '.claude', 'skills', 'demo'));
    expect(() => removeSkillFiles(root, 'demo')).toThrow(/symlink/i);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('labels native and local skills truthfully without fabricated audit claims', () => {
    expect(truthfulSkillLabel({ addedBy: 'native', version: 'bundled', sha256: 'abcd' })).toEqual({
      provenance: 'bundled-native',
      trust: 'bundle-hash',
      version: 'bundled',
    });
    expect(truthfulSkillLabel({ addedBy: 'operator', id: 'manual', slug: 'manual', provenance: { kind: 'local-operator' } })).toEqual({
      provenance: 'local-operator',
      trust: 'not-registry-audited',
    });
  });

  it('allows local operator skills without registry audit while blocking sticky registry downgrades', () => {
    expect(evaluateSkillTrustForExecution({
      id: 'manual', slug: 'manual', name: 'Manual', enabled: true, addedBy: 'operator',
      provenance: { kind: 'local-operator' },
      integrity: { algorithm: 'sha256', digest: '', status: 'unverified-local', checkedAt: 0 },
    })).toMatchObject({ ok: true, trust: 'local-operator' });

    expect(evaluateSkillTrustForExecution({
      id: 'owner/repo/demo', slug: 'demo', name: 'Demo', enabled: true, addedBy: 'operator',
      source: 'https://github.com/owner/repo',
      provenance: { kind: 'legacy-registry', source: 'https://github.com/owner/repo' },
      integrity: { algorithm: 'sha256', digest: sha(body), status: 'legacy-unverified', checkedAt: 0 },
    })).toMatchObject({ ok: false, reason: expect.stringMatching(/registry/i) });
  });

  it('exposes digest utility for exact byte checks', () => {
    expect(computeSkillDigest(body)).toBe(sha(body));
    expect(computeSkillDigest(Buffer.from(body))).toBe(sha(body));
  });
});
