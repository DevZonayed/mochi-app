/* GitHub CLI (`gh`) store — resolve an existing `gh`, or fetch the official
   release binary on first use into userData (NOT bundled), mirroring the engine
   binaries (engines.ts). `gh` is ~10–15 MB to download, far smaller than the
   Codex/Claude engines, and we only need it to broker GitHub's OAuth device flow
   (`gh auth login --web`) so the user never pastes a Personal Access Token.

   Resolve order:
     1. an existing system install (PATH / Homebrew) — no download
     2. a verified managed copy we downloaded (userData/engines/gh/<version>)
     3. download the pinned release from github.com/cli/cli/releases (sha256-verified)

   Electron-free so it can be unit-tested; the install root is injected via
   setEnginesRoot() in engines.ts (shared) or MAESTRO_ENGINES_DIR. */

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

/** Pinned gh release. Bump to upgrade; the managed dir is keyed by version so a
    new pin downloads fresh and old versions are GC'd. */
export const GH_VERSION = '2.63.2';

const isWin = (): boolean => process.platform === 'win32';

/** GitHub's release naming for this platform: {os, arch, archive extension}. */
export function ghPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch):
  { os: string; arch: string; ext: 'zip' | 'tar.gz' } | null {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!a) return null;
  if (platform === 'darwin') return { os: 'macOS', arch: a, ext: 'zip' };
  if (platform === 'linux') return { os: 'linux', arch: a, ext: 'tar.gz' };
  if (platform === 'win32') return { os: 'windows', arch: a, ext: 'zip' };
  return null;
}

/** The release asset filename, e.g. `gh_2.63.2_macOS_arm64.zip`. */
export function ghAssetName(version = GH_VERSION, platform?: NodeJS.Platform, arch?: string): string | null {
  const p = ghPlatform(platform, arch);
  return p ? `gh_${version}_${p.os}_${p.arch}.${p.ext}` : null;
}

/** Path to the `gh` binary INSIDE the extracted archive (archives unpack to a
    `gh_<ver>_<os>_<arch>/` dir with `bin/gh`). */
export function ghBinInArchive(version = GH_VERSION, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const p = ghPlatform(platform, arch);
  if (!p) return null;
  return path.join(`gh_${version}_${p.os}_${p.arch}`, 'bin', platform === 'win32' ? 'gh.exe' : 'gh');
}

/** Find an asset's sha256 in a `gh_<ver>_checksums.txt` body (`<sha256>  <name>`). */
export function parseChecksum(checksumsBody: string, assetName: string): string | null {
  for (const line of checksumsBody.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
    if (m && m[2].trim() === assetName) return m[1].toLowerCase();
  }
  return null;
}

const releaseBase = (version = GH_VERSION) => `https://github.com/cli/cli/releases/download/v${version}`;
export const ghAssetUrl = (version = GH_VERSION, platform?: NodeJS.Platform, arch?: string): string | null => {
  const name = ghAssetName(version, platform, arch);
  return name ? `${releaseBase(version)}/${name}` : null;
};
export const ghChecksumsUrl = (version = GH_VERSION): string => `${releaseBase(version)}/gh_${version}_checksums.txt`;

/* ── Install root (shared with the engines store) ──────────────────────── */
const ghRoot = (root = enginesRoot()): string => path.join(root, 'gh');
const versionDir = (root: string, version: string): string => path.join(ghRoot(root), version);
const okMarker = (dir: string): string => path.join(dir, '.ok');
const managedExe = (root: string, version: string): string =>
  path.join(versionDir(root, version), `gh_${version}_${ghPlatform()?.os}_${ghPlatform()?.arch}`, 'bin', isWin() ? 'gh.exe' : 'gh');

/** A verified managed copy for the pinned version, or null. */
export function managedGh(root = enginesRoot()): string | null {
  const dir = versionDir(root, GH_VERSION);
  if (!existsSync(okMarker(dir))) return null;
  const bin = managedExe(root, GH_VERSION);
  return existsSync(bin) ? bin : null;
}

