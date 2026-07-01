/* Human-readable labels for tool invocations in the chat transcript.
 *
 * The old transcript showed each tool as a raw monospace dump — `cd /Users/me/…`,
 * `/bin/ls -la /Users/me/Maestro/worktrees/…` — which read like a Swagger/API log.
 * These helpers lead with the model's INTENT instead: the Bash `description`, a
 * project-relative file path, a search pattern. The raw command is kept as a small
 * secondary detail (`cmd`) so it stays one glance away without dominating the row.
 *
 * Kept in a dependency-free module so it's pure and unit-testable.
 */
import { homedir } from 'node:os';

/** Scrub `mcp__maestro__<tool>` references inside a free-form string and replace
    them with a human-readable label (e.g. `mcp__maestro__git_status` → `Git
    status`, `mcp__maestro__wa_send_message` → `Wa send message`). Our in-app
    MCP is part of the product — surfacing the `mcp__maestro__*` plumbing in
    the chat transcript ("ToolSearch select:mcp__maestro__git_status") makes it
    read like a Swagger dump instead of a native superpower. THIRD-PARTY MCP
    servers (e.g. `mcp__github__*`, `mcp__filesystem__*`) are intentionally
    left alone — those ARE outside integrations and the operator wants to see
    them. Pure & dependency-free so the renderer can duplicate it without
    pulling electron-only deps. */
export function scrubInternalMcp(s: string): string {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/mcp__maestro__([A-Za-z0-9_]+)/g, (_m, raw: string) => {
    const pretty = raw.replace(/[_-]+/g, ' ').trim();
    return pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : raw;
  });
}

/** Strip the project cwd (and otherwise the home dir) from an absolute path so a
    chip reads `apps/mobile/src/screens/Foo.tsx`, not the full
    `/Users/me/…/apps/mobile/…` dump. Already-relative paths pass through. */
export function relPath(p: string, cwd: string): string {
  if (typeof p !== 'string' || !p) return '';
  let s = p;
  if (cwd && s.startsWith(cwd)) { const rest = s.slice(cwd.length).replace(/^[/\\]+/, ''); if (rest) s = rest; }
  if (s === p) { const home = homedir(); if (home && s.startsWith(home)) s = '~' + s.slice(home.length); }
  return s;
}

/** Human-readable label (+ optional secondary detail) for a tool invocation. Leads
    with the model's INTENT — the Bash `description`, a relative file path, a search
    pattern — instead of a raw absolute path or shell dump. `cmd` carries the raw
    command behind a Bash description. */
export function toolLabel(name: string, input: unknown, cwd: string): { text: string; cmd?: string } {
  const i = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const n = (name || '').toLowerCase();
  const cap = (s: string, len = 140): string => { const t = s.trim(); return t.length > len ? t.slice(0, len).trimEnd() + '…' : t; };
  const firstLine = (s: string): string => s.split('\n')[0].trim();
  // ToolSearch (deferred-tool loader) — its `query` is the part most likely to leak
  // raw `mcp__maestro__*` plumbing into the transcript ("select:mcp__maestro__git_status"
  // reads like a Swagger dump). Special-case the `select:` form to render a clean
  // human-readable list of tool names instead. Falls through for keyword queries.
  if (/toolsearch|tool_search/.test(n) && str('query')) {
    const q = str('query').trim();
    if (q.toLowerCase().startsWith('select:')) {
      const names = q
        .slice('select:'.length)
        .split(',')
        .map(t => scrubInternalMcp(t.trim()))
        .filter(Boolean);
      if (names.length) return { text: cap(names.join(', ')) };
    }
    return { text: cap(scrubInternalMcp(q)) };
  }
  // Bash / shell — lead with the human description; keep the raw command as secondary.
  if (/bash|shell|exec|terminal|run_in_background|^run$/.test(n) && (str('command') || str('description'))) {
    const desc = str('description').trim();
    const command = str('command').trim();
    if (desc) return command ? { text: cap(scrubInternalMcp(desc)), cmd: cap(scrubInternalMcp(command), 220) } : { text: cap(scrubInternalMcp(desc)) };
    return { text: cap(scrubInternalMcp(firstLine(command)), 220) };
  }
  // File tools (read/write/edit/notebook) — a clean relative path. NotebookEdit uses
  // `notebook_path`, not `file_path`, so check both (else the label falls through to a
  // random string field like the cell source and renders as a bogus "filename").
  const fp = str('file_path') || str('notebook_path');
  if (fp) return { text: relPath(fp, cwd) };
  // Search — the pattern (+ where), not raw grep/glob flags.
  if (/grep|search/.test(n) && str('pattern')) {
    const where = str('path') ? ` in ${relPath(str('path'), cwd)}` : '';
    return { text: cap(scrubInternalMcp(str('pattern') + where)) };
  }
  if (/glob/.test(n) && str('pattern')) return { text: cap(scrubInternalMcp(str('pattern'))) };
  // Task / subagent — what the agent was asked to do.
  if (str('description')) return { text: cap(scrubInternalMcp(str('description'))) };
  // Skills, web, MCP and the rest — the first meaningful string field.
  for (const k of ['skill', 'query', 'url', 'prompt', 'path', 'name', 'pattern', 'command']) {
    if (str(k)) return { text: cap(k === 'path' ? relPath(str(k), cwd) : scrubInternalMcp(str(k))) };
  }
  const first = Object.values(i).find(v => typeof v === 'string' && v) as string | undefined;
  return { text: first ? cap(scrubInternalMcp(first)) : '' };
}
