// Loopback file-preview route: streams a confined project file over the sidecar HTTP server so
// the native app / chat previews can <video>/<img>/<a> straight at a byte-serving URL with proper
// Range support (seekable video). Confinement is delegated ENTIRELY to the shared brain resolver
// (resolveProjectFile + rootsForProject) so path-escape defence lives in exactly one place; this
// module never touches the filesystem outside the resolver's returned canonical path.
//
// Route contract:
//   GET|HEAD /files/stream?token=<hostToken>&projectId=<id>[&sessionId=<id>]&path=<rel-or-suffix>
// Only /files/stream is handled; every other pathname returns false so the caller's chain falls
// through to the design handler / WS upgrade. The token is read lazily via getToken() because the
// ws-host generates it inside startWsHost, so headless-main can wire the real value post-resolve.

import { basename } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { resolveProjectFile, rootsForProject, type ResolveStore } from '../../brain/file-resolve.js';
import { mimeForPath } from '../../brain/binary-detect.js';

export interface FilePreviewOpts {
  store: ResolveStore;
  getToken: () => string;
}

/** Map a resolver error to an HTTP status. Unknown-root (rootsForProject throw) → 404. */
function statusForResolveError(err: unknown): number {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'escape') return 403;
  if (code === 'ambiguous') return 409;
  if (code === 'not-found') return 404;
  return 404; // includes "this project has no folder on disk"
}

/** Parse an RFC7233 `bytes=start-end` header against a known size.
    Returns a resolved {start,end} slice, or null when unsatisfiable/invalid. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return null; // "bytes=-" — meaningless
  let start: number;
  let end: number;
  if (startStr === '') {
    // suffix form: last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end >= size) end = size - 1; // clamp overshoot on the end
  }
  if (start >= size || start > end || start < 0) return null;
  return { start, end };
}

// Defensive headers on EVERY response: never sniff, never leak the token via a
// referrer, and lock down documents with a near-null CSP. `frame-ancestors 'self'`
// (NOT 'none') is deliberate: the app renders the confined PDF via a same-origin
// <embed>, so the loopback origin must be allowed to embed it — while any
// cross-origin page is still refused. Inert HTML/XML/SVG (served as attachments)
// never become documents regardless.
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
};

// Content types a browser renders as a live DOCUMENT and that can run script / make
// subresource requests (which could leak the query-string token). These are ALWAYS
// forced inert: served as an octet-stream attachment so a crafted stream URL can
// never execute active content or be rendered as a document. Inert text (text/plain,
// JSON, css, …) and genuine media (image [raster], video, audio, PDF) keep their real
// type; combined with nosniff + no-referrer + a null CSP that is safe.
const ACTIVE_DOC_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'application/xml', 'text/xml', 'application/xml-dtd',
]);
function servedType(real: string, rawMime: string): { contentType: string; disposition?: string } {
  if (ACTIVE_DOC_TYPES.has(rawMime)) {
    const safeName = basename(real).replace(/[\r\n"\\]/g, '_');
    return { contentType: 'application/octet-stream', disposition: `attachment; filename="${safeName}"` };
  }
  return { contentType: rawMime };
}

export function makeFilePreviewHttp(opts: FilePreviewOpts): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { store, getToken } = opts;

  return async function filePreviewHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? '', 'http://127.0.0.1');
    } catch {
      return false;
    }
    if (parsed.pathname !== '/files/stream') return false; // not ours — fall through

    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
        res.end('method not allowed');
        return true;
      }

      const q = parsed.searchParams;
      const token = q.get('token');
      const expected = getToken();
      if (!token || !expected || token !== expected) {
        res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
        res.end('unauthorized');
        return true;
      }

      const projectId = q.get('projectId') ?? '';
      const sessionId = q.get('sessionId') ?? undefined;
      const rel = q.get('path') ?? '';

      // Resolve to a canonical path provably inside the project's roots (or fail closed).
      let real: string;
      try {
        real = resolveProjectFile(rootsForProject(store, projectId, sessionId), rel);
      } catch (e) {
        const status = statusForResolveError(e);
        res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
        res.end(status === 403 ? 'forbidden' : status === 409 ? 'ambiguous' : 'not found');
        return true;
      }

      // Open a file DESCRIPTOR and stream from IT (never reopen by pathname), so a
      // path component can't be symlink-swapped between resolution and read (TOCTOU).
      // Then revalidate: the fd's fstat must be a regular file AND realpath(real) must
      // still equal the canonical path the resolver returned (an intervening symlink
      // swap would change it) before we serve a single byte.
      const fh = await open(real, 'r');
      let served = false;
      try {
        const st = await fh.stat();
        if (!st.isFile()) {
          res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('not found');
          return true;
        }
        let recheck: string;
        try { recheck = await realpath(real); } catch { recheck = ''; }
        if (recheck !== real) {
          res.writeHead(409, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('file changed');
          return true;
        }

        const size = st.size;
        const { contentType, disposition } = servedType(real, mimeForPath(real));
        const rangeHeader = req.headers['range'];
        const common: Record<string, string> = {
          ...SECURITY_HEADERS,
          'content-type': contentType,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        };
        if (disposition) common['content-disposition'] = disposition;

        // HEAD — headers only, full-length advertised, no body.
        if (method === 'HEAD') {
          res.writeHead(200, { ...common, 'content-length': String(size) });
          res.end();
          return true;
        }

        if (typeof rangeHeader === 'string' && rangeHeader.trim() !== '') {
          const slice = parseRange(rangeHeader, size);
          if (!slice) {
            res.writeHead(416, { ...common, 'content-range': `bytes */${size}` });
            res.end('range not satisfiable');
            return true;
          }
          const { start, end } = slice;
          res.writeHead(206, { ...common, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
          const stream = fh.createReadStream({ start, end, autoClose: true });
          served = true; // fh is now owned by the stream (autoClose) — don't double-close
          stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
          stream.pipe(res);
          return true;
        }

        // Full body.
        res.writeHead(200, { ...common, 'content-length': String(size) });
        const stream = fh.createReadStream({ autoClose: true });
        served = true; // fh is now owned by the stream (autoClose) — don't double-close
        stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
        stream.pipe(res);
        return true;
      } finally {
        if (!served) { try { await fh.close(); } catch { /* noop */ } }
      }
    } catch {
      // Never leak the token or a stack; fail closed with a generic 500.
      try {
        if (!res.headersSent) {
          res.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
          res.end('internal error');
        } else {
          res.destroy();
        }
      } catch { /* noop */ }
      return true;
    }
  };
}
