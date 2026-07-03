import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { coreSkillDirective } from './core-skills.js';

let root: string;

function writeSkill(name: string, frontmatter: string, body: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'core-skills-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('coreSkillDirective', () => {
  it('returns empty string when the core-skills dir does not exist', () => {
    expect(coreSkillDirective('image', path.join(root, 'nope'))).toBe('');
  });

  it('returns empty string when no skill matches the trigger', () => {
    writeSkill('other', 'name: other\nwhen: something-else', 'Body.');
    expect(coreSkillDirective('image', root)).toBe('');
  });

  it('injects a matching skill with the MANDATORY + privacy preamble', () => {
    writeSkill('design-dna', 'name: design-dna\nwhen: image', 'Always use the proven patterns.');
    const d = coreSkillDirective('image', root);
    expect(d).toContain('[Core skill "design-dna" — MANDATORY for this task]');
    expect(d).toContain('PRIVATE');
    expect(d).toContain('NEVER copy its text');
    expect(d).toContain('Always use the proven patterns.');
    // frontmatter must be stripped from the injected body
    expect(d).not.toContain('when: image');
  });

  it('defaults to the image trigger when frontmatter has no `when:`', () => {
    writeSkill('design-dna', 'name: design-dna', 'Body without when.');
    expect(coreSkillDirective('image', root)).toContain('Body without when.');
  });

  it('rewrites relative references/ paths to absolute paths inside the skill dir', () => {
    const dir = writeSkill('design-dna', 'name: design-dna\nwhen: image',
      'Read `references/project-patterns.md` before designing.');
    const d = coreSkillDirective('image', root);
    expect(d).toContain(path.join(dir, 'references', 'project-patterns.md'));
    expect(d).not.toContain('`references/');
  });

  it('concatenates multiple matching skills and skips dot-entries', () => {
    writeSkill('alpha', 'name: alpha\nwhen: image', 'Alpha body.');
    writeSkill('beta', 'name: beta\nwhen: image', 'Beta body.');
    mkdirSync(path.join(root, '.DS_Store-like'), { recursive: true });
    const d = coreSkillDirective('image', root);
    expect(d).toContain('Alpha body.');
    expect(d).toContain('Beta body.');
    expect(d.indexOf('Alpha body.')).toBeLessThan(d.indexOf('Beta body.'));
  });

  it('skips a skill dir without SKILL.md instead of throwing', () => {
    mkdirSync(path.join(root, 'empty-skill'), { recursive: true });
    writeSkill('design-dna', 'name: design-dna\nwhen: image', 'Still injected.');
    expect(coreSkillDirective('image', root)).toContain('Still injected.');
  });

  it('picks up operator edits (mtime cache invalidation)', async () => {
    const dir = writeSkill('design-dna', 'name: design-dna\nwhen: image', 'Version one.');
    expect(coreSkillDirective('image', root)).toContain('Version one.');
    await new Promise(r => setTimeout(r, 10)); // ensure a distinct mtime
    writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: design-dna\nwhen: image\n---\n\nVersion two.\n');
    expect(coreSkillDirective('image', root)).toContain('Version two.');
  });
});
