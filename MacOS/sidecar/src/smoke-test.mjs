// Standalone smoke test: spawn the sidecar, read its handshake, connect over WS, and exercise
// the P0 dispatch (health + listProjects). Verifies the brain slice + transport end-to-end.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// --bundle: run the esbuild output directly (no loader); else run the TS entry via the dev loader.
const spawnArgs = process.argv.includes('--bundle')
  ? [join(here, '..', 'dist', 'maestro-sidecar.mjs')]
  : ['--import', join(here, 'register.mjs'), join(here, 'headless-main.ts')];
const child = spawn('node', spawnArgs, { stdio: ['ignore', 'pipe', 'inherit'] });

let acc = '';
const timeout = setTimeout(() => { console.error('TIMEOUT waiting for handshake'); child.kill(); process.exit(1); }, 8000);

child.stdout.on('data', async (b) => {
  acc += b.toString();
  const line = acc.split('\n').find((l) => l.includes('"ready"'));
  if (!line) return;
  clearTimeout(timeout);
  const { port, token } = JSON.parse(line);
  console.log(`handshake: port=${port} token=${token.slice(0, 8)}…`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
  const calls = new Map();
  let id = 0;
  const call = (method, params = {}) => new Promise((res) => { const n = ++id; calls.set(n, res); ws.send(JSON.stringify({ t: 'call', id: n, method, params })); });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'res' && calls.has(m.id)) { calls.get(m.id)(m); calls.delete(m.id); }
  });
  ws.addEventListener('error', (e) => { console.error('WS error', e.message ?? e); child.kill(); process.exit(1); });
  ws.addEventListener('open', async () => {
    // Exercise the FULL dispatch across domains — proves the whole engine constructed headless.
    const checks = ['listProjects', 'getSettings', 'listProviders', 'listSkills', 'listMcpServers', 'listSchedules', 'enginesStatus'];
    let allOk = true;
    const results = {};
    for (const m of checks) {
      const r = await call(m);
      results[m] = r.ok;
      if (!r.ok) allOk = false;
      const n = Array.isArray(r.data) ? `[${r.data.length}]` : (r.data && typeof r.data === 'object' ? '{obj}' : JSON.stringify(r.data));
      console.log(`${r.ok ? 'OK ' : 'ERR'} ${m} → ${r.ok ? n : `status=${r.status} "${r.error}"`}`);
    }
    const projects = await call('listProjects');
    const list = projects.data ?? [];
    if (Array.isArray(list) && list.length) {
      console.log('  first project:', JSON.stringify({ id: list[0].id, name: list[0].name, kind: list[0].kind }));
    }
    // Design preview HTTP route.
    const design = (list || []).find((p) => p.kind === 'design');
    if (design) {
      const url = `http://127.0.0.1:${port}/design/${design.id}/design/index.html`;
      const resp = await fetch(url);
      const html = await resp.text();
      const harness = html.includes('__maestroComments');
      const kind = html.includes('Your design will appear here') ? 'placeholder' : 'real-html';
      console.log(`design route → ${resp.status} ${resp.headers.get('content-type')} bytes=${html.length} ${kind} harness=${harness}`);
    }
    // An unknown method must still 404 (dispatch guard intact).
    const bad = await call('totally_not_a_method');
    console.log(`unknown-method guard → ok=${bad.ok} status=${bad.status}`);
    const pass = allOk && !bad.ok;
    ws.close(); child.kill();
    console.log(pass ? '\nFULL SIDECAR SMOKE: PASS' : '\nFULL SIDECAR SMOKE: FAIL');
    process.exit(pass ? 0 : 1);
  });
});
