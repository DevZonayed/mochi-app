import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('../../../', import.meta.url).pathname);
const tmp = mkdtempSync(path.join(tmpdir(), 'maestro-server-docker-context-'));

const copy = (from, to = from) => {
  const src = path.join(root, from);
  const dst = path.join(tmp, to);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
};

try {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) copy(f);
  copy('apps/server/package.json');
  copy('apps/server/tsconfig.json');
  copy('apps/server/src');
  copy('apps/server/registry');
  copy('apps/server/Dockerfile');
  copy('apps/server/Dockerfile.dockerignore');
  copy('packages/realtime/package.json');
  copy('packages/realtime/index.ts');
  copy('packages/realtime/src');
  writeFileSync(path.join(tmp, 'HOST_NODE_MODULES_SENTINEL'), 'must-not-enter-image\n');

  const image = `maestro-server-docker-context-test:${Date.now()}`;
  const build = spawnSync('docker', ['build', '--no-cache', '-f', 'apps/server/Dockerfile', '.', '-t', image], {
    cwd: tmp,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (build.status !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    process.exit(build.status ?? 1);
  }
  const probe = spawnSync('docker', [
    'run', '--rm', '--entrypoint', 'node', image,
    '--import', 'tsx',
    '-e',
    "import('@maestro/realtime/shadowScreenStream').then(()=>import('node:fs')).then(fs=>{ if (fs.existsSync('/app/HOST_NODE_MODULES_SENTINEL')) process.exit(2); })",
  ], { encoding: 'utf8', stdio: 'pipe' });
  spawnSync('docker', ['image', 'rm', '-f', image], { stdio: 'ignore' });
  if (probe.status !== 0) {
    process.stderr.write(probe.stdout);
    process.stderr.write(probe.stderr);
    process.exit(probe.status ?? 1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
