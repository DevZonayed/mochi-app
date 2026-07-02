/* Store.recordNativeSkills — the store mirror of the bundled native skills.

   The contract these test:
   - upsert preserves an operator's disable across runs/upgrades;
   - an operator/agent record with the SAME SLUG as a native (registry skill
     installed over a native slug) is NEVER converted to addedBy:'native' —
     conversion would misattribute it in the UI and make it eligible for the
     native prune;
   - native records whose slug leaves the bundle are pruned; operator/agent
     records never are.

   Only `app.getPath` is mocked so the Store reads/writes a tmp dir. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-native-skills-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

const nativeRec = (slug: string, over?: Record<string, unknown>) => ({
  id: `openai/skills/${slug}`, slug, name: slug, description: `${slug} skill`,
  source: 'https://github.com/openai/skills', version: 'bundled', sha256: 'abcd',
  enabled: true, addedBy: 'native' as const, ...over,
});

describe('Store.recordNativeSkills', () => {
  let s: Store;
  let projectId: string;
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    s = new Store();
    projectId = s.createProject({ name: 'Proj' }).id;
  });

  it('inserts natives and preserves an existing disable across upserts', () => {
    s.recordNativeSkills(projectId, [nativeRec('imagegen'), nativeRec('pdf')]);
    s.setInstalledSkillEnabled(projectId, 'pdf', false);
    // Next run re-records with enabled:true — the disable must survive.
    s.recordNativeSkills(projectId, [nativeRec('imagegen'), nativeRec('pdf')]);
    const pdf = s.listInstalledSkills(projectId).find(x => x.slug === 'pdf')!;
    expect(pdf.enabled).toBe(false);
  });

  it('never converts a same-slug operator/agent record to native (registry-over-native)', () => {
    // Operator installed their own pdf skill from the registry.
    s.recordSkillInstall(projectId, {
      id: 'some-registry/pdf', slug: 'pdf', name: 'My PDF', version: 'latest',
      enabled: true, addedBy: 'operator',
    });
    s.recordNativeSkills(projectId, [nativeRec('pdf'), nativeRec('imagegen')]);
    const list = s.listInstalledSkills(projectId);
    const pdf = list.find(x => x.slug === 'pdf')!;
    expect(pdf.addedBy).toBe('operator');
    expect(pdf.id).toBe('some-registry/pdf');
    // And the native prune must not touch it when pdf leaves the bundle.
    s.recordNativeSkills(projectId, [nativeRec('imagegen')]);
    expect(s.listInstalledSkills(projectId).some(x => x.slug === 'pdf')).toBe(true);
  });

  it('prunes a native record whose slug left the bundle', () => {
    s.recordNativeSkills(projectId, [nativeRec('imagegen'), nativeRec('old-skill')]);
    s.recordNativeSkills(projectId, [nativeRec('imagegen')]);
    const list = s.listInstalledSkills(projectId);
    expect(list.some(x => x.slug === 'old-skill')).toBe(false);
    expect(list.some(x => x.slug === 'imagegen')).toBe(true);
  });
});
