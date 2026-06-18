/* Pure mapping of custom MCP servers → per-engine config. No electron/fs, so this
   runs against the production functions directly (type-only Store import is erased). */
import { describe, it, expect } from 'vitest';
import { buildClaudeCustomMcp, buildCodexCustomMcp, activeServerSkillIds, sanitizeMcpName } from './mcp-config.js';
import type { CustomMcpServer } from './store.js';

const srv = (over: Partial<CustomMcpServer>): CustomMcpServer => ({
  id: over.id ?? 'id-' + (over.name ?? 'x'),
  name: over.name ?? 'Server',
  enabled: over.enabled ?? true,
  transport: over.transport ?? 'stdio',
  skillIds: over.skillIds ?? [],
  createdAt: 0,
  ...over,
});

describe('sanitizeMcpName', () => {
  it('lowercases and replaces unsafe chars with hyphens', () => {
    expect(sanitizeMcpName('My Cool Server!')).toBe('my-cool-server');
    expect(sanitizeMcpName('GitHub_MCP')).toBe('github_mcp');
  });
  it('falls back when empty and avoids colliding with the reserved maestro name', () => {
    expect(sanitizeMcpName('')).toBe('server');
    expect(sanitizeMcpName('!!!')).toBe('server');
    expect(sanitizeMcpName('Maestro')).toBe('maestro-custom');
  });
});

describe('buildClaudeCustomMcp', () => {
  it('maps a stdio server to an SDK stdio config + a wildcard allowedTool', () => {
    const { servers, allowedTools } = buildClaudeCustomMcp([
      srv({ name: 'sqlite', command: 'openai-dev-mcp', args: ['serve-sqlite', ''], env: [{ key: 'A', value: '1' }] }),
    ]);
    expect(servers['sqlite']).toEqual({ type: 'stdio', command: 'openai-dev-mcp', args: ['serve-sqlite'], env: { A: '1' } });
    expect(allowedTools).toEqual(['mcp__sqlite__*']);
  });

  it('maps an http server, resolving the bearer-token env var by NAME', () => {
    const { servers } = buildClaudeCustomMcp(
      [srv({ name: 'remote', transport: 'http', url: 'https://x/mcp', bearerTokenEnv: 'TOK', headers: [{ key: 'X-A', value: 'b' }] })],
      { TOK: 'secret-123' },
    );
    expect(servers['remote']).toEqual({ type: 'http', url: 'https://x/mcp', headers: { 'X-A': 'b', Authorization: 'Bearer secret-123' } });
  });

  it('resolves env passthrough + header-from-env by name, omitting unset names', () => {
    const claude = buildClaudeCustomMcp(
      [srv({ name: 'a', command: 'run', envPassthrough: ['HOME', 'MISSING'] })],
      { HOME: '/Users/me' },
    );
    expect(claude.servers['a']).toMatchObject({ env: { HOME: '/Users/me' } });

    const http = buildClaudeCustomMcp(
      [srv({ name: 'h', transport: 'http', url: 'https://x', headerEnv: [{ key: 'Authorization', valueEnv: 'AUTH' }] })],
      { AUTH: 'Bearer zzz' },
    );
    // Explicit header-from-env wins, so bearer is not double-added.
    expect(http.servers['h']).toEqual({ type: 'http', url: 'https://x', headers: { Authorization: 'Bearer zzz' } });
  });

  it('skips disabled servers and invalid ones (no command / no url)', () => {
    const r = buildClaudeCustomMcp([
      srv({ name: 'off', command: 'x', enabled: false }),
      srv({ name: 'nocmd', command: '' }),
      srv({ name: 'nourl', transport: 'http', url: '' }),
      srv({ name: 'ok', command: 'y' }),
    ]);
    expect(Object.keys(r.servers)).toEqual(['ok']);
    expect(r.skipped.map(s => s.name).sort()).toEqual(['nocmd', 'nourl']);
  });

  it('emits cwd for a stdio server when set (best-effort stdio field)', () => {
    const { servers } = buildClaudeCustomMcp([srv({ name: 'a', command: 'run', cwd: '~/code' })]);
    expect(servers['a']).toEqual({ type: 'stdio', command: 'run', args: [], env: {}, cwd: '~/code' });
    const { servers: noCwd } = buildClaudeCustomMcp([srv({ name: 'b', command: 'run' })]);
    expect('cwd' in noCwd['b']).toBe(false);
  });

  it('de-duplicates names, including against the reserved maestro server', () => {
    const r = buildClaudeCustomMcp([
      srv({ id: '1', name: 'dup', command: 'a' }),
      srv({ id: '2', name: 'dup', command: 'b' }),
      srv({ id: '3', name: 'Maestro', command: 'c' }),
    ]);
    expect(Object.keys(r.servers).sort()).toEqual(['dup', 'dup-2', 'maestro-custom']);
  });
});

describe('buildCodexCustomMcp', () => {
  it('emits a TOML fragment per stdio server and skips http servers', () => {
    const { fragments, httpSkipped } = buildCodexCustomMcp([
      srv({ name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: [{ key: 'K', value: 'v' }] }),
      srv({ name: 'remote', transport: 'http', url: 'https://x' }),
    ]);
    expect(fragments).toEqual(['mcp_servers.fs={ command = "npx", args = ["-y", "server-fs"], env = { "K" = "v" } }']);
    expect(httpSkipped).toEqual(['remote']);
  });

  it('escapes quotes/backslashes in command + args and omits env when empty', () => {
    const { fragments } = buildCodexCustomMcp([srv({ name: 's', command: 'a"b', args: ['c\\d'] })]);
    expect(fragments[0]).toBe('mcp_servers.s={ command = "a\\"b", args = ["c\\\\d"] }');
  });

  it('escapes newlines so a multiline value stays valid TOML (never breaks the run)', () => {
    const { fragments } = buildCodexCustomMcp([srv({ name: 's', command: 'run', env: [{ key: 'K', value: 'a\nb' }] })]);
    expect(fragments[0]).toBe('mcp_servers.s={ command = "run", args = [], env = { "K" = "a\\nb" } }');
    expect(fragments[0]).not.toContain('\n');
  });

  it('does not emit cwd (unknown key would fail the whole codex run)', () => {
    const { fragments } = buildCodexCustomMcp([srv({ name: 's', command: 'run', cwd: '/tmp' })]);
    expect(fragments[0]).not.toContain('cwd');
  });

  it('skips disabled + command-less servers', () => {
    const { fragments } = buildCodexCustomMcp([
      srv({ name: 'off', command: 'x', enabled: false }),
      srv({ name: 'nocmd', command: '' }),
      srv({ name: 'ok', command: 'y' }),
    ]);
    expect(fragments).toEqual(['mcp_servers.ok={ command = "y", args = [] }']);
  });
});

describe('activeServerSkillIds', () => {
  it('unions skill ids across enabled servers, de-duped and trimmed', () => {
    const ids = activeServerSkillIds([
      srv({ name: 'a', command: 'x', skillIds: ['anthropics/skills/pdf', ' anthropics/skills/xlsx '] }),
      srv({ name: 'b', command: 'y', skillIds: ['anthropics/skills/pdf'] }),
      srv({ name: 'off', command: 'z', enabled: false, skillIds: ['anthropics/skills/secret'] }),
    ]);
    expect(ids.sort()).toEqual(['anthropics/skills/pdf', 'anthropics/skills/xlsx']);
  });
});
