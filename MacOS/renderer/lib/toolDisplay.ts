import type { IconName } from './icons';

/** True when the agent invoked a Skill (rendered with a distinct purple glyph). */
export const isSkillTool = (name?: string): boolean => (name ?? '').toLowerCase() === 'skill';

/** Skill ids arrive as "superpowers:brainstorming" / "mochi:checkpoint" — show the
    human end ("Brainstorming", "Checkpoint"). */
export const prettySkillName = (raw: string): string => {
  const tail = (raw.split(':').pop() ?? raw).replace(/[-_]/g, ' ').trim();
  return tail ? tail.replace(/\b\w/g, c => c.toUpperCase()) : raw;
};

/** Scrub `mcp__maestro__<tool>` references from a free-form string and replace
    them with a human-readable label ("Git status", "Wa send message"). Our
    own in-app MCP server is part of the product — leaking
    `mcp__maestro__git_status` into the transcript makes it read like Swagger
    plumbing instead of a native superpower. THIRD-PARTY MCP namespaces
    (`mcp__github__*`, `mcp__filesystem__*`) are intentionally untouched so
    real outside integrations stay visible. Mirrors the electron-side helper
    in `electron/tool-label.ts` (kept as a 4-line duplicate to avoid a
    cross-realm import). Use this on `item.text`/`item.cmd` in the renderer
    so historical transcripts get cleaned at display time too — without
    requiring a data migration. */
export const scrubInternalMcp = (s: string): string => {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/mcp__maestro__([A-Za-z0-9_]+)/g, (_m, raw: string) => {
    const pretty = raw.replace(/[_-]+/g, ' ').trim();
    return pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : raw;
  });
};

/** A short, friendly identity for a tool — a recognizable verb + glyph + tint — so a
    row reads "Read SessionChat.tsx" instead of "mcp__maestro__read_file /Users/…".
    `file:true` means the detail is a path → render it as a filename chip (basename). */
export const toolDisplay = (name: string): { short: string; icon: IconName; tint: string; file?: boolean; mono?: boolean } => {
  const raw = (name || '').replace(/^mcp__[^_]+__/, '');
  const n = raw.toLowerCase();
  if (/multiedit|multi_edit|^edit|apply_patch|str_replace/.test(n)) return { short: 'Edit', icon: 'pencil', tint: 'var(--teal)', file: true };
  if (/^write|create_file|^notebook/.test(n)) return { short: 'Write', icon: 'file', tint: 'var(--teal)', file: true };
  if (/^read|^view|^cat|open_file/.test(n)) return { short: 'Read', icon: 'file', tint: 'var(--teal)', file: true };
  if (/grep|^search$|ripgrep/.test(n)) return { short: 'Search', icon: 'search', tint: 'var(--teal)' };
  if (/glob|^ls$|list_dir|list_files|^find/.test(n)) return { short: 'Find', icon: 'search', tint: 'var(--teal)' };
  if (/websearch|web_search/.test(n)) return { short: 'Web search', icon: 'telescope', tint: 'var(--indigo)' };
  if (/webfetch|web_fetch|^fetch|^http/.test(n)) return { short: 'Fetch', icon: 'globe', tint: 'var(--indigo)' };
  if (/browser|navigate|snapshot|playwright/.test(n)) return { short: 'Browser', icon: 'globe', tint: 'var(--indigo)' };
  if (/image|photo|picture|generate_image/.test(n)) return { short: 'Image', icon: 'image', tint: 'var(--purple)' };
  if (/todo/.test(n)) return { short: 'Plan', icon: 'checkCircle', tint: 'var(--blue)' };
  if (/task|subagent|^agent|dispatch/.test(n)) return { short: 'Agent', icon: 'spark', tint: 'var(--purple)' };
  if (/bash|shell|^run|exec|terminal|command/.test(n)) return { short: 'Run', icon: 'terminal', tint: 'var(--blue)', mono: true };
  const pretty = raw.replace(/[_-]+/g, ' ').trim();
  return { short: pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : 'Tool', icon: 'command', tint: 'var(--ink-secondary)' };
};
