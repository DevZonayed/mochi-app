/* Engine binary store — fetch + manage the native CLI binaries OUTSIDE the app
   bundle.

   We used to ship the per-platform Codex (Rust) binary and the Claude Agent
   SDK's `claude` binary inside the installer (~50–80 MB each, doubled on the
   universal macOS build). That dominated the download size. Instead we now ship
   only the small JS (the Codex JS wrapper + the Agent SDK) and resolve the heavy
   native binary at runtime in this order:

     1. an existing system install (Codex) / a version-matched managed copy (Claude)
     2. download the EXACT pinned npm tarball for this platform into userData/engines
     3. (dev only) a binary still present in node_modules

   The download is byte-identical to what we'd otherwise have bundled (same npm
   tarball, sha512-verified) and lives outside the app bundle, so it survives app
   auto-updates and is shared across versions until the pinned version changes.

   This module is deliberately Electron-free so it can be unit-tested; the install
   root is injected via setEnginesRoot() (main.ts) or MAESTRO_ENGINES_DIR. */

import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, rename, chmod, writeFile, readdir, readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const require = createRequire(__filename);
const execFileP = promisify(execFile);

export type EngineId = 'codex' | 'claude';

/* ── Platform → npm package map ──────────────────────────────────────────
   Codex vends the native binary at <pkg>/vendor/<triple>/bin/codex; the Agent
   SDK ships its `claude` binary at the package root. Both are referenced as
   per-platform optional dependencies of their meta package. */
