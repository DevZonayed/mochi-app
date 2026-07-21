/**
 * Confined agent attachment reader — security boundary for wa_send_media.
 *
 * The coding agent MUST save/copy screenshots, artifacts, or generated files
 * into `<cwd>/.continuum/Attachment/` before sending them as WhatsApp media.
 * This module resolves, confines, validates, and reads the attachment bytes
 * with fail-closed semantics:
 *
 * 1. Source must be a regular file under `<cwd>/.continuum/Attachment/`.
 * 2. Resolves cwd and target canonically; rejects traversal, symlink escape,
 *    directory targets, missing paths, and TOCTOU symlink swaps.
 * 3. Enforces a byte-size cap (16 MiB default — agent memory/safety cap;
 *    larger valid WhatsApp documents are intentionally rejected by this agent
 *    surface to keep in-process memory bounded).
 * 4. Infers kind/mimetype/filename from extension; supports image/video/audio/document.
 *    Only PNG/JPEG/WebP are classified as renderable image; SVG/BMP/GIF are
 *    sent as document since WhatsApp rendering is not guaranteed.
 * 5. Uses O_NOFOLLOW-equivalent open + fstat for TOCTOU resistance.
 * 6. Requires bytesRead === fstat.size — rejects partial/truncated reads.
 */

import { openSync, fstatSync, readSync, closeSync, realpathSync, lstatSync, constants } from 'node:fs';
import { resolve, basename, extname, join, relative, sep, isAbsolute } from 'node:path';

// ────── Public types ──────

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface AttachmentResult {
  data: Buffer;
  kind: MediaKind;
  mimetype: string;
  fileName: string;
  byteCount: number;
}

export class AttachmentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

// ────── Extension → kind/mime map ──────
// Conservative: only formats WhatsApp reliably renders as their kind.
// SVG/BMP/GIF → document (WhatsApp may not render them inline).

