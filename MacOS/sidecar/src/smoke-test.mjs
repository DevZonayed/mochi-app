// Standalone smoke test: spawn the sidecar, read its handshake, connect over WS, and exercise
// the P0 dispatch (health + listProjects). Verifies the brain slice + transport end-to-end.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

/**
 * Resolve WHAT to spawn (pure — no side effects, so it's unit-testable).
 *   --app <path>  → the EXACT packaged app: its embedded node
 *                   <app>/Contents/Resources/sidecar/bin/node running
 *                   <app>/Contents/Resources/sidecar/maestro-sidecar.mjs.
 *   --bundle      → the esbuild dist bundle via ambient node.
 *   (default)     → the TS entry via the dev loader.
 * @param {string[]} argv  process.argv (or a test double)
 * @param {string}   here  the sidecar/src dir
 * @param {string}   cwd   working dir for resolving a relative --app path
 * @returns {{ mode: 'app'|'bundle'|'source', node: string, args: string[] }}
 */
export function resolveSmokeTarget(argv, here, cwd = process.cwd()) {
  const appIdx = argv.indexOf('--app');
  if (appIdx !== -1) {
    const appPath = argv[appIdx + 1];
    if (!appPath || appPath.startsWith('--')) throw new Error('--app requires a path to a .app bundle');
    const sidecar = join(resolvePath(cwd, appPath), 'Contents', 'Resources', 'sidecar');
    return { mode: 'app', node: join(sidecar, 'bin', 'node'), args: [join(sidecar, 'maestro-sidecar.mjs')] };
  }
  if (argv.includes('--bundle')) {
    return { mode: 'bundle', node: 'node', args: [join(here, '..', 'dist', 'maestro-sidecar.mjs')] };
  }
  return { mode: 'source', node: 'node', args: ['--import', join(here, 'register.mjs'), join(here, 'headless-main.ts')] };
}

const here = dirname(fileURLToPath(import.meta.url));

// Only run the smoke when invoked directly (`node smoke-test.mjs`), so importing
// this module for the pure resolver above never spawns a sidecar.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runSmoke();

function runSmoke() {
  const target = resolveSmokeTarget(process.argv, here);
  console.log(`smoke target: ${target.mode} → ${target.node}`);
  // The caller's MAESTRO_USER_DATA_DIR stays authoritative — inherit env verbatim
  // so an exact-app smoke can be fully isolated by the caller's temp userData.
  const child = spawn(target.node, target.args, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });

  let acc = '';
  const timeout = setTimeout(() => { console.error('TIMEOUT waiting for handshake'); child.kill(); process.exit(1); }, 8000);

  child.stdout.on('data', async (b) => {
    acc += b.toString();
    const line = acc.split('\n').find((l) => l.includes('"ready"'));
    if (!line) return;
    clearTimeout(timeout);
    const { port, token } = JSON.parse(line);
    // Never print token material — only that a token was received.
    console.log(`handshake: port=${port} (token received)`);

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
      for (const m of checks) {
        const r = await call(m);
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
}
