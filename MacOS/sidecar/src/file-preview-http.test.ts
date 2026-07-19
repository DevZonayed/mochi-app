// Tests for the /files/stream loopback file-preview route. Drives the handler through a real
// throwaway http server on 127.0.0.1:0 so we exercise Range/HEAD/status semantics end-to-end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeFilePreviewHttp } from './file-preview-http.ts';

const TOKEN = 'secret-token-123';

// Fixtures ------------------------------------------------------------------
let root: string;
let textBody: Buffer;
let binBody: Buffer;
let mp4Body: Buffer;

// Minimal in-memory store matching the ResolveStore structural view.
function makeStore(projectPath: string) {
  return {
    getProject: (id: string) => (id === 'p1' ? { path: projectPath } : undefined),
    getSession: (_id: string) => undefined,
    listSessions: () => [] as Array<{ projectId?: string; worktreePath?: string }>,
  };
}

let server: Server;
let base: string;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fp-')));
  textBody = Buffer.from('hello world file preview', 'utf8');
  writeFileSync(path.join(root, 'hello.txt'), textBody);
  binBody = Buffer.alloc(2000);
  for (let i = 0; i < binBody.length; i++) binBody[i] = i % 256;
  writeFileSync(path.join(root, 'blob.bin'), binBody);
  mkdirSync(path.join(root, 'projects', 'x', 'renders'), { recursive: true });
  mp4Body = Buffer.from('ftypisom-fake-mp4-payload-bytes', 'utf8');
  writeFileSync(path.join(root, 'projects', 'x', 'renders', 'final.mp4'), mp4Body);
  // Active document types that must NEVER be served as active content.
  writeFileSync(path.join(root, 'page.html'), '<script>parent.postMessage(location.href,"*")</script>');
  writeFileSync(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  // A PDF the app embeds inline via a same-origin <embed>.
  writeFileSync(path.join(root, 'doc.pdf'), Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF', 'utf8'));

  const store = makeStore(root);
  const handler = makeFilePreviewHttp({ store: store as any, getToken: () => TOKEN });
  server = createServer((req, res) => {
    void (async () => {
      if (await handler(req, res)) return;
      res.writeHead(404); res.end('fallthrough');
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function url(q: Record<string, string>): string {
  const u = new URL(base + '/files/stream');
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

describe('makeFilePreviewHttp', () => {
  it('falls through for non /files/stream paths', async () => {
    const res = await fetch(base + '/something/else');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('fallthrough');
  });

  it('missing token → 401', async () => {
    const res = await fetch(url({ projectId: 'p1', path: 'hello.txt' }));
    expect(res.status).toBe(401);
  });

  it('wrong token → 401', async () => {
    const res = await fetch(url({ token: 'nope', projectId: 'p1', path: 'hello.txt' }));
    expect(res.status).toBe(401);
  });

  it('correct token → 200 with headers + exact bytes', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'hello.txt' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-length')).toBe(String(textBody.length));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(textBody)).toBe(true);
  });

  it('carries defensive headers (nosniff + no-referrer + null CSP) so the token cannot leak / sniff', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'hello.txt' }));
    await res.arrayBuffer();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
  });

  it('even a 401 sends no-referrer (token cannot leak via the Referer header)', async () => {
    const res = await fetch(url({ projectId: 'p1', path: 'hello.txt' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('forces ACTIVE document types (html) inert — octet-stream attachment, never active', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'page.html' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('forces SVG inert (never served as image/svg+xml active document)', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'icon.svg' }));
    await res.arrayBuffer();
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
  });

  it('PDF stays application/pdf (NOT an attachment) and is same-origin embeddable', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'doc.pdf' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    // must be embeddable inline, not forced to download
    expect(res.headers.get('content-disposition')).toBeNull();
    // CSP allows ONLY same-origin embedding (self), never cross-origin, never 'none'
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/frame-ancestors 'self'/);
    expect(csp).not.toMatch(/frame-ancestors 'none'/);
    // and still carries the token-leak / sniff defenses
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await res.arrayBuffer();
  });

  it('rejects non GET/HEAD → 405', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'hello.txt' }), { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('HEAD → 200 headers, empty body', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'hello.txt' }), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(textBody.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(0);
  });

  it('Range bytes=0-3 → 206 partial content', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'hello.txt' }), {
      headers: { Range: 'bytes=0-3' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-3/${textBody.length}`);
    expect(res.headers.get('content-length')).toBe('4');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(4);
    expect(buf.equals(textBody.subarray(0, 4))).toBe(true);
  });

  it('open-ended Range bytes=5- → 206 to EOF', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'blob.bin' }), {
      headers: { Range: 'bytes=5-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 5-${binBody.length - 1}/${binBody.length}`);
    expect(res.headers.get('content-length')).toBe(String(binBody.length - 5));
  });

  it('unsatisfiable Range past EOF → 416', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'hello.txt' }), {
      headers: { Range: 'bytes=99999-' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${textBody.length}`);
  });

  it('mp4 content-type from extension + nested suffix resolves', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'renders/final.mp4' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe(String(mp4Body.length));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(mp4Body)).toBe(true);
  });

  it('path escaping the root → confined (403/404)', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: '../../etc/passwd' }));
    expect([403, 404]).toContain(res.status);
  });

  it('absolute path outside root → confined (403/404)', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: '/etc/passwd' }));
    expect([403, 404]).toContain(res.status);
  });

  it('unknown project (no root) → 404', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'nope', path: 'hello.txt' }));
    expect(res.status).toBe(404);
  });

  it('nonexistent file → 404', async () => {
    const res = await fetch(url({ token: TOKEN, projectId: 'p1', path: 'missing-uniqueish.qzx' }));
    expect(res.status).toBe(404);
  });
});