const EXT_MAP: Record<string, { kind: MediaKind; mime: string }> = {
  // Images (WhatsApp-renderable)
  '.png':  { kind: 'image', mime: 'image/png' },
  '.jpg':  { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  // Non-renderable image formats → document
  '.gif':  { kind: 'document', mime: 'image/gif' },
  '.bmp':  { kind: 'document', mime: 'image/bmp' },
  '.svg':  { kind: 'document', mime: 'image/svg+xml' },
  // Video
  '.mp4':  { kind: 'video', mime: 'video/mp4' },
  '.mov':  { kind: 'video', mime: 'video/quicktime' },
  '.avi':  { kind: 'video', mime: 'video/x-msvideo' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mkv':  { kind: 'video', mime: 'video/x-matroska' },
  // Audio
  '.mp3':  { kind: 'audio', mime: 'audio/mpeg' },
  '.ogg':  { kind: 'audio', mime: 'audio/ogg' },
  '.wav':  { kind: 'audio', mime: 'audio/wav' },
  '.m4a':  { kind: 'audio', mime: 'audio/mp4' },
  '.aac':  { kind: 'audio', mime: 'audio/aac' },
  '.opus': { kind: 'audio', mime: 'audio/opus' },
  // Document
  '.pdf':  { kind: 'document', mime: 'application/pdf' },
  '.doc':  { kind: 'document', mime: 'application/msword' },
  '.docx': { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xls':  { kind: 'document', mime: 'application/vnd.ms-excel' },
  '.xlsx': { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pptx': { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.txt':  { kind: 'document', mime: 'text/plain' },
  '.csv':  { kind: 'document', mime: 'text/csv' },
  '.zip':  { kind: 'document', mime: 'application/zip' },
  '.json': { kind: 'document', mime: 'application/json' },
};

/** Exported for tests — the EXT_MAP keys for each kind. */
export { EXT_MAP };

/**
 * Default byte cap: 16 MiB.
 * This is an agent memory/safety cap, NOT the WhatsApp protocol limit.
 * Larger valid WhatsApp documents are intentionally rejected by this agent
 * surface to keep in-process memory bounded.
 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Attachment root directory name under `.continuum/`. */
export const ATTACHMENT_DIR = 'Attachment';

/**
 * Segment-aware escape check: returns true if `rel` escapes the parent.
 * A relative path escapes when it IS '..' or STARTS with '../' (segment boundary),
 * or is absolute. A child literally named '..foo' does NOT escape.
 */
function escapesParent(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

// ────── Core reader ──────

export interface ReadAttachmentOpts {
  /** Working directory (session cwd). */
  cwd: string;
  /** Path as supplied by the agent (relative or absolute). */
  path: string;
  /** Byte cap (default 16 MiB). */
  maxBytes?: number;
  /**
   * Injectable read hook for testing short-read / concurrent-change behavior.
   * Production leaves this undefined (uses node:fs readSync).
   * In tests, return fewer bytes than requested to simulate truncation.
   */
  _readSync?: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number;
}

/**
 * Read an agent-staged attachment from the confined `.continuum/Attachment/` directory.
 *
 * Fail-closed: throws `AttachmentError` on any security or validation failure.
 */
export function readAttachment(opts: ReadAttachmentOpts): AttachmentResult {
  const { cwd, path: rawPath, maxBytes = DEFAULT_MAX_BYTES, _readSync } = opts;

  if (!rawPath || typeof rawPath !== 'string') {
    throw new AttachmentError('invalid-path', 'path is required');
  }

  // 1. Resolve the attachment root canonically.
  //    The .continuum/Attachment/ directory MUST exist and must NOT be a symlink itself.
  const attachRoot = resolve(cwd, '.continuum', ATTACHMENT_DIR);

  // Reject if the root itself is a symlink (before resolving).
  try {
    const rootStat = lstatSync(attachRoot);
    if (rootStat.isSymbolicLink()) {
      throw new AttachmentError('root-symlink', '.continuum/Attachment/ must not be a symlink');
    }
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError('no-attachment-dir', '.continuum/Attachment/ does not exist — create it and place the file there');
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(attachRoot);
  } catch {
    throw new AttachmentError('no-attachment-dir', '.continuum/Attachment/ does not exist — create it and place the file there');
  }

  // Reject if the root resolves outside cwd (parent symlink escape).
  const canonicalCwd = realpathSync(cwd);
  const rootRel = relative(canonicalCwd, canonicalRoot);
  if (escapesParent(rootRel)) {
    throw new AttachmentError('root-escape', '.continuum/Attachment/ resolves outside the working directory');
  }

  // 2. Resolve the target path.
  let targetPath: string;
  if (rawPath.startsWith('/')) {
    // Absolute — must still resolve inside the attachment root.
    targetPath = resolve(rawPath);
  } else {
    // Relative — resolve from the attachment root.
    targetPath = resolve(attachRoot, rawPath);
  }

  // 3. Pre-resolve symlink check: reject if the final component is a symlink,
  //    even when it points inside Attachment/. This closes the gap where
  //    realpathSync would follow the link and O_NOFOLLOW on the resolved
  //    regular file would silently accept it.
  try {
    const targetStat = lstatSync(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new AttachmentError('symlink', 'Refused to follow symlink');
    }
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    // ENOENT / EACCES / other → generic not-found (path-safe)
    throw new AttachmentError('not-found', 'File not found');
  }

  // 4. Canonical confinement check using path.relative + sep.
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(targetPath);
  } catch {
    throw new AttachmentError('not-found', 'File not found');
  }

  const targetRel = relative(canonicalRoot, canonicalTarget);
  if (escapesParent(targetRel) || targetRel === '') {
    throw new AttachmentError('traversal', 'Path escapes .continuum/Attachment/');
  }

  // 5. Open the file with O_NOFOLLOW to reject symlink targets at open time (TOCTOU defense).
  let fd: number;
  try {
    fd = openSync(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new AttachmentError('symlink', 'Refused to follow symlink');
    }
    if (code === 'ENOENT') {
      throw new AttachmentError('not-found', 'File not found');
    }
    throw new AttachmentError('open-failed', 'Cannot open file');
  }

  try {
    // 6. fstat on the open fd — verify it's a regular file (not directory, device, etc.).
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new AttachmentError('not-file', 'Not a regular file');
    }

    // 7. Size validation.
    if (stat.size === 0) {
      throw new AttachmentError('empty', 'File is empty');
    }
    if (stat.size > maxBytes) {
      throw new AttachmentError('too-large', `File exceeds the ${maxBytes} byte agent safety cap (${stat.size} bytes)`);
    }

    // 8. Read the exact bytes (from the fd, no re-open).
    const doRead = _readSync ?? readSync;
    const buf = Buffer.alloc(stat.size);
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      const n = doRead(fd, buf, bytesRead, stat.size - bytesRead, bytesRead);
      if (n === 0) break; // EOF
      bytesRead += n;
    }

    // 9. Require exact read — reject partial/truncated reads (file changed during read).
    if (bytesRead !== stat.size) {
      throw new AttachmentError('short-read', `File changed during read (expected ${stat.size} bytes, got ${bytesRead})`);
    }

    // 10. Infer kind/mimetype/filename from the basename.
    const fileName = sanitizeFilename(basename(canonicalTarget));
    const ext = extname(fileName).toLowerCase();
    const mapped = EXT_MAP[ext];
    const kind: MediaKind = mapped?.kind ?? 'document';
    const mimetype = mapped?.mime ?? 'application/octet-stream';

    return { data: buf, kind, mimetype, fileName, byteCount: buf.length };
  } finally {
    closeSync(fd);
  }
}

// ────── Helpers ──────

/** Strip path separators from the filename (defense in depth — basename should already handle it). */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '_') || 'attachment';
}

/** Resolve the attachment directory path (for use in directives / error messages). */
export function attachmentDir(cwd: string): string {
  return join(cwd, '.continuum', ATTACHMENT_DIR);
}
