import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';

import {
  handleJsonRpc, listTools, toolAllowed, normalizeSettings, defaultExternalMcpSettings,
  ExternalMcp, type ExternalMcpSettings, type ExternalMcpStore, type Dispatch,
} from './external-mcp.ts';
import { MCP_TOOLS, MCP_TOOL_BY_METHOD, MCP_CATEGORIES, categoryCounts } from './manifest.ts';
import { isRemoteBlocked } from '../remote-guard.ts';

const on = (extra: Partial<ExternalMcpSettings> = {}): ExternalMcpSettings =>
  normalizeSettings({ ...defaultExternalMcpSettings(), enabled: true, ...extra });

describe('manifest integrity', () => {
  it('every tool has a known category and a non-empty description', () => {
    const catIds = new Set(MCP_CATEGORIES.map((c) => c.id));
    for (const t of MCP_TOOLS) {
      expect(catIds.has(t.category), `${t.method} → ${t.category}`).toBe(true);
      expect(t.description.length).toBeGreaterThan(3);
    }
  });
  it('tool method names are unique', () => {
    const names = MCP_TOOLS.map((t) => t.method);
    expect(new Set(names).size).toBe(names.length);
  });
  it('destructive tools are labelled in their description', () => {
    for (const t of MCP_TOOLS.filter((t) => t.destructive)) {
      expect(t.description).toContain('(DESTRUCTIVE)');
    }
  });
  it('does NOT expose the external-MCP control methods as tools (agent cannot unlock itself)', () => {
    for (const m of ['mcpAccessConfig', 'setMcpAccess', 'rotateMcpToken']) {
      expect(MCP_TOOL_BY_METHOD.has(m)).toBe(false);
    }
  });
  it('categoryCounts totals match the flat tool list', () => {
    const sum = categoryCounts().reduce((n, c) => n + c.total, 0);
    expect(sum).toBe(MCP_TOOLS.length);
  });
});

describe('tools/list gating', () => {
  it('returns nothing when disabled', () => {
    expect(listTools(normalizeSettings({ enabled: false }))).toEqual([]);
  });
  it('hides destructive tools unless allowDestructive', () => {
    const guarded = listTools(on({ allowDestructive: false })).map((t) => t.name);
    expect(guarded).not.toContain('deleteProject');
    expect(guarded).not.toContain('runCommand');
    expect(guarded).toContain('listProjects');
    const open = listTools(on({ allowDestructive: true })).map((t) => t.name);
    expect(open).toContain('deleteProject');
    expect(open).toContain('runCommand');
  });
  it('hides a category when it is toggled off', () => {
    const s = on({ categories: { ...defaultExternalMcpSettings().categories, whatsapp: false } });
    const names = listTools(s).map((t) => t.name);
    expect(names).not.toContain('waListChats');
    expect(names).toContain('listProjects');
  });
  it('toolAllowed respects the manifest default for an unspecified category', () => {
    const t = MCP_TOOLS.find((x) => x.category === 'system' && !x.destructive)!;
    expect(toolAllowed(t, on({ categories: {} }))).toBe(true);
  });
});

