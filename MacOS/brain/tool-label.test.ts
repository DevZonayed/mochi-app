import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { toolLabel, relPath, scrubInternalMcp } from './tool-label.js';

const CWD = '/Users/me/proj';

describe('relPath', () => {
  it('strips the project cwd to a clean relative path', () => {
    expect(relPath('/Users/me/proj/apps/mobile/src/Foo.tsx', CWD)).toBe('apps/mobile/src/Foo.tsx');
  });
  it('leaves an already-relative path alone', () => {
    expect(relPath('apps/mobile/src/Foo.tsx', CWD)).toBe('apps/mobile/src/Foo.tsx');
  });
  it('collapses a home-dir path outside the project to ~', () => {
    expect(relPath(`${homedir()}/Desktop/notes.md`, CWD)).toBe('~/Desktop/notes.md');
  });
  it('returns the cwd itself unchanged (nothing left to show)', () => {
    expect(relPath(CWD, CWD)).toBe(CWD);
  });
  it('is safe on empty/non-string input', () => {
    expect(relPath('', CWD)).toBe('');
    expect(relPath(undefined as unknown as string, CWD)).toBe('');
  });
});

describe('toolLabel', () => {
  it('Bash → leads with the human description, raw command stays secondary', () => {
    const r = toolLabel('Bash', { command: 'cd /Users/me/proj && find . -name "*.ts"', description: 'Survey repo structure' }, CWD);
    expect(r.text).toBe('Survey repo structure');
    expect(r.cmd).toContain('find . -name');
  });

  it('Bash without a description → first line of the command, no secondary', () => {
    const r = toolLabel('Bash', { command: 'pwd && ls -la\nsecond line' }, CWD);
    expect(r.text).toBe('pwd && ls -la');
    expect(r.cmd).toBeUndefined();
  });

  it('Read → a project-relative path, never the absolute dump', () => {
    const r = toolLabel('Read', { file_path: '/Users/me/proj/apps/server/src/index.ts' }, CWD);
    expect(r.text).toBe('apps/server/src/index.ts');
    expect(r.cmd).toBeUndefined();
  });

  it('Write/Edit → relative path (the renderer turns it into a file chip)', () => {
    expect(toolLabel('Write', { file_path: '/Users/me/proj/a/b.tsx', content: 'x' }, CWD).text).toBe('a/b.tsx');
    expect(toolLabel('Edit', { file_path: '/Users/me/proj/a/b.tsx', old_string: 'a', new_string: 'b' }, CWD).text).toBe('a/b.tsx');
  });

  it('NotebookEdit → the notebook path (notebook_path, not file_path), never the cell source', () => {
    const r = toolLabel('NotebookEdit', { notebook_path: '/Users/me/proj/analysis.ipynb', new_source: 'print("hi")', cell_type: 'code' }, CWD);
    expect(r.text).toBe('analysis.ipynb');
  });

  it('Grep → the pattern plus a relative location', () => {
    const r = toolLabel('Grep', { pattern: 'registerPushToken', path: '/Users/me/proj/apps/server' }, CWD);
    expect(r.text).toBe('registerPushToken in apps/server');
  });

  it('Glob → just the pattern', () => {
    expect(toolLabel('Glob', { pattern: '**/*.test.ts' }, CWD).text).toBe('**/*.test.ts');
  });

  it('Task/subagent → the description of the dispatched work', () => {
    const r = toolLabel('Task', { description: 'Find mobile SessionChat', prompt: 'long prompt…', subagent_type: 'Explore' }, CWD);
    expect(r.text).toBe('Find mobile SessionChat');
  });

  it('Skill → the skill id (the renderer prettifies it)', () => {
    expect(toolLabel('Skill', { command: 'superpowers:brainstorming' }, CWD).text).toBe('superpowers:brainstorming');
  });

  it('WebSearch / WebFetch → the query / url', () => {
    expect(toolLabel('WebSearch', { query: 'adaptive thinking sdk' }, CWD).text).toBe('adaptive thinking sdk');
    expect(toolLabel('WebFetch', { url: 'https://example.com', prompt: 'summarize' }, CWD).text).toBe('https://example.com');
  });

  it('caps very long labels so a row never blows out', () => {
    const long = 'x'.repeat(500);
    const r = toolLabel('Bash', { command: long, description: long }, CWD);
    expect(r.text.length).toBeLessThanOrEqual(141);
    expect(r.text.endsWith('…')).toBe(true);
  });

  it('degrades gracefully on empty / non-object input', () => {
    expect(toolLabel('Bash', null, CWD)).toEqual({ text: '' });
    expect(toolLabel('SomethingNew', { foo: 'bar' }, CWD).text).toBe('bar');
  });

  it('scrubs our in-app MCP plumbing out of any field we surface', () => {
    // Bash description that happens to reference the internal tool name.
    const r1 = toolLabel('Bash', { command: 'echo mcp__maestro__git_status', description: 'Probe mcp__maestro__git_status' }, CWD);
    expect(r1.text).toBe('Probe Git status');
    expect(r1.cmd).toBe('echo Git status');
    // Generic fallback (description path) on a non-Bash tool.
    expect(toolLabel('Task', { description: 'Call mcp__maestro__wa_send_message for confirmation' }, CWD).text)
      .toBe('Call Wa send message for confirmation');
  });

  it('ToolSearch select:<list> renders a clean human-readable tool list (no mcp plumbing)', () => {
    expect(toolLabel('ToolSearch', { query: 'select:mcp__maestro__git_status', max_results: 1 }, CWD).text)
      .toBe('Git status');
    expect(toolLabel('ToolSearch', { query: 'select:mcp__maestro__wa_send_message,mcp__maestro__wa_list_chats' }, CWD).text)
      .toBe('Wa send message, Wa list chats');
  });

  it('ToolSearch keyword query falls through (scrubbed) — no special-case hijack', () => {
    expect(toolLabel('ToolSearch', { query: 'whatsapp send' }, CWD).text).toBe('whatsapp send');
    expect(toolLabel('ToolSearch', { query: 'find mcp__maestro__git_status helpers' }, CWD).text)
      .toBe('find Git status helpers');
  });

  it('THIRD-PARTY mcp namespaces (mcp__github__*, etc.) are left alone — outside integrations stay visible', () => {
    expect(scrubInternalMcp('mcp__github__create_issue')).toBe('mcp__github__create_issue');
    expect(scrubInternalMcp('mcp__filesystem__read_file')).toBe('mcp__filesystem__read_file');
  });
});

describe('scrubInternalMcp', () => {
  it('replaces a bare `mcp__maestro__<tool>` with a prettified label', () => {
    expect(scrubInternalMcp('mcp__maestro__git_status')).toBe('Git status');
    expect(scrubInternalMcp('mcp__maestro__wa_send_message')).toBe('Wa send message');
    expect(scrubInternalMcp('mcp__maestro__browser_click_at')).toBe('Browser click at');
  });
  it('replaces multiple occurrences inside one string', () => {
    expect(scrubInternalMcp('first mcp__maestro__pr_create then mcp__maestro__git_push'))
      .toBe('first Pr create then Git push');
  });
  it('is safe on empty / non-string input', () => {
    expect(scrubInternalMcp('')).toBe('');
    expect(scrubInternalMcp(undefined as unknown as string)).toBe(undefined as unknown as string);
  });
  it('does NOT touch third-party MCP servers (operator wants outside integrations visible)', () => {
    expect(scrubInternalMcp('mcp__github__create_issue')).toBe('mcp__github__create_issue');
  });
});
