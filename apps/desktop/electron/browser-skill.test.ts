import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureBrowserSkill,
  browserSkillSha256,
  BROWSER_SKILL_MD,
  BROWSER_SKILL_SLUG,
} from './browser-skill.js';

/* Auto-install of the bundled `browser` SKILL.md. The behavior under test is
   what we depend on at runtime in engine.ts: when browser mode is turned on we
   call ensureBrowserSkill(cwd) and the agent's `settingSources:['project']`
   picks the file up THIS turn — but only if it's not already there with
   identical content, AND it must never clobber an operator's customised copy. */

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'browser-skill-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

const skillFile = (r: string) => join(r, '.claude', 'skills', BROWSER_SKILL_SLUG, 'SKILL.md');

describe('ensureBrowserSkill', () => {
  it('writes the bundled SKILL.md into a fresh project', () => {
    const r = ensureBrowserSkill(root);
    expect(r).toEqual({ slug: 'browser', status: 'installed' });
    expect(existsSync(skillFile(root))).toBe(true);
    expect(readFileSync(skillFile(root), 'utf8')).toBe(BROWSER_SKILL_MD);
  });

  it('is idempotent — second call on identical content reports "unchanged"', () => {
    ensureBrowserSkill(root);
    const r = ensureBrowserSkill(root);
    expect(r.status).toBe('unchanged');
  });

  it('NEVER clobbers an operator-edited SKILL.md (no `name: browser` frontmatter → kept)', () => {
    const f = skillFile(root);
    mkdirSync(join(root, '.claude', 'skills', BROWSER_SKILL_SLUG), { recursive: true });
    const custom = '---\nname: my-browser\n---\n# My fork\n';
    writeFileSync(f, custom, 'utf8');

    const r = ensureBrowserSkill(root);
    expect(r.status).toBe('kept');
    expect(readFileSync(f, 'utf8')).toBe(custom);
  });

  it('UPGRADES a stale bundled copy in place (frontmatter + tools header → recognised as ours)', () => {
    const f = skillFile(root);
    mkdirSync(join(root, '.claude', 'skills', BROWSER_SKILL_SLUG), { recursive: true });
    // Stale prior bundled copy — same name + section header, different body.
    // Header is intentionally loose ("XX+ tools, grouped") so the regex tolerates
    // numeric drift (we went 30 → 40 once already; we'll go higher).
    const stale = '---\nname: browser\n---\n# Old\n## The 30+ tools, grouped\n- old text only\n';
    writeFileSync(f, stale, 'utf8');

    const r = ensureBrowserSkill(root);
    expect(r.status).toBe('installed');
    expect(readFileSync(f, 'utf8')).toBe(BROWSER_SKILL_MD);
  });

  it('exposes the canonical tools the engine.ts block actually registers', () => {
    // Cheap drift detection: the SKILL.md and engine.ts tool block MUST stay in lock-step
    // so the agent doesn't read a doc that lists a tool that doesn't exist (or vice versa).
    // Update both — this is the warning shot when only one was touched.
    const mustList = [
      'browser_status', 'browser_navigate', 'browser_open_tab', 'browser_list_tabs',
      'browser_close_tab', 'browser_tab_url', 'browser_go_back', 'browser_go_forward',
      'browser_read', 'browser_links', 'browser_snapshot',
      'browser_find_by_role_name', 'browser_match_count', 'browser_screenshot',
      'browser_console_messages', 'browser_network_requests',
      'browser_click', 'browser_click_at', 'browser_type', 'browser_press_key',
      'browser_scroll', 'browser_upload_file', 'browser_hover', 'browser_drag',
      'browser_wait', 'browser_wait_for_selector',
      'browser_evaluate', 'browser_grab_image', 'browser_download_url',
      'browser_cookies_get', 'browser_cookies_set', 'browser_cookies_clear',
      'browser_cdp', 'browser_pdf',
      'browser_window_resize', 'browser_emulate_viewport', 'browser_clear_emulation',
      'browser_session_start', 'browser_session_end',
    ];
    for (const t of mustList) {
      expect(BROWSER_SKILL_MD, `SKILL.md must reference ${t}`).toContain(t);
    }
  });

  it('produces a stable sha256 of the bundled content', () => {
    const a = browserSkillSha256();
    const b = browserSkillSha256();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('survives a non-writable project root by returning "kept" rather than throwing', () => {
    // Point at a bogus path under /dev/null/<gibberish> — mkdirSync will throw,
    // which we catch and report as "kept" so the run never fails on a doc-file write.
    const r = ensureBrowserSkill('/dev/null/does/not/exist');
    expect(r.status).toBe('kept');
  });
});