describe('handleJsonRpc', () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const dispatch: Dispatch = async (method, params) => {
    calls.push({ method, params });
    if (method === 'boom') throw new Error('kaboom');
    return { echoed: method, params };
  };
  beforeEach(() => { calls.length = 0; });

  it('initialize advertises tools capability', async () => {
    const r = await handleJsonRpc({ id: 1, method: 'initialize', params: {} }, { dispatch, settings: on() });
    expect(r?.result).toMatchObject({ serverInfo: { name: 'mochi' }, capabilities: { tools: {} } });
  });
  it('notifications get no reply', async () => {
    const r = await handleJsonRpc({ method: 'notifications/initialized' }, { dispatch, settings: on() });
    expect(r).toBeNull();
  });
  it('tools/call routes to dispatch and wraps the result', async () => {
    const r = await handleJsonRpc(
      { id: 2, method: 'tools/call', params: { name: 'listProjects', arguments: { a: 1 } } },
      { dispatch, settings: on() },
    );
    expect(calls).toEqual([{ method: 'listProjects', params: { a: 1 } }]);
    const res = r?.result as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('listProjects');
  });
  it('refuses a destructive tool when not allowed (no dispatch)', async () => {
    const r = await handleJsonRpc(
      { id: 3, method: 'tools/call', params: { name: 'deleteProject', arguments: {} } },
      { dispatch, settings: on({ allowDestructive: false }) },
    );
    const res = r?.result as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/destructive/i);
    expect(calls).toHaveLength(0);
  });
  it('refuses a tool in a disabled category', async () => {
    const r = await handleJsonRpc(
      { id: 4, method: 'tools/call', params: { name: 'waListChats', arguments: {} } },
      { dispatch, settings: on({ categories: { whatsapp: false } }) },
    );
    expect((r?.result as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('unknown tool errors without dispatch', async () => {
    const r = await handleJsonRpc(
      { id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
      { dispatch, settings: on() },
    );
    expect((r?.result as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('surfaces a dispatch throw as an MCP tool error (not a protocol error)', async () => {
    const s = on({ allowDestructive: true });
    // Map a real tool onto the throwing dispatch: use listProjects but make dispatch throw.
    const throwing: Dispatch = async () => { throw new Error('kaboom'); };
    const r = await handleJsonRpc(
      { id: 6, method: 'tools/call', params: { name: 'listProjects', arguments: {} } },
      { dispatch: throwing, settings: s },
    );
    const res = r?.result as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('kaboom');
  });
  it('unknown non-tool method → JSON-RPC method-not-found', async () => {
    const r = await handleJsonRpc({ id: 7, method: 'frobnicate' }, { dispatch, settings: on() });
    expect(r?.error?.code).toBe(-32601);
  });
});

describe('remote guard', () => {
  it('blocks the external-MCP control methods from the relay', () => {
    expect(isRemoteBlocked('mcpAccessConfig')).toBe(true);
    expect(isRemoteBlocked('setMcpAccess')).toBe(true);
    expect(isRemoteBlocked('rotateMcpToken')).toBe(true);
  });
});

describe('ExternalMcp HTTP transport', () => {
  let tmp: string;
  let mcp: ExternalMcp;
  let settings: ExternalMcpSettings;
  const token = 'test-token-abc';
  const dispatched: string[] = [];

  const store: ExternalMcpStore = {
    mcpAccess: () => settings,
    setMcpAccess: (patch) => { settings = { ...settings, ...patch }; return settings; },
    mcpToken: () => token,
    rotateMcpToken: () => token,
  };
  const dispatch: Dispatch = async (method) => { dispatched.push(method); return { ok: method }; };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'mochi-mcp-'));
    settings = on({ port: 0 }); // ephemeral loopback port
    dispatched.length = 0;
    mcp = new ExternalMcp({ store, dispatch, shimPath: path.join(tmp, 'shim.cjs'), nodePath: '/usr/bin/node' });
    mcp.start();
  });
  afterEach(() => { mcp.stop(); rmSync(tmp, { recursive: true, force: true }); });

  const url = () => mcp.config().endpoints.httpUrl;
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('writes the stdio shim to disk', () => {
    expect(existsSync(path.join(tmp, 'shim.cjs'))).toBe(true);
    expect(readFileSync(path.join(tmp, 'shim.cjs'), 'utf8')).toContain('MOCHI_MCP_TOKEN');
  });
  it('rejects unauthenticated requests', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });
  it('serves tools/list with a valid Bearer token', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.some((t) => t.name === 'listProjects')).toBe(true);
  });
  it('runs a tools/call end to end through dispatch', async () => {
    const res = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'listProjects', arguments: {} } },
      { authorization: `Bearer ${token}` },
    );
    const body = await res.json() as { result: { content: { text: string }[] } };
    expect(dispatched).toContain('listProjects');
    expect(body.result.content[0].text).toContain('listProjects');
  });
  it('config() reports a running server and a positive tool count', () => {
    const cfg = mcp.config();
    expect(cfg.running).toBe(true);
    expect(cfg.port).toBeGreaterThan(0);
    expect(cfg.toolCount).toBeGreaterThan(50);
    expect(cfg.clientJson.stdio).toBeTruthy();
  });
  it('stops serving once disabled + re-applied', async () => {
    settings = { ...settings, enabled: false };
    mcp.apply();
    await expect(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${token}` }))
      .rejects.toThrow();
  });
});
