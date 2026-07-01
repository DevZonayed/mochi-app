import { describe, it, expect, vi } from 'vitest';
// engine.ts (and its import chain) pulls in `electron`; mock it so this pure-function
// test can value-import engine.js in the node test env (mirrors the engine tests).
vi.mock('electron', () => ({
  app: { getPath: () => `/tmp/maestro-skills-reply-${process.pid}`, getName: () => 'maestro', getVersion: () => '0.0.0' },
  shell: { openExternal: () => {} },
}));
import { formatSkillInstallReply } from './engine.js';

/* Root cause this guards (see engine.ts add_skill_to_project): a registry skill
   installed MID-TURN is not re-scanned by the running Agent SDK CLI — settingSources
   discovery is a startup-only scan — so the freshly written SKILL.md never reaches the
   model via the structured Skill listing that turn. The fix delivers the skill body
   INLINE in the tool result so the agent follows it immediately ("dynamically loaded
   AND followed"), instead of relying on a separate Read it sometimes skipped. */

const rec = { name: 'PDF Tools', slug: 'anthropics-skills-pdf', sha256: 'abcdef0123456789deadbeef' };

describe('formatSkillInstallReply', () => {
  it('delivers the SKILL.md body inline with a follow directive', () => {
    const body = '---\nname: pdf\n---\n\n# How to split a PDF\nUse pdftk to ...';
    const out = formatSkillInstallReply(rec, body);
    expect(out).toContain(body);                       // the actual instructions reach the model
    expect(out).toContain('Follow these instructions');
    expect(out).toContain('.claude/skills/anthropics-skills-pdf/SKILL.md');
    expect(out).toContain('Skill tool');               // also pointed at first-class invocation
  });

  it('caps the inline body at 32k and marks the truncation', () => {
    const big = 'x'.repeat(40000);
    const out = formatSkillInstallReply(rec, big);
    expect(out).toContain('[truncated by Maestro after 32000 characters]');
    // body slice is exactly 32000 chars of payload, not the whole 40000
    expect(out).toContain('x'.repeat(32000));
    expect(out).not.toContain('x'.repeat(32001));
  });

  it('does NOT truncate a body at/under the cap', () => {
    const exact = 'y'.repeat(32000);
    const out = formatSkillInstallReply(rec, exact);
    expect(out).not.toContain('[truncated by Maestro');
    expect(out).toContain(exact);
  });

  it('falls back to the read nudge when the body could not be loaded', () => {
    for (const empty of [null, '']) {
      const out = formatSkillInstallReply(rec, empty);
      expect(out).toContain('Now read that file and follow it.');
      expect(out).not.toContain('Follow these instructions');
      expect(out).toContain('It is now active for this project');
    }
  });

  it('includes a short sha256 when present and omits it otherwise', () => {
    expect(formatSkillInstallReply(rec, 'body')).toContain('(sha256 abcdef012345)');
    const noSha = formatSkillInstallReply({ name: 'X', slug: 'x' }, 'body');
    expect(noSha).not.toContain('sha256');
    expect(noSha).toContain('Installed "X" → .claude/skills/x/SKILL.md');
  });
});
