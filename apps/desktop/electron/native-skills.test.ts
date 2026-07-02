import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_SKILLS, ensureNativeSkills, nativeSkillsPromptBlock, nativeSkillSummaries,
  nativeSkillSlugs, isNativeSkill, nativeSkillsVersion,
} from './native-skills.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'native-skills-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const skillDir = (slug: string) => join(root, '.claude', 'skills', slug);

describe('native skills catalog', () => {
  it('bundles the openai/skills catalog including imagegen', () => {
    expect(NATIVE_SKILLS.length).toBeGreaterThanOrEqual(40);
    const slugs = nativeSkillSlugs();
    expect(slugs).toContain('imagegen');
    expect(slugs).toContain('pdf');
    expect(slugs).toContain('skill-creator');
    // imagegen must carry its real SKILL.md body.
    const imagegen = NATIVE_SKILLS.find(s => s.slug === 'imagegen')!;
    expect(imagegen.files['SKILL.md']).toContain('Image Generation Skill');
  });

  it('bundles the anthropic document skills (category docs); anthropic pdf supersedes openai pdf', () => {
    for (const slug of ['docx', 'pdf', 'pptx', 'xlsx', 'doc-coauthoring']) {
      const s = NATIVE_SKILLS.find(x => x.slug === slug);
      expect(s, slug).toBeTruthy();
      expect(s!.category).toBe('docs');
      expect(s!.id).toBe(`anthropics/skills/${slug}`);
      expect(s!.files['SKILL.md']).toBeTruthy();
    }
  });

  it('excludes the deliberately-dropped skills', () => {
    const slugs = nativeSkillSlugs();
    expect(slugs).not.toContain('migrate-to-codex');
    expect(slugs).not.toContain('chatgpt-apps');
  });

  it('recognises native skills by slug and id', () => {
    expect(isNativeSkill('imagegen')).toBe(true);
    expect(isNativeSkill('openai/skills/imagegen')).toBe(true);
    expect(isNativeSkill('anthropics/skills/docx')).toBe(true);
    expect(isNativeSkill('some-random-registry-skill')).toBe(false);
  });

  it('has a stable version fingerprint', () => {
    expect(nativeSkillsVersion()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('ensureNativeSkills', () => {
  it('materialises every skill into .claude/skills on first run', () => {
    const res = ensureNativeSkills(root);
    expect(res.length).toBe(NATIVE_SKILLS.length);
    expect(res.every(r => r.status === 'installed')).toBe(true);
    expect(existsSync(join(skillDir('imagegen'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir('imagegen'), '.mochi-native'))).toBe(true);
    // Nested reference files are copied too.
    expect(existsSync(join(skillDir('imagegen'), 'references', 'prompting.md'))).toBe(true);
  });

  it('is idempotent — a second run changes nothing', () => {
    ensureNativeSkills(root);
    const res2 = ensureNativeSkills(root);
    expect(res2.every(r => r.status === 'unchanged')).toBe(true);
  });

  it('leaves a human/registry-owned folder (no marker) untouched', () => {
    const dir = skillDir('imagegen');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# my own imagegen', 'utf8');
    const res = ensureNativeSkills(root);
    expect(res.find(r => r.slug === 'imagegen')!.status).toBe('kept');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('# my own imagegen');
  });

  it('writes a managed .gitignore so app skills do not pollute the user repo', () => {
    ensureNativeSkills(root);
    const gi = readFileSync(join(root, '.claude', 'skills', '.gitignore'), 'utf8');
    expect(gi).toContain('/imagegen/');
    expect(gi).toContain('maestro native skills');
    // Idempotent + preserves operator rules.
    writeFileSync(join(root, '.claude', 'skills', '.gitignore'), gi + '\n/my-own-skill/\n', 'utf8');
    ensureNativeSkills(root);
    const gi2 = readFileSync(join(root, '.claude', 'skills', '.gitignore'), 'utf8');
    expect(gi2).toContain('/my-own-skill/');
    expect(gi2.match(/maestro native skills \(app-managed/g)?.length).toBe(1);
  });

  it('prunes a stale native folder (marker present, slug no longer bundled) but never an unmarked one', () => {
    ensureNativeSkills(root);
    // Simulate a skill that WAS bundled in an older app version.
    const stale = skillDir('migrate-to-codex');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'SKILL.md'), '# old bundled skill', 'utf8');
    writeFileSync(join(stale, '.mochi-native'), 'deadbeef', 'utf8');
    // And a human-owned folder with no marker — must survive.
    const own = skillDir('my-own-skill');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'SKILL.md'), '# mine', 'utf8');
    const res = ensureNativeSkills(root);
    expect(res.find(r => r.slug === 'migrate-to-codex')?.status).toBe('removed');
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(own, 'SKILL.md'))).toBe(true);
  });

  it('respects a soft-disabled native skill (SKILL.md.disabled present)', () => {
    ensureNativeSkills(root);
    const dir = skillDir('pdf');
    // Simulate the operator disabling it: remove active, drop the disabled marker.
    rmSync(join(dir, 'SKILL.md'));
    writeFileSync(join(dir, 'SKILL.md.disabled'), 'x', 'utf8');
    const res = ensureNativeSkills(root);
    expect(res.find(r => r.slug === 'pdf')!.status).toBe('unchanged');
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);
  });
});

