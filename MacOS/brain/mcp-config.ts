/* Pure mapping: operator-configured custom MCP servers → the per-engine config a
   run needs. NO electron/fs deps so it is unit-testable in isolation. Secrets are
   referenced by env-var NAME on the server record and resolved from the passed
   `env` map here (at build time, just before the engine spawns) — never persisted. */

import type { CustomMcpServer, McpKv } from './store.js';

/** Claude Agent SDK external-server config shapes (subset we emit). Matches the
    SDK's McpStdioServerConfig / McpHttpServerConfig (type optional for stdio;
    `cwd` is a standard stdio-MCP field the CLI honors even though the SDK type
    doesn't surface it — emitted best-effort). */
export type ClaudeStdioConfig = { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string };
export type ClaudeHttpConfig = { type: 'http'; url: string; headers: Record<string, string> };
export type ClaudeMcpConfig = ClaudeStdioConfig | ClaudeHttpConfig;

type Env = Record<string, string | undefined>;

/** MCP server names become tool prefixes (`mcp__<name>__<tool>`), so keep them to
    a safe charset and never collide with Maestro's own in-process `maestro` server. */
export function sanitizeMcpName(name: string, fallback = 'server'): string {
  const cleaned = (name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback;
  return cleaned === 'maestro' ? 'maestro-custom' : cleaned;
}

const isValid = (s: CustomMcpServer): boolean =>
  s.transport === 'stdio' ? (s.command || '').trim() !== '' : (s.url || '').trim() !== '';

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

/** Resolve the in-run tool-namespace name for each ATTACHABLE server (enabled +
    valid), applying the same sanitize + collision-dedup the engine config uses, so
    the config and the agent-facing prompt note can never drift. `stdioOnly` matches
    Codex (which has no streamable-HTTP server form). Order is preserved. */
export function assignMcpNames(servers: CustomMcpServer[], opts: { stdioOnly?: boolean } = {}): { server: CustomMcpServer; name: string }[] {
  const out: { server: CustomMcpServer; name: string }[] = [];
  const used = new Set<string>(['maestro']);
  for (const s of servers) {
    if (!s.enabled || !isValid(s)) continue;
    if (opts.stdioOnly && s.transport !== 'stdio') continue;
    out.push({ server: s, name: uniqueName(sanitizeMcpName(s.name), used) });
  }
  return out;
}

const kvToRecord = (kv?: McpKv[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of kv ?? []) { const k = (key ?? '').trim(); if (k) out[k] = value ?? ''; }
  return out;
};

const cleanArgs = (args?: string[]): string[] => (args ?? []).filter(a => typeof a === 'string' && a !== '');

function stdioEnv(s: CustomMcpServer, env: Env): Record<string, string> {
  const envRec = kvToRecord(s.env);
  for (const name of s.envPassthrough ?? []) {
    const k = (name ?? '').trim();
    if (k && env[k] !== undefined) envRec[k] = env[k] as string;
  }
  return envRec;
}

/** Resolve one (already-validated) server to a Claude SDK config. */
function claudeConfigFor(s: CustomMcpServer, env: Env): ClaudeMcpConfig {
  if (s.transport === 'stdio') {
    const cfg: ClaudeStdioConfig = { type: 'stdio', command: (s.command || '').trim(), args: cleanArgs(s.args), env: stdioEnv(s, env) };
    const cwd = (s.cwd || '').trim();
    if (cwd) cfg.cwd = cwd;
    return cfg;
  }
  const headers = kvToRecord(s.headers);
  for (const h of s.headerEnv ?? []) {
    const k = (h.key ?? '').trim();
    const v = env[(h.valueEnv ?? '').trim()];
    if (k && v !== undefined) headers[k] = v;
  }
  const bearerName = (s.bearerTokenEnv || '').trim();
  const hasAuth = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
  if (bearerName && env[bearerName] !== undefined && !hasAuth) headers['Authorization'] = `Bearer ${env[bearerName] as string}`;
  return { type: 'http', url: (s.url || '').trim(), headers };
}

/** Build Claude's `mcpServers` record + the `mcp__<name>__*` allowedTools list for
    a set of servers. Disabled and invalid servers are skipped; name collisions
    (incl. the reserved `maestro`) are de-duplicated by suffixing. */
export function buildClaudeCustomMcp(
  servers: CustomMcpServer[],
  env: Env = {},
): { servers: Record<string, ClaudeMcpConfig>; allowedTools: string[]; skipped: { name: string; reason: string }[] } {
  const out: Record<string, ClaudeMcpConfig> = {};
  const allowedTools: string[] = [];
  for (const { server, name } of assignMcpNames(servers)) {
    out[name] = claudeConfigFor(server, env);
    allowedTools.push(`mcp__${name}__*`);
  }
  const attachedIds = new Set(assignMcpNames(servers).map(a => a.server.id));
  const skipped = servers
    .filter(s => s.enabled && !attachedIds.has(s.id))
    .map(s => ({ name: s.name, reason: s.transport === 'stdio' ? 'missing command' : 'missing url' }));
  return { servers: out, allowedTools, skipped };
}

/** TOML basic-string escape: backslash, quote, and control chars (newline/CR/tab),
    so a value with any of these stays valid TOML instead of breaking the whole
    `-c` invocation (which would fail the entire codex run, not just one server). */
const tomlStr = (s: string) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';

function codexToml(name: string, command: string, args: string[], env: Record<string, string>): string {
  const argsToml = `[${args.map(tomlStr).join(', ')}]`;
  const envEntries = Object.entries(env);
  const envToml = envEntries.length ? `, env = { ${envEntries.map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')} }` : '';
  return `mcp_servers.${name}={ command = ${tomlStr(command)}, args = ${argsToml}${envToml} }`;
}

/** Build Codex `-c mcp_servers.<name>={…}` TOML fragments (stdio only — Codex's
    config has no streamable-HTTP server form here, so HTTP servers are reported as
    skipped and run on Claude only). `cwd` is intentionally NOT emitted: an unknown
    key would fail the whole codex run, so a working directory applies on Claude only. */
export function buildCodexCustomMcp(
  servers: CustomMcpServer[],
  env: Env = {},
): { fragments: string[]; httpSkipped: string[] } {
  const fragments = assignMcpNames(servers, { stdioOnly: true })
    .map(({ server, name }) => codexToml(name, (server.command || '').trim(), cleanArgs(server.args), stdioEnv(server, env)));
  const httpSkipped = servers.filter(s => s.enabled && s.transport !== 'stdio').map(s => s.name);
  return { fragments, httpSkipped };
}

/** The union of skill ids attached to the enabled servers — the skills to ensure
    installed + surface to the agent because their server is active this run. */
export function activeServerSkillIds(servers: CustomMcpServer[]): string[] {
  const ids = new Set<string>();
  for (const s of servers) if (s.enabled) for (const id of s.skillIds ?? []) { const t = (id ?? '').trim(); if (t) ids.add(t); }
  return [...ids];
}