const CODEX_PLAT: Record<string, { pkg: string; triple: string }> = {
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64':   { pkg: '@openai/codex-darwin-x64',   triple: 'x86_64-apple-darwin' },
  'linux-x64':    { pkg: '@openai/codex-linux-x64',    triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64':  { pkg: '@openai/codex-linux-arm64',  triple: 'aarch64-unknown-linux-musl' },
  'win32-x64':    { pkg: '@openai/codex-win32-x64',    triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64':  { pkg: '@openai/codex-win32-arm64',  triple: 'aarch64-pc-windows-msvc' },
};
const CLAUDE_PLAT: Record<string, { pkg: string }> = {
  'darwin-arm64': { pkg: '@anthropic-ai/claude-agent-sdk-darwin-arm64' },
  'darwin-x64':   { pkg: '@anthropic-ai/claude-agent-sdk-darwin-x64' },
  'linux-x64':    { pkg: '@anthropic-ai/claude-agent-sdk-linux-x64' },
  'linux-arm64':  { pkg: '@anthropic-ai/claude-agent-sdk-linux-arm64' },
  'win32-x64':    { pkg: '@anthropic-ai/claude-agent-sdk-win32-x64' },
};
const META_PKG: Record<EngineId, string> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-agent-sdk',
};

const platKey = (): string => `${process.platform}-${process.arch}`;
const isWin = (): boolean => process.platform === 'win32';

/** The npm package that carries this engine's native binary for this platform,
    or null if the platform is unsupported. */
export function platformPkg(id: EngineId): string | null {
  const k = platKey();
  return id === 'codex' ? (CODEX_PLAT[k]?.pkg ?? null) : (CLAUDE_PLAT[k]?.pkg ?? null);
}

/** The binary's path RELATIVE to the extracted package root (and to a managed
    install dir, since we preserve the package layout). */
export function binaryRelPath(id: EngineId): string {
  if (id === 'codex') {
    const triple = CODEX_PLAT[platKey()]?.triple ?? '';
    return path.join('vendor', triple, 'bin', isWin() ? 'codex.exe' : 'codex');
  }
  return isWin() ? 'claude.exe' : 'claude';
}

interface MetaJson {
  name?: string;
  version?: string;
  optionalDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/** Read the meta package's package.json. Some packages (the Agent SDK) block the
    `./package.json` subpath via `exports`, so fall back to walking up from the
    resolved main entry to the nearest matching package.json. */
function metaPackageJson(id: EngineId): MetaJson | null {
  const name = META_PKG[id];
  try {
    const pj = require.resolve(`${name}/package.json`);
    return JSON.parse(readFileSync(pj, 'utf8')) as MetaJson;
  } catch { /* exports may forbid the subpath — walk up from main */ }
  try {
    let dir = path.dirname(require.resolve(name));
    for (let i = 0; i < 10; i++) {
      const pj = path.join(dir, 'package.json');
      if (existsSync(pj)) {
        const json = JSON.parse(readFileSync(pj, 'utf8')) as MetaJson;
        if (json.name === name) return json;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* meta package not installed */ }
  return null;
}

/** What to fetch for this platform: the real npm registry package + version,
    derived from the meta package's per-platform optional dependency. Codex
    publishes platform builds as versions of `@openai/codex` aliased via
    `npm:@openai/codex@<ver>-<platform>`; the SDK uses a plain version of a
    per-platform package. Read from the bundled meta package so the download
    always matches the shipped JS. */
export function downloadSpec(id: EngineId): { registryPkg: string; version: string } | null {
  const alias = platformPkg(id);
  if (!alias) return null;
  const meta = metaPackageJson(id);
  if (!meta) return null;
  const raw = meta.optionalDependencies?.[alias] ?? meta.dependencies?.[alias];
  if (typeof raw === 'string') {
    const m = raw.match(/^npm:(.+)@([^@]+)$/); // npm:@scope/name@version
    if (m) return { registryPkg: m[1], version: m[2] };
    const v = raw.replace(/^[\^~>=\s]*/, '').trim();
    if (v) return { registryPkg: alias, version: v };
  }
  // Last resort: the platform package shares the meta version (lockstep).
  if (typeof meta.version === 'string') return { registryPkg: alias, version: meta.version };
  return null;
}

/** The version we'd download — used to key the managed install dir and for the
    status UI. Null only if the platform is unsupported or the meta package is
    missing. */
export function requiredVersion(id: EngineId): string | null {
  return downloadSpec(id)?.version ?? null;
}

/* ── Install root ──────────────────────────────────────────────────────── */
let _root: string | null = null;
/** Set the managed-engines root (main.ts → userData/engines). */
export function setEnginesRoot(dir: string): void { _root = dir; }
export function enginesRoot(): string {
  if (_root) return _root;
  if (process.env.MAESTRO_ENGINES_DIR) return process.env.MAESTRO_ENGINES_DIR;
  return path.join(homedir(), '.maestro', 'engines'); // fallback before setEnginesRoot()
}

const versionDir = (root: string, id: EngineId, version: string): string => path.join(root, id, version);
const okMarker = (dir: string): string => path.join(dir, '.ok');

/** Path to a verified managed copy for the pinned version, or null. */
export function managedBinary(root: string, id: EngineId): string | null {
  const version = requiredVersion(id);
  if (!version) return null;
  const dir = versionDir(root, id, version);
  if (!existsSync(okMarker(dir))) return null;
  const bin = path.join(dir, binaryRelPath(id));
  return existsSync(bin) ? bin : null;
}

/** A binary still present in node_modules (the dev inner loop — absent in
    production builds, which exclude the per-platform packages). */
export function bundledBinary(id: EngineId): string | null {
  const pkg = platformPkg(id);
  if (!pkg) return null;
  try {
    const pj = require.resolve(`${pkg}/package.json`);
    const cand = path.join(path.dirname(pj), binaryRelPath(id));
    if (existsSync(cand)) return cand;
  } catch { /* not installed for this platform */ }
  return null;
}

/** An engine already installed on the user's machine (PATH + common locations).
    Mirrors the legacy resolve fallbacks so existing installs cost no download. */
export function systemBinary(id: EngineId): string | null {
  const exe = id === 'codex' ? 'codex' : 'claude';
  if (isWin()) {
    try {
      const found = execFileSync('where', [exe], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
      if (found && existsSync(found)) return found;
    } catch { /* not on PATH */ }
    return null;
  }
  try {
    const found = execFileSync('/bin/zsh', ['-lc', `command -v ${exe}`], { encoding: 'utf8' }).trim();
    if (found && existsSync(found)) return found;
  } catch { /* none */ }
  for (const cand of [
    path.join(homedir(), '.local', 'bin', exe),
    `/opt/homebrew/bin/${exe}`,
    `/usr/local/bin/${exe}`,
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/* ── Status ────────────────────────────────────────────────────────────── */
export interface EngineState {
  id: EngineId;
  installed: boolean;
  source: 'managed' | 'system' | 'none';
  version: string | null;
  path: string | null;
  supported: boolean;
}

/** Where the engine currently resolves from, given the resolved path the engine
    layer hands us (so a system install is reflected accurately). */
export function engineState(root: string, id: EngineId, resolved: string | null): EngineState {
  const supported = platformPkg(id) !== null || resolved !== null;
  let source: EngineState['source'] = 'none';
  if (resolved) source = resolved === managedBinary(root, id) ? 'managed' : 'system';
  return { id, installed: !!resolved, source, version: requiredVersion(id), path: resolved, supported };
}

/* ── Download ──────────────────────────────────────────────────────────── */
export interface DownloadProgress {
  phase: 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'done' | 'error';
  received?: number;
  total?: number;
  pct?: number;
}

interface NpmDist { tarball: string; integrity?: string; shasum?: string }

async function registryDist(pkg: string, version: string): Promise<NpmDist> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${version}`;
  const res = await fetch(url);
  if (!res.ok) throw httpError(`registry ${res.status} for ${pkg}@${version}`, res.status);
  const json = (await res.json()) as { dist?: NpmDist };
  if (!json.dist?.tarball) throw httpError(`no tarball for ${pkg}@${version}`, 502);
  return json.dist;
}

async function downloadTarball(
  url: string,
  dest: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw httpError(`download ${res.status} for ${url}`, res.status || 502);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastEmit = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      // Throttle IPC: emit at most ~every 100 KB so we don't flood the renderer.
      if (received - lastEmit >= 100_000 || (total && received >= total)) {
        lastEmit = received;
        onProgress(received, total);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(dest));
}

function sha512Base64(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

/** Download + install one engine binary. Atomic: extract into a sibling work dir
    on the SAME filesystem, then rename into place. Verifies the npm sha512.
    Single in-flight per engine is enforced by the caller (LocalEngine). */
export async function downloadEngine(
  root: string,
  id: EngineId,
  onProgress: (p: DownloadProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<{ path: string; version: string }> {
  onProgress({ phase: 'resolve' });
  const spec = downloadSpec(id);
  if (!platformPkg(id)) throw httpError(`${id === 'codex' ? 'Codex' : 'Claude'} has no prebuilt binary for ${platKey()}.`, 501);
  if (!spec) throw httpError(`Could not determine the ${id} version to download.`, 500);
  const version = spec.version;

  const dest = versionDir(root, id, version);
  const work = path.join(root, id, `.dl-${version}`);
  await mkdir(path.dirname(work), { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  try {
    const dist = await registryDist(spec.registryPkg, version);
    if (signal?.aborted) throw httpError('cancelled', 499);
    const tgz = path.join(work, 'pkg.tgz');

    onProgress({ phase: 'download', received: 0, total: 0, pct: 0 });
    await downloadTarball(dist.tarball, tgz, (received, total) => {
      onProgress({ phase: 'download', received, total, pct: total ? Math.round((received / total) * 100) : undefined });
    }, signal);

    onProgress({ phase: 'verify' });
    if (dist.integrity?.startsWith('sha512-')) {
      const expected = dist.integrity.slice('sha512-'.length);
      if (sha512Base64(tgz) !== expected) throw httpError(`Integrity check failed for ${spec.registryPkg}@${version}.`, 502);
    }

    onProgress({ phase: 'extract' });
    // npm tarballs unpack to ./package/* — `tar` is present on every target OS
    // (Win10 1803+ ships bsdtar). Avoids bundling a tar library.
    await execFileP('tar', ['-xzf', tgz, '-C', work]);
    const extracted = path.join(work, 'package');
    const binInExtract = path.join(extracted, binaryRelPath(id));
    if (!existsSync(binInExtract)) throw httpError(`Binary missing in ${spec.registryPkg}@${version} tarball.`, 502);
    await chmod(binInExtract, 0o755);

    onProgress({ phase: 'install' });
    await rm(dest, { recursive: true, force: true });
    await rename(extracted, dest); // same filesystem → atomic
    await writeFile(okMarker(dest), JSON.stringify({ version, integrity: dist.integrity ?? null, installedAt: Date.now() }));

    await gcOldVersions(root, id, version);
    onProgress({ phase: 'done', pct: 100 });
    return { path: path.join(dest, binaryRelPath(id)), version };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Drop stale version dirs once a newer one is installed (keep only `keep`). */
async function gcOldVersions(root: string, id: EngineId, keep: string): Promise<void> {
  try {
    const base = path.join(root, id);
    for (const entry of await readdir(base)) {
      if (entry === keep || entry.startsWith('.dl-')) continue;
      await rm(path.join(base, entry), { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* nothing to GC */ }
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** Read the recorded install metadata, if any (used by tests/diagnostics). */
export async function managedMeta(root: string, id: EngineId): Promise<{ version: string } | null> {
  const version = requiredVersion(id);
  if (!version) return null;
  try {
    const raw = await readFileAsync(okMarker(versionDir(root, id, version)), 'utf8');
    return JSON.parse(raw) as { version: string };
  } catch {
    return null;
  }
}
