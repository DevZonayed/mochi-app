import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-codex-skill-integrity-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { CodexBridge } from './codex-bridge.js';

const body = '---\nname: demo\n---\n\n# Demo\n';
const sha = createHash('sha256').update(body).digest('hex');

describe('CodexBridge skill integrity exposure', () => {
  it('lists verified registry and local operator skills truthfully while blocking legacy registry rows', async () => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    const store = new Store();
    const projectPath = join(hoisted.dir, 'proj');
    mkdirSync(projectPath, { recursive: true });
    const project = store.createProject({ name: 'Project', path: projectPath });
    mkdirSync(join(projectPath, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'SKILL.md'), body, 'utf8');
    mkdirSync(join(projectPath, '.claude', 'skills', 'manual'), { recursive: true });
    writeFileSync(join(projectPath, '.claude', 'skills', 'manual', 'SKILL.md'), '---\nname: manual\n---\n\n# Manual\n', 'utf8');
    store.recordSkillInstall(project.id, {
      id: 'owner/repo/demo', slug: 'demo', name: 'Demo', enabled: true, addedBy: 'operator',
      source: 'https://github.com/owner/repo', version: 'latest', sha256: sha, risk: 'LOW',
      provenance: { kind: 'registry', source: 'https://github.com/owner/repo', version: 'latest' },
      integrity: { algorithm: 'sha256', digest: sha, status: 'verified', checkedAt: 0 },
      auditEvidence: { identity: `owner/repo/demo:unit:pass:${sha}`, status: 'pass', auditedDigest: sha },
    });
    store.recordSkillInstall(project.id, {
      id: 'manual', slug: 'manual', name: 'Manual', enabled: true, addedBy: 'operator',
      provenance: { kind: 'local-operator' },
      integrity: { algorithm: 'sha256', digest: '', status: 'unverified-local', checkedAt: 0 },
    });
    store.recordSkillInstall(project.id, {
      id: 'owner/repo/old', slug: 'old', name: 'Old', enabled: true, addedBy: 'operator',
      source: 'https://github.com/owner/repo',
      provenance: { kind: 'legacy-registry', source: 'https://github.com/owner/repo' },
      integrity: { algorithm: 'sha256', digest: sha, status: 'legacy-unverified', checkedAt: 0 },
    });

    const bridge = new CodexBridge(store);
    const out = await (bridge as unknown as { runTool(reg: { projectId: string; skills: boolean; bg: boolean; img: boolean; images: unknown[] }, tool: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> })
      .runTool({ projectId: project.id, skills: true, bg: false, img: false, images: [] }, 'list_project_skills', {});
    const text = out.content[0]?.text ?? '';
    expect(text).toContain('owner/repo/demo');
    expect(text).toContain('sha256=');
    expect(text).toContain('manual');
    expect(text).toContain('trust=not-registry-audited');
    expect(text).not.toContain('owner/repo/old');
  });
});
