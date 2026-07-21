import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-engine-mcp-skill-integrity-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' }, shell: {} }));

import { Store } from './store.js';
import { ensureMcpRegistrySkillDependency } from './engine.js';

const body = '---\nname: demo\n---\n\n# Demo\n';
const sha = createHash('sha256').update(body).digest('hex');

function registryResponse() {
  return {
    id: 'owner/repo/demo',
    name: 'Demo',
    skillMd: body,
    sha256: sha,
    expectedDigest: sha,
    provenance: { kind: 'registry', source: 'https://github.com/owner/repo', version: 'latest', commit: 'abc123' },
    audit: { identity: `owner/repo/demo:unit:pass:${sha}`, status: 'pass', auditedDigest: sha, checkedAt: '2026-07-16T00:00:00.000Z' },
    risk: 'LOW',
    source: 'https://github.com/owner/repo',
    enabled: true,
  };
}

function setup() {
  rmSync(hoisted.dir, { recursive: true, force: true });
  const store = new Store();
  const projectPath = join(hoisted.dir, 'proj');
  mkdirSync(projectPath, { recursive: true });
  const project = store.createProject({ name: 'Project', path: projectPath });
  return { store, project, projectPath };
}

describe('MCP registry skill dependency integrity', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const payload = url.includes('/registry/skill/content')
        ? registryResponse()
        : { ...registryResponse(), description: 'Demo skill', sourceRepo: 'owner/repo', version: 'latest' };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('blocks an MCP registry dependency colliding with a local same-slug skill without mutating local state', async () => {
    const { store, project, projectPath } = setup();
    const dir = join(projectPath, '.claude', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'local bytes', 'utf8');
    store.recordSkillInstall(project.id, {
      id: 'demo', slug: 'demo', name: 'Demo Local', enabled: true, addedBy: 'operator',
      provenance: { kind: 'local-operator' },
      integrity: { algorithm: 'sha256', digest: '', status: 'unverified-local', checkedAt: 0 },
    });

    const out = await ensureMcpRegistrySkillDependency({ store, projectId: project.id, cwd: projectPath, skillId: 'owner/repo/demo' });

    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/collision|registry dependency/i) });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('local bytes');
    expect(store.listInstalledSkills(project.id)).toHaveLength(1);
    expect(store.listInstalledSkills(project.id)[0]).toMatchObject({ id: 'demo', enabled: true, provenance: { kind: 'local-operator' } });
  });

  it('satisfies an MCP registry dependency only with the exact verified registry artifact', async () => {
    const { store, project, projectPath } = setup();
    const dir = join(projectPath, '.claude', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md.disabled'), body, 'utf8');
    store.recordSkillInstall(project.id, {
      id: 'owner/repo/demo', slug: 'demo', name: 'Demo', enabled: false, addedBy: 'agent',
      source: 'https://github.com/owner/repo', version: 'latest', sha256: sha,
      provenance: { kind: 'registry', source: 'https://github.com/owner/repo', version: 'latest' },
      integrity: { algorithm: 'sha256', digest: sha, status: 'verified', checkedAt: 0 },
      auditEvidence: { identity: `owner/repo/demo:unit:pass:${sha}`, status: 'pass', auditedDigest: sha },
    });

    const out = await ensureMcpRegistrySkillDependency({ store, projectId: project.id, cwd: projectPath, skillId: 'owner/repo/demo' });

    expect(out).toEqual({ ok: true });
    expect(store.listInstalledSkills(project.id)[0]).toMatchObject({ id: 'owner/repo/demo', enabled: true });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(body);
  });

  it('blocks a tampered MCP registry dependency and does not expose it', async () => {
    const { store, project, projectPath } = setup();
    const dir = join(projectPath, '.claude', 'skills', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'tampered', 'utf8');
    store.recordSkillInstall(project.id, {
      id: 'owner/repo/demo', slug: 'demo', name: 'Demo', enabled: true, addedBy: 'agent',
      source: 'https://github.com/owner/repo', version: 'latest', sha256: sha,
      provenance: { kind: 'registry', source: 'https://github.com/owner/repo', version: 'latest' },
      integrity: { algorithm: 'sha256', digest: sha, status: 'verified', checkedAt: 0 },
      auditEvidence: { identity: `owner/repo/demo:unit:pass:${sha}`, status: 'pass', auditedDigest: sha },
    });

    const out = await ensureMcpRegistrySkillDependency({ store, projectId: project.id, cwd: projectPath, skillId: 'owner/repo/demo' });

    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/integrity|digest/i) });
    expect(store.listInstalledSkills(project.id)[0]).toMatchObject({ id: 'owner/repo/demo', enabled: false });
  });
});