/** An existing `gh` on the user's machine (PATH + Homebrew), or null. */
export function systemGh(): string | null {
  if (isWin()) {
    try {
      const found = execFileSync('where', ['gh'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
      if (found && existsSync(found)) return found;
    } catch { /* not on PATH */ }
    return null;
  }
  try {
    const found = execFileSync('/bin/zsh', ['-lc', 'command -v gh'], { encoding: 'utf8' }).trim();
    if (found && existsSync(found)) return found;
  } catch { /* none */ }
  for (const cand of [`/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, path.join(homedir(), '.local', 'bin', 'gh')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Resolve `gh`: system install first (no download), then a managed copy. Null
    means "not present — call downloadGh()". */
export function resolveGh(root = enginesRoot()): string | null {
  return systemGh() ?? managedGh(root);
}

export interface GhState { installed: boolean; source: 'system' | 'managed' | 'none'; version: string | null; path: string | null; supported: boolean }
export function ghState(root = enginesRoot()): GhState {
  const sys = systemGh();
  if (sys) return { installed: true, source: 'system', version: null, path: sys, supported: true };
  const man = managedGh(root);
  if (man) return { installed: true, source: 'managed', version: GH_VERSION, path: man, supported: true };
  return { installed: false, source: 'none', version: GH_VERSION, path: null, supported: ghPlatform() !== null };
}

/* ── Download ──────────────────────────────────────────────────────────── */
export interface GhDownloadProgress { phase: 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'done' | 'error'; received?: number; total?: number; pct?: number }

function httpError(message: string, statusCode: number): Error { return Object.assign(new Error(message), { statusCode }); }

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw httpError(`fetch ${res.status} for ${url}`, res.status || 502);
  return res.text();
}

async function download(url: string, dest: string, onProgress: (r: number, t: number) => void, signal?: AbortSignal): Promise<void> {
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

const sha256Hex = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Download + install `gh` for this platform. Atomic: extract into a sibling work
    dir on the same filesystem, then rename into place. Verifies the release sha256
    (from the published checksums.txt over HTTPS). */
export async function downloadGh(root = enginesRoot(), onProgress: (p: GhDownloadProgress) => void = () => {}, signal?: AbortSignal): Promise<{ path: string; version: string }> {
  onProgress({ phase: 'resolve' });
  const asset = ghAssetName();
  const url = ghAssetUrl();
  if (!asset || !url) throw httpError(`gh has no prebuilt binary for ${process.platform}-${process.arch}.`, 501);

  const dest = versionDir(root, GH_VERSION);
  const work = path.join(ghRoot(root), `.dl-${GH_VERSION}`);
  await mkdir(path.dirname(work), { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  try {
    onProgress({ phase: 'download', received: 0, total: 0, pct: 0 });
    const archive = path.join(work, asset);
    await download(url, archive, (received, total) => onProgress({ phase: 'download', received, total, pct: total ? Math.round((received / total) * 100) : undefined }), signal);
    if (signal?.aborted) throw httpError('cancelled', 499);

    onProgress({ phase: 'verify' });
    const checksums = await fetchText(ghChecksumsUrl());
    const expected = parseChecksum(checksums, asset);
    if (!expected) throw httpError(`No checksum published for ${asset}.`, 502);
    if (sha256Hex(archive) !== expected) throw httpError(`Integrity check failed for ${asset}.`, 502);

    onProgress({ phase: 'extract' });
    // bsdtar (macOS/Windows) extracts .zip; GNU tar (Linux) handles .tar.gz.
    const ext = ghPlatform()!.ext;
    await execFileP('tar', ext === 'zip' ? ['-xf', archive, '-C', work] : ['-xzf', archive, '-C', work]);
    const relBin = ghBinInArchive()!;
    const binInWork = path.join(work, relBin);
    if (!existsSync(binInWork)) throw httpError(`gh binary missing in ${asset}.`, 502);
    await chmod(binInWork, 0o755);

    onProgress({ phase: 'install' });
    await rm(dest, { recursive: true, force: true });
    // The extracted top dir is `gh_<ver>_<os>_<arch>/`; move it under the version dir.
    const topDir = path.join(work, relBin.split(path.sep)[0]);
    await mkdir(dest, { recursive: true });
    await rename(topDir, path.join(dest, relBin.split(path.sep)[0]));
    await writeFile(okMarker(dest), JSON.stringify({ version: GH_VERSION, sha256: expected, installedAt: Date.now() }));

    await gcOld(root, GH_VERSION);
    onProgress({ phase: 'done', pct: 100 });
    return { path: managedExe(root, GH_VERSION), version: GH_VERSION };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function gcOld(root: string, keep: string): Promise<void> {
  try {
    for (const entry of await readdir(ghRoot(root))) {
      if (entry === keep || entry.startsWith('.dl-')) continue;
      await rm(path.join(ghRoot(root), entry), { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* nothing to GC */ }
}
