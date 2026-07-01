/* Custom MCP server CRUD on the real Store (only app.getPath is mocked). Covers
   add/list/get/update/setEnabled/remove + persistence across a reload. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-mcp-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store custom MCP servers', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('starts empty, then adds + lists with an assigned id and createdAt', () => {
    const s = new Store();
    expect(s.listMcpServers()).toEqual([]);
    const rec = s.addMcpServer({ name: 'fs', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'x'], skillIds: ['anthropics/skills/pdf'] });
    expect(rec.id).toBeTruthy();
    expect(rec.createdAt).toBeGreaterThan(0);
    expect(s.listMcpServers()).toHaveLength(1);
    expect(s.getMcpServer(rec.id)?.command).toBe('npx');
  });

  it('updates fields, toggles enabled, and persists across a reload', () => {
    const s = new Store();
    const rec = s.addMcpServer({ name: 'remote', enabled: true, transport: 'http', url: 'https://a/mcp', skillIds: [] });
    s.updateMcpServer(rec.id, { url: 'https://b/mcp', skillIds: ['anthropics/skills/xlsx'] });
    s.setMcpServerEnabled(rec.id, false);

    const reloaded = new Store();
    const got = reloaded.getMcpServer(rec.id);
    expect(got?.url).toBe('https://b/mcp');
    expect(got?.skillIds).toEqual(['anthropics/skills/xlsx']);
    expect(got?.enabled).toBe(false);
  });

  it('removes a server and returns null when toggling a missing one', () => {
    const s = new Store();
    const rec = s.addMcpServer({ name: 'tmp', enabled: true, transport: 'stdio', command: 'x', skillIds: [] });
    s.removeMcpServer(rec.id);
    expect(s.listMcpServers()).toEqual([]);
    expect(s.setMcpServerEnabled('does-not-exist', true)).toBeNull();
  });
});
