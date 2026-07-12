/* Store.setMcpAccess must default the External MCP port from the channel's
   preferred port (MAESTRO_MCP_PORT), NOT a hardcoded 9235. On a fresh preview/
   development store, the UI "enable External MCP" action would otherwise persist
   the PRODUCTION port 9235, breaking channel isolation. An explicitly-pinned
   port (patch or already-persisted) stays authoritative; malformed/absent env
   falls back to 9235. Uses the real Store (only electron.app is mocked). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-mcpport-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';

const OLD = process.env.MAESTRO_MCP_PORT;

describe('Store.setMcpAccess honors the channel preferred port (MAESTRO_MCP_PORT)', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });
  afterEach(() => { if (OLD === undefined) delete process.env.MAESTRO_MCP_PORT; else process.env.MAESTRO_MCP_PORT = OLD; });

  it('enabling on a fresh preview store persists 9236 (not the production 9235)', () => {
    process.env.MAESTRO_MCP_PORT = '9236';
    const cfg = new Store().setMcpAccess({ enabled: true });
    expect(cfg.port).toBe(9236);
    expect(new Store().mcpAccess()?.port).toBe(9236); // persisted across a reload
  });

  it('enabling on a fresh development store persists 9237', () => {
    process.env.MAESTRO_MCP_PORT = '9237';
    expect(new Store().setMcpAccess({ enabled: true }).port).toBe(9237);
  });

  it('an explicitly-pinned valid port stays authoritative over the env', () => {
    process.env.MAESTRO_MCP_PORT = '9236';
    const s = new Store();
    s.setMcpAccess({ port: 9500 });                         // operator pinned a port (enabled stays false)
    expect(s.setMcpAccess({ enabled: true }).port).toBe(9500); // enabling must NOT clobber the pinned port
  });

  it('malformed / absent MAESTRO_MCP_PORT falls back to 9235', () => {
    for (const bad of ['abc', '', '0', '-1', '70000']) {
      rmSync(hoisted.dir, { recursive: true, force: true });
      process.env.MAESTRO_MCP_PORT = bad;
      expect(new Store().setMcpAccess({ enabled: true }).port, `bad=${JSON.stringify(bad)}`).toBe(9235);
    }
    rmSync(hoisted.dir, { recursive: true, force: true });
    delete process.env.MAESTRO_MCP_PORT;
    expect(new Store().setMcpAccess({ enabled: true }).port).toBe(9235);
  });
});
