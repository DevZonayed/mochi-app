import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-localapi-skill-integrity-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import type { LocalEngine } from './engine.js';

const body = '---\nname: demo\n---\n\n# Demo\n';
const sha = createHash('sha256').update(body).digest('hex');

function setup() {
  const s = new Store();
  const emit = vi.fn();
  const engine = { run: vi.fn(), isRunning: vi.fn(() => false), cancel: vi.fn(() => false) } as unknown as LocalEngine;
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit);
  const projectPath = join(hoisted.dir, 'proj');
  mkdirSync(projectPath, { recursive: true });
  const project = s.createProject({ name: 'Skills', path: projectPath });
  return { s, dispatch, project };
}

function registryResponse(over: Record<string, unknown> = {}) {
  return {
    id: 'owner/repo/demo',
    name: 'Demo',
    skillMd: body,
    sha256: sha,
    expectedDigest: sha,
    provenance: { kind: 'registry', source: 'https://github.com/owner/repo', version: 'latest', commit: 'abc123' },
    audit: { identity: `owner/repo/demo:skills.sh:pass:${sha}`, status: 'pass', auditedDigest: sha, checkedAt: '2026-07-16T00:00:00.000Z' },
    risk: 'LOW',
    source: 'https://github.com/owner/repo',
    enabled: true,
    ...over,
  };
}

