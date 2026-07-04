/* ffmpeg store — resolve an existing `ffmpeg`, or fetch a static build on first
   use into userData (NOT bundled), mirroring the engine binaries (engines.ts)
   and the gh CLI (gh-cli.ts). Design projects use it to mine video resources
   (frame extraction for visual research) — ~20 MB per platform, downloaded
   in the background the first time a project actually needs it.

   Resolve order:
     1. an existing system install (PATH / Homebrew) — no download
     2. a verified managed copy we downloaded (userData/engines/ffmpeg/<version>)
     3. download the pinned per-platform npm tarball (@ffmpeg-installer/*),
        sha512-verified against the npm registry's published integrity.

   Electron-free so it can be unit-tested; the install root comes from
   enginesRoot() (set by main.ts) or MAESTRO_ENGINES_DIR. */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, rename, chmod, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { enginesRoot } from './engines.js';

const execFileP = promisify(execFile);
const isWin = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32';

/** Pinned per-platform npm packages that carry a static ffmpeg at the package
    root (`package/ffmpeg`). Versions are the published pins of
    @ffmpeg-installer/ffmpeg's optionalDependencies — bump to upgrade. */
export const FFMPEG_PLAT: Record<string, { pkg: string; version: string }> = {
  'darwin-arm64': { pkg: '@ffmpeg-installer/darwin-arm64', version: '4.1.5' },
  'darwin-x64':   { pkg: '@ffmpeg-installer/darwin-x64',   version: '4.1.0' },
  'linux-x64':    { pkg: '@ffmpeg-installer/linux-x64',    version: '4.1.0' },
  'linux-arm64':  { pkg: '@ffmpeg-installer/linux-arm64',  version: '4.1.4' },
  'win32-x64':    { pkg: '@ffmpeg-installer/win32-x64',    version: '4.1.0' },
};

/** The npm package + version + in-package binary name for a platform (null =
    unsupported). Pure so it unit-tests across platforms. */
export function ffmpegSpec(platform: NodeJS.Platform = process.platform, arch: string = process.arch):
  { pkg: string; version: string; bin: string } | null {
  const hit = FFMPEG_PLAT[`${platform}-${arch}`];
  return hit ? { ...hit, bin: isWin(platform) ? 'ffmpeg.exe' : 'ffmpeg' } : null;
}

/* ── Install root (shared with the engines store) ──────────────────────── */
const ffRoot = (root = enginesRoot()): string => path.join(root, 'ffmpeg');
const versionDir = (root: string, version: string): string => path.join(ffRoot(root), version);
const okMarker = (dir: string): string => path.join(dir, '.ok');

/** Where the managed binary lives (or will live once downloaded) — null when
    the platform is unsupported. Used to pre-announce the path to the agent. */
export function managedFfmpegTarget(root = enginesRoot()): string | null {
  const spec = ffmpegSpec();
  return spec ? path.join(versionDir(root, spec.version), spec.bin) : null;
}

/** A verified managed copy for the pinned version, or null. */
export function managedFfmpeg(root = enginesRoot()): string | null {
  const spec = ffmpegSpec();
  if (!spec) return null;
  const dir = versionDir(root, spec.version);
  if (!existsSync(okMarker(dir))) return null;
  const bin = path.join(dir, spec.bin);
  return existsSync(bin) ? bin : null;
}

/** An existing ffmpeg on the user's machine (PATH + common locations), or null.
    The lookup shells out (login shell on macOS), so the result is cached for a
    few minutes — resolveFfmpeg runs on every ffmpeg-wanting design turn. */
let sysCache: { path: string | null; at: number } | null = null;
const SYS_CACHE_MS = 5 * 60_000;
export function systemFfmpeg(): string | null {
  if (sysCache && Date.now() - sysCache.at < SYS_CACHE_MS && (!sysCache.path || existsSync(sysCache.path))) return sysCache.path;
  const found = lookupSystemFfmpeg();
  sysCache = { path: found, at: Date.now() };
  return found;
}

