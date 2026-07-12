// Deterministic SOURCE provenance manifest — the content-addressed replacement for
// the old textual `git diff HEAD` aggregate, which disagreed between package-time
// and later runs (textual diff is state/environment-sensitive, and the untracked
// `git hash-object` loop captured content ONLY — not the exec bit or symlink target).
//
// The fingerprint is SHA-256 over, in order:
//   1. a fixed algorithm-version marker,
//   2. HEAD (or "no-head"),
//   3. for every raw relative path in the NUL-safe, byte-sorted UNION of
//      `git ls-files --cached` (tracked) and `--others --exclude-standard` (untracked,
//      gitignore-respecting) — one record with: the raw path bytes, the working-tree
//      KIND (regular / symlink / submodule / other / missing), the executable-bit
//      state, and the SHA-256 of the content (regular) or the symlink target bytes.
//
// Properties: deterministic for an unchanged tree; flips on any tracked OR untracked
// content change, a deletion (a missing tracked path is still emitted, as KIND=missing),
// an exec-bit change (tracked or untracked), or a symlink-target change; ignores
// gitignored/generated files. Raw path bytes handle spaces / newlines / non-UTF-8.
// SECURITY: never prints paths or content — only SOURCE_REV / SOURCE_FINGERPRINT /
// SOURCE_STATUS. STATUS is `clean` iff `git status --porcelain` is empty. Fails closed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ALGO_VERSION = 'maestro-source-manifest-v1';
const NUL = Buffer.from([0]);

/** Run git read-only; return stdout Buffer, or null on failure (fail closed). */
function tryGit(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 30 });
  } catch {
    return null;
  }
}

/** Split a NUL-delimited git -z buffer into per-entry Buffers (raw bytes preserved). */
function splitNul(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start)); // tolerate a missing final NUL
  return out;
}

/** Dedupe by exact bytes and sort by raw byte order (stable, locale-independent). */
function dedupeSortByBytes(bufs) {
  const map = new Map();
  for (const b of bufs) if (b.length) map.set(b.toString('latin1'), b);
  return [...map.values()].sort(Buffer.compare);
}

/** One canonical, delimited record for a path — folded into the hash, never printed. */
function recordFor(repo, pathBuf) {
  const abs = Buffer.concat([Buffer.from(repo + '/'), pathBuf]);
  const parts = [Buffer.from('P'), NUL, pathBuf, NUL];
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    // A tracked path that is gone from the working tree — emit it so deletions
    // change the hash.
    parts.push(Buffer.from('K'), NUL, Buffer.from('missing'), NUL);
    return Buffer.concat(parts);
  }
  const execBit = st.mode & 0o111 ? '1' : '0';
  if (st.isSymbolicLink()) {
    const target = readlinkSync(abs, 'buffer');
    parts.push(Buffer.from('K'), NUL, Buffer.from('symlink'), NUL, Buffer.from('T'), NUL, target, NUL);
  } else if (st.isDirectory()) {
    // A directory entry from ls-files is a submodule/gitlink — record it safely,
    // NEVER recurse into it.
    parts.push(Buffer.from('K'), NUL, Buffer.from('submodule'), NUL);
  } else if (st.isFile()) {
    const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
    parts.push(
      Buffer.from('K'), NUL, Buffer.from('regular'), NUL,
      Buffer.from('X'), NUL, Buffer.from(execBit), NUL,
      Buffer.from('C'), NUL, Buffer.from(sha), NUL,
    );
  } else {
    // fifo / socket / device — record the kind, no content.
    parts.push(Buffer.from('K'), NUL, Buffer.from('other'), NUL);
  }
  return Buffer.concat(parts);
}

/** Compute { rev, fingerprint, status } deterministically for a repo root. */
export function computeSourceManifest(repo) {
  const headBuf = tryGit(repo, ['rev-parse', 'HEAD']);
  const rev = headBuf ? headBuf.toString('utf8').trim() : 'no-head';

  const porcelain = tryGit(repo, ['status', '--porcelain']);
  // Fail closed: an unreadable status is treated as dirty, never silently clean.
  const status = porcelain === null || porcelain.length > 0 ? 'dirty' : 'clean';

  const listed = tryGit(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (listed === null) throw new Error('source-manifest: `git ls-files` failed (not a repo?)');
  const paths = dedupeSortByBytes(splitNul(listed));

  const h = createHash('sha256');
  h.update(ALGO_VERSION);
  h.update(NUL);
  h.update('HEAD');
  h.update(NUL);
  h.update(rev);
  h.update(NUL);
  for (const p of paths) h.update(recordFor(repo, p));

  return { rev, fingerprint: h.digest('hex'), status };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const repo = process.argv[2] || process.cwd();
  const m = computeSourceManifest(repo);
  process.stdout.write(`SOURCE_REV=${m.rev}\n`);
  process.stdout.write(`SOURCE_FINGERPRINT=${m.fingerprint}\n`);
  process.stdout.write(`SOURCE_STATUS=${m.status}\n`);
}