describe('localApi skill integrity enforcement', () => {
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(registryResponse()), { status: 200, headers: { 'content-type': 'application/json' } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('installs only audit-bound digest content through the direct API path', async () => {
    const { dispatch, project } = setup();
    const out = await dispatch('addSkillToProject', { projectId: project.id, skillId: 'owner/repo/demo' }) as { skill: { integrity?: { status: string }; sha256?: string; enabled?: boolean } };
    expect(out.skill.sha256).toBe(sha);
    expect(out.skill.integrity?.status).toBe('verified');
    expect(out.skill.enabled).toBe(true);
    expect(existsSync(join(project.path!, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(true);
  });

  it('blocks digest mismatch before the target folder is written', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(registryResponse({ sha256: createHash('sha256').update('other').digest('hex'), expectedDigest: createHash('sha256').update('other').digest('hex') })), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { dispatch, project } = setup();
    await expect(dispatch('addSkillToProject', { projectId: project.id, skillId: 'owner/repo/demo' })).rejects.toThrow(/digest mismatch/i);
    expect(existsSync(join(project.path!, '.claude', 'skills', 'demo'))).toBe(false);
  });

  it('blocks high-risk audit policy through direct API install', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(registryResponse({ risk: 'HIGH' })), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { dispatch, project } = setup();
    await expect(dispatch('addSkillToProject', { projectId: project.id, skillId: 'owner/repo/demo' })).rejects.toThrow(/risk/i);
  });

  it('rejects registry install colliding with a local same-slug skill and preserves local disk and state', async () => {
    const { dispatch, project } = setup();
    const dir = join(project.path!, '.claude', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'local skill bytes', 'utf8');
    const before = lstatSync(dir).ino;

    await expect(dispatch('addSkillToProject', { projectId: project.id, skillId: 'owner/repo/demo' })).rejects.toThrow(/collision|existing/i);

    expect(lstatSync(dir).ino).toBe(before);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('local skill bytes');
    const listed = await dispatch('listProjectSkills', { id: project.id }) as { skills: Array<{ slug: string; enabled?: boolean; trustLabel?: { provenance: string; trust: string } }> };
    expect(listed.skills.find(s => s.slug === 'demo')).toMatchObject({
      enabled: true,
      trustLabel: { provenance: 'local-operator', trust: 'not-registry-audited' },
    });
  });

  it('does not enable a legacy-unverified registry record', async () => {
    const { s, dispatch, project } = setup();
    mkdirSync(join(project.path!, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(project.path!, '.claude', 'skills', 'demo', 'SKILL.md.disabled'), body, 'utf8');
    s.recordSkillInstall(project.id, {
      id: 'owner/repo/demo', slug: 'demo', name: 'Demo', source: 'https://github.com/owner/repo',
      version: 'latest', enabled: false, addedBy: 'operator',
      integrity: { algorithm: 'sha256', digest: sha, status: 'legacy-unverified', checkedAt: 0 },
      provenance: { kind: 'legacy-registry', source: 'https://github.com/owner/repo', version: 'latest' },
    });
    await expect(dispatch('setProjectSkillEnabled', { projectId: project.id, skillId: 'owner/repo/demo', enabled: true })).rejects.toThrow(/registry/i);
  });

  it('keeps manually managed local skills enabled and labels them as local not registry-audited', async () => {
    const { dispatch, project } = setup();
    mkdirSync(join(project.path!, '.claude', 'skills', 'manual'), { recursive: true });
    writeFileSync(join(project.path!, '.claude', 'skills', 'manual', 'SKILL.md'), '---\nname: manual\n---\n\n# Manual\n', 'utf8');
    const out = await dispatch('listProjectSkills', { id: project.id }) as { skills: Array<{ slug: string; enabled?: boolean; trustLabel?: { provenance: string; trust: string } }> };
    const manual = out.skills.find(s => s.slug === 'manual');
    expect(manual).toMatchObject({
      enabled: true,
      trustLabel: { provenance: 'local-operator', trust: 'not-registry-audited' },
    });
    await expect(dispatch('setProjectSkillEnabled', { projectId: project.id, skillId: 'manual', enabled: true })).resolves.toMatchObject({ skill: { enabled: true } });
  });

  it('does not relabel an unrecorded local folder with a native skill slug as bundled native', async () => {
    const { dispatch, project } = setup();
    mkdirSync(join(project.path!, '.claude', 'skills', 'imagegen'), { recursive: true });
    writeFileSync(join(project.path!, '.claude', 'skills', 'imagegen', 'SKILL.md'), '# local imagegen', 'utf8');

    const out = await dispatch('listProjectSkills', { id: project.id }) as { skills: Array<{ slug: string; addedBy?: string; trustLabel?: { provenance: string; trust: string } }> };
    const imagegen = out.skills.find(s => s.slug === 'imagegen');

    expect(imagegen).toMatchObject({
      addedBy: 'operator',
      trustLabel: { provenance: 'local-operator', trust: 'not-registry-audited' },
    });
  });

  it('does not relabel a local native-slug folder as bundled native even when a stale native record exists', async () => {
    const { s, dispatch, project } = setup();
    mkdirSync(join(project.path!, '.claude', 'skills', 'imagegen'), { recursive: true });
    writeFileSync(join(project.path!, '.claude', 'skills', 'imagegen', 'SKILL.md'), '# local imagegen', 'utf8');
    s.recordSkillInstall(project.id, {
      id: 'openai/skills/imagegen', slug: 'imagegen', name: 'imagegen', enabled: true, addedBy: 'native',
      version: 'bundled', sha256: 'abcd',
      provenance: { kind: 'bundled-native' },
      integrity: { algorithm: 'sha256', digest: 'abcd', status: 'verified', checkedAt: 0 },
    });

    const out = await dispatch('listProjectSkills', { id: project.id }) as { skills: Array<{ slug: string; addedBy?: string; trustLabel?: { provenance: string; trust: string } }> };
    const imagegen = out.skills.find(s => s.slug === 'imagegen');

    expect(imagegen).toMatchObject({
      addedBy: 'operator',
      trustLabel: { provenance: 'local-operator', trust: 'not-registry-audited' },
    });
    expect(out.skills.filter(s => s.slug === 'imagegen')).toHaveLength(1);
  });

  it('does not create a bundled-native record when toggling an unmarked local native-slug folder', async () => {
    const { dispatch, project } = setup();
    mkdirSync(join(project.path!, '.claude', 'skills', 'imagegen'), { recursive: true });
    writeFileSync(join(project.path!, '.claude', 'skills', 'imagegen', 'SKILL.md'), '# local imagegen', 'utf8');

    const out = await dispatch('setProjectSkillEnabled', { projectId: project.id, skillId: 'imagegen', enabled: true }) as { skill: { addedBy?: string; provenance?: { kind?: string } } };

    expect(out.skill).toMatchObject({ addedBy: 'operator', provenance: { kind: 'local-operator' } });
  });

  it('does not rediscover a tampered registry slug as local operator trust', async () => {
    const { s, dispatch, project } = setup();
    mkdirSync(join(project.path!, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(project.path!, '.claude', 'skills', 'demo', 'SKILL.md'), 'tampered', 'utf8');
    s.recordSkillInstall(project.id, {
      id: 'owner/repo/demo', slug: 'demo', name: 'Demo', source: 'https://github.com/owner/repo',
      version: 'latest', sha256: sha, enabled: true, addedBy: 'operator',
      integrity: { algorithm: 'sha256', digest: sha, status: 'verified', checkedAt: 0 },
      provenance: { kind: 'registry', source: 'https://github.com/owner/repo', version: 'latest' },
      auditEvidence: { identity: `owner/repo/demo:skills.sh:pass:${sha}`, status: 'pass', auditedDigest: sha },
    });
    const out = await dispatch('listProjectSkills', { id: project.id }) as { skills: Array<{ slug: string; enabled?: boolean; disabledReason?: string; trustLabel?: { provenance: string } }> };
    const demo = out.skills.find(s => s.slug === 'demo');
    expect(demo).toMatchObject({ enabled: false, trustLabel: { provenance: 'registry' } });
    expect(out.skills.filter(s => s.slug === 'demo')).toHaveLength(1);
  });
});