describe('nativeSkillsPromptBlock', () => {
  it('leads with the non-negotiable imagegen rule and lists the catalog', () => {
    const block = nativeSkillsPromptBlock();
    expect(block).toContain('<native_skills');
    expect(block).toContain('NON-NEGOTIABLE');
    expect(block).toContain('imagegen');
    expect(block).toContain('NEVER substitute SVG');
    // Every active skill appears in the index.
    for (const s of NATIVE_SKILLS) expect(block).toContain(`\`${s.slug}\``);
  });

  it('carries the office-documents rule (both modes) pointing at the doc skills', () => {
    for (const block of [nativeSkillsPromptBlock(), nativeSkillsPromptBlock(undefined, { index: false })]) {
      expect(block).toContain('### Office documents');
      expect(block).toContain('`docx`');
      expect(block).toContain('`xlsx`');
    }
  });

  it('drops a disabled skill (and its imagegen mandate when imagegen is off)', () => {
    const block = nativeSkillsPromptBlock(new Set(['imagegen', 'pdf']));
    expect(block).not.toContain('NON-NEGOTIABLE');
    expect(block).not.toContain('`pdf`');
    expect(block).toContain('`skill-creator`');
  });

  it('lean mode (index:false, for Claude) keeps the imagegen rule but drops the catalog', () => {
    const block = nativeSkillsPromptBlock(undefined, { index: false });
    expect(block).toContain('<native_skills');
    expect(block).toContain('NON-NEGOTIABLE');
    expect(block).toContain('NEVER substitute SVG');
    // No catalog index — only skills named in the standing rules (imagegen, doc skills) may appear.
    expect(block).not.toContain('### The catalog');
    expect(block).not.toContain('`skill-creator`');
    expect(block).not.toContain('`gh-fix-ci`');
    // Pointer to auto-discovered skills replaces the index.
    expect(block).toContain('auto-discovered');
    // And it is meaningfully smaller than the full block.
    expect(block.length).toBeLessThan(nativeSkillsPromptBlock().length / 3);
  });

  it('lean mode with imagegen disabled shrinks to just the header + pointer', () => {
    const block = nativeSkillsPromptBlock(new Set(['imagegen']), { index: false });
    expect(block).not.toContain('NON-NEGOTIABLE');
    expect(block).toContain('auto-discovered');
    expect(block).toContain('</native_skills>');
  });

  it('index:true (Codex) and the default produce the full catalog', () => {
    expect(nativeSkillsPromptBlock(undefined, { index: true })).toBe(nativeSkillsPromptBlock());
  });
});

describe('nativeSkillSummaries', () => {
  it('returns id/slug/name/sha for the store mirror', () => {
    const s = nativeSkillSummaries();
    expect(s.length).toBe(NATIVE_SKILLS.length);
    const ig = s.find(x => x.slug === 'imagegen')!;
    expect(ig.id).toBe('openai/skills/imagegen');
    expect(ig.sha256).toMatch(/^[0-9a-f]{16}$/);
  });
});