function lookupSystemFfmpeg(): string | null {
  if (isWin()) {
    try {
      const found = execFileSync('where', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
      if (found && existsSync(found)) return found;
    } catch { /* not on PATH */ }
    return null;
  }
  try {
    const found = execFileSync('/bin/zsh', ['-lc', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
    if (found && existsSync(found)) return found;
  } catch { /* none */ }
  for (const cand of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(homedir(), '.local', 'bin', 'ffmpeg')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Resolve ffmpeg without downloading: system first, then managed. Null means
    "not present — call ensureFfmpeg() / downloadFfmpeg()". */
export function resolveFfmpeg(root = enginesRoot()): string | null {
  return systemFfmpeg() ?? managedFfmpeg(root);
}

/* ── Download (npm tarball, sha512-verified) ───────────────────────────── */

export interface FfmpegDownloadProgress { phase: 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'done' | 'error'; received?: number; total?: number; pct?: number }

function httpError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }

interface NpmDist { tarball: string; integrity?: string }
async function registryDist(pkg: string, version: string): Promise<NpmDist> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/${version}`);
  if (!res.ok) throw httpError(`registry ${res.status} for ${pkg}@${version}`, res.status || 502);
  const json = (await res.json()) as { dist?: NpmDist };
  if (!json.dist?.tarball) throw httpError(`no tarball for ${pkg}@${version}`, 502);
  return json.dist;
}

async function downloadTarball(url: string, dest: string, onProgress: (r: number, t: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw httpError(`download ${res.status} for ${url}`, res.status || 502);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0, lastEmit = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received - lastEmit >= 100_000 || (total && received >= total)) { lastEmit = received; onProgress(received, total); }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(dest));
}

const sha512Base64 = (file: string): string => createHash('sha512').update(readFileSync(file)).digest('base64');

/** Download + install ffmpeg for this platform. Atomic: extract into a sibling
    work dir on the same filesystem, then rename into place. */
export async function downloadFfmpeg(
  root = enginesRoot(),
  onProgress: (p: FfmpegDownloadProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<{ path: string; version: string }> {
  onProgress({ phase: 'resolve' });
  const spec = ffmpegSpec();
  if (!spec) throw httpError(`ffmpeg has no prebuilt binary for ${process.platform}-${process.arch}.`, 501);

  const dest = versionDir(root, spec.version);
  const work = path.join(ffRoot(root), `.dl-${spec.version}`);
  await mkdir(path.dirname(work), { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  try {
    const dist = await registryDist(spec.pkg, spec.version);
    if (signal?.aborted) throw httpError('cancelled', 499);
    const tgz = path.join(work, 'pkg.tgz');

    onProgress({ phase: 'download', received: 0, total: 0, pct: 0 });
    await downloadTarball(dist.tarball, tgz, (received, total) =>
      onProgress({ phase: 'download', received, total, pct: total ? Math.round((received / total) * 100) : undefined }), signal);

    onProgress({ phase: 'verify' });
    // The pinned versions all publish sha512 integrity — treat its absence as
    // a failure rather than installing an unverified binary.
    if (!dist.integrity?.startsWith('sha512-')) throw httpError(`No sha512 integrity published for ${spec.pkg}@${spec.version} — refusing unverified install.`, 502);
    const expected = dist.integrity.slice('sha512-'.length);
    if (sha512Base64(tgz) !== expected) throw httpError(`Integrity check failed for ${spec.pkg}@${spec.version}.`, 502);

    onProgress({ phase: 'extract' });
    // npm tarballs unpack to ./package/* — `tar` is present on every target OS.
    await execFileP('tar', ['-xzf', tgz, '-C', work]);
    const binInWork = path.join(work, 'package', spec.bin);
    if (!existsSync(binInWork)) throw httpError(`ffmpeg binary missing in ${spec.pkg}@${spec.version} tarball.`, 502);
    await chmod(binInWork, 0o755);

    onProgress({ phase: 'install' });
    await rm(dest, { recursive: true, force: true });
    await rename(path.join(work, 'package'), dest); // same filesystem → atomic
    await writeFile(okMarker(dest), JSON.stringify({ version: spec.version, integrity: dist.integrity ?? null, installedAt: Date.now() }));

    await gcOld(root, spec.version);
    onProgress({ phase: 'done', pct: 100 });
    return { path: path.join(dest, spec.bin), version: spec.version };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function gcOld(root: string, keep: string): Promise<void> {
  try {
    for (const entry of await readdir(ffRoot(root))) {
      if (entry === keep || entry.startsWith('.dl-')) continue;
      await rm(path.join(ffRoot(root), entry), { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* nothing to GC */ }
}

/* ── ensure (single-flight, background-safe) ───────────────────────────── */
let inFlight: Promise<string> | null = null;

/** Idempotent "make ffmpeg exist": resolves the current binary, or starts (or
    joins) one background download. Never throws synchronously; concurrent
    callers share the same download. */
export function ensureFfmpeg(root = enginesRoot()): Promise<string> {
  const have = resolveFfmpeg(root);
  if (have) return Promise.resolve(have);
  if (!inFlight) {
    inFlight = downloadFfmpeg(root)
      .then(r => r.path)
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}
