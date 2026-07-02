/* Core skills — the operator's PRIVATE, Mac-local skills, forcefully injected.

   Three skill tiers exist in Maestro and this is the third:
   1. Registry skills   → installed into a project's `.claude/skills/` — they get
                          COMMITTED to that project's repo. Public by nature.
   2. Bundled skills    → the browser SKILL.md we ship and auto-install into
                          projects (browser-skill.ts). Also lands in repos.
   3. CORE skills (here)→ live OUTSIDE every git repository at
                          `~/Maestro/.core-skills/<name>/SKILL.md`. Never copied
                          into a project tree, never committed anywhere, and not
                          discoverable via settingSources. Instead the SKILL.md
                          body is injected straight into the prompt whenever the
                          skill's trigger fires — activation is FORCED, not
                          model-optional. This is how superpower content (e.g.
                          the operator's client design DNA) stays private while
                          still steering every matching turn.

   SKILL.md frontmatter:  `when: image` (the only trigger today) picks which
   turns the skill is injected into. Relative `references/…` paths in the body
   are rewritten to absolute paths so the agent can Read them from any worktree
   cwd — the files themselves stay in the core-skills dir. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Injection triggers. 'image' = the turn matched IMAGE_INTENT_RE in engine.ts. */
export type CoreSkillTrigger = 'image';

export const coreSkillsRoot = (): string => path.join(homedir(), 'Maestro', '.core-skills');

interface CoreSkill { name: string; when: CoreSkillTrigger; body: string }
/** mtime-keyed cache so a hot chat doesn't re-read/rewrite the file every turn,
    while operator edits to a SKILL.md are picked up on the very next turn. */
const cache = new Map<string, { mtimeMs: number; skill: CoreSkill }>();

function loadSkill(dir: string, name: string): CoreSkill | undefined {
  const file = path.join(dir, 'SKILL.md');
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return undefined; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.skill;
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return undefined; }
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const when = (fm?.[1].match(/^when:\s*(\S+)/m)?.[1] ?? 'image') as CoreSkillTrigger;
  const body = raw
    .slice(fm?.[0].length ?? 0)
    .replaceAll('references/', path.join(dir, 'references') + path.sep)
    .trim();
  const skill: CoreSkill = { name, when, body };
  cache.set(file, { mtimeMs, skill });
  return skill;
}

/** The prompt block for every core skill registered for `trigger` — '' when none
    exist (fresh Mac, dir absent). Appended to the outgoing prompt by engine.ts,
    NEVER written into the project. The preamble makes application mandatory and
    forbids leaking the content into anything public. */
export function coreSkillDirective(trigger: CoreSkillTrigger, root = coreSkillsRoot()): string {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return ''; /* no core skills on this Mac */ }
  const parts: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue; // .DS_Store etc.
    const skill = loadSkill(path.join(root, name), name);
    if (!skill || skill.when !== trigger || !skill.body) continue;
    parts.push(
      `\n\n---\n\n[Core skill "${skill.name}" — MANDATORY for this task]\n` +
      `Apply the following operator skill to this task. It is PRIVATE: follow its guidance, ` +
      `but NEVER copy its text into project files, commits, code comments, or public artifacts, ` +
      `and do not name or quote it in your reply. Referenced files are absolute Mac-local paths — ` +
      `read them when the skill says to.\n\n${skill.body}`,
    );
  }
  return parts.join('');
}
