import { describe, expect, it } from 'vitest';
import {
  SHADOW_PROTOCOL_VERSION,
  decodeShadowMessage,
  decodeWebTunnelSession,
  planCacheResume,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = {
  accountId: 'acct_main',
  scopeId: 'scope_main',
  hostDeviceId: 'host_mac_1',
  epoch: 7,
  leaseId: 'lease_active',
} as const;

const request = (path: string): Record<string, unknown> => ({
  family: 'web-tunnel-http-request',
  v: SHADOW_PROTOCOL_VERSION,
  tunnelId: 'tun_1',
  requestId: 'req_1',
  method: 'GET',
  path,
  headers: { accept: '*/*' },
  createdAt: now,
  signature: 'sig_request',
});

const wsOpen = (path: string): Record<string, unknown> => ({
  family: 'web-tunnel-ws',
  v: SHADOW_PROTOCOL_VERSION,
  tunnelId: 'tun_1',
  streamId: 'stream_1',
  frameSeq: 1,
  kind: 'open',
  path,
  headers: { accept: '*/*' },
  createdAt: now,
  signature: 'sig_ws',
});

const session = (route: string): Record<string, unknown> => ({
  v: SHADOW_PROTOCOL_VERSION,
  tunnelId: 'tun_1',
  fence,
  projectId: 'proj_1',
  controllerDeviceId: 'ctrl_phone_1',
  allowedLoopbackPort: 5173,
  allowedOrigin: 'http://127.0.0.1:5173',
  route,
  expiresAt: now + 60_000,
});

describe('independent correction shared tunnel path canonicalization', () => {
  const expectRejectedEverywhere = (path: string) => {
    expect(decodeShadowMessage(request(path)).ok).toBe(false);
    expect(decodeShadowMessage(wsOpen(path)).ok).toBe(false);
    expect(decodeWebTunnelSession(session(path), now).ok).toBe(false);
  };

  const expectAcceptedEverywhere = (path: string) => {
    const decodedRequest = decodeShadowMessage(request(path));
    const decodedWs = decodeShadowMessage(wsOpen(path));
    const decodedSession = decodeWebTunnelSession(session(path), now);
    expect(decodedRequest.ok).toBe(true);
    expect(decodedWs.ok).toBe(true);
    expect(decodedSession.ok).toBe(true);
    if (!path.includes('%')) {
      if (decodedRequest.ok && decodedRequest.value.family === 'web-tunnel-http-request') expect(decodedRequest.value.path).toBe(path);
      if (decodedWs.ok && decodedWs.value.family === 'web-tunnel-ws') expect(decodedWs.value.path).toBe(path);
      if (decodedSession.ok) expect(decodedSession.value.route).toBe(path);
    }
  };

  it.each([
    ['web request double-encoded traversal repro', request('/%252e%252e/secret')],
    ['session route encoded traversal repro', session('/%2e%2e/secret')],
    ['ws open double-encoded traversal', wsOpen('/%252e%252e/secret')],
  ])('rejects %s', (_name, message) => {
    const result = 'family' in message ? decodeShadowMessage(message) : decodeWebTunnelSession(message, now);
    expect(result.ok).toBe(false);
  });

  it.each([
    '/preview',
    '/preview/index.html',
    '/preview/assets/app.js?cache=abc123',
    '/a-b_c~d.1/path?x=1&y=two',
  ])('preserves safe absolute route %s', (path) => {
    expectAcceptedEverywhere(path);
  });

  it.each([
    ['relative path', 'preview'],
    ['double slash authority', '//evil.test/path'],
    ['http scheme', 'http://127.0.0.1:5173/preview'],
    ['scheme after decode', '/http%3a//evil.test'],
    ['raw traversal', '/../secret'],
    ['dot traversal', '/./secret'],
    ['single-encoded traversal', '/%2e%2e/secret'],
    ['double-encoded traversal', '/%252e%252e/secret'],
    ['mixed dot traversal', '/%2e./secret'],
    ['encoded slash', '/safe%2fsecret'],
    ['double-encoded slash', '/safe%252fsecret'],
    ['encoded backslash', '/safe%5csecret'],
    ['double-encoded backslash', '/safe%255csecret'],
    ['raw backslash', '/safe\\secret'],
    ['nul', '/safe\u0000secret'],
    ['control', '/safe\u001fsecret'],
    ['fragment', '/safe#frag'],
    ['malformed percent', '/safe%zz'],
    ['dangling percent', '/safe%'],
    ['encoded authority', '/%2f%2fevil.test/path'],
  ])('rejects ambiguous or unsafe route %s', (_name, path) => {
    expectRejectedEverywhere(path);
  });

  it.each([
    ['double-encoded dot query repro', '/safe?next=%252e%252e'],
    ['single-encoded traversal value', '/safe?next=%2e%2e'],
    ['triple-encoded traversal value', '/safe?next=%25252e%25252e'],
    ['quad-encoded traversal value', '/safe?next=%2525252e%2525252e'],
    ['mixed encoded traversal value', '/safe?next=%2e.%2fsecret'],
    ['encoded slash value', '/safe?next=safe%2fsecret'],
    ['double-encoded slash value', '/safe?next=safe%252fsecret'],
    ['encoded backslash value', '/safe?next=safe%5csecret'],
    ['double-encoded backslash value', '/safe?next=safe%255csecret'],
    ['encoded traversal key', '/safe?%252e%252e=value'],
    ['encoded slash key', '/safe?safe%252fsecret=value'],
    ['malformed percent in query value', '/safe?next=%zz'],
    ['malformed percent in query key', '/safe?bad%zz=value'],
    ['repeated unsafe query key', '/safe?next=ok&next=%252e%252e'],
    ['encoded query delimiter reveals unsafe value', '/safe?next=ok%26escape=%252e%252e'],
    ['path-like redirect value', '/safe?next=..%252fsecret'],
    ['authority redirect value', '/safe?next=%252f%252fevil.test'],
    ['scheme redirect value', '/safe?next=http%253a%252f%252fevil.test'],
    ['javascript redirect value', '/safe?next=javascript:alert(1)'],
    ['encoded javascript redirect value', '/safe?next=javascript%3aalert(1)'],
    ['double-encoded javascript redirect value', '/safe?next=javascript%253aalert(1)'],
    ['data redirect value', '/safe?next=data:text/html,hi'],
    ['encoded data redirect value', '/safe?next=data%3atext/html,hi'],
    ['file redirect value', '/safe?next=file:'],
    ['blob redirect value', '/safe?next=blob:'],
    ['about redirect value', '/safe?next=about:blank'],
    ['mailto redirect value', '/safe?next=mailto:user@example.test'],
    ['ftp redirect value', '/safe?next=ftp:host'],
    ['ws redirect value', '/safe?next=ws:host'],
    ['wss redirect value', '/safe?next=wss:host'],
    ['custom plus scheme redirect value', '/safe?next=foo+bar:target'],
    ['mixed case scheme redirect value', '/safe?next=JaVaScRiPt:alert(1)'],
    ['encoded scheme key', '/safe?javascript%3aalert(1)=value'],
    ['double-encoded scheme key', '/safe?javascript%253aalert(1)=value'],
    ['whitespace-obfuscated scheme after decoding', '/safe?next=%20javascript%3aalert(1)'],
    ['userinfo redirect value', '/safe?next=user@evil.test'],
    ['host port redirect value', '/safe?next=evil.test:443'],
    ['raw path traversal value', '/safe?next=../secret'],
    ['raw backslash traversal value', '/safe?next=..\\secret'],
  ])('rejects structurally unsafe query %s', (_name, path) => {
    expectRejectedEverywhere(path);
  });

  it.each([
    '/safe?cache=abc123',
    '/safe?x=1&y=two',
    '/safe?label=caf%C3%A9',
    '/safe?mark=%E2%9C%93',
    '/safe?q=a%20b',
    '/safe?time=12:30',
    '/safe?created=2026-07-17T12:30:00',
    '/safe?ratio=16:9',
  ])('preserves safe scalar query %s', (path) => {
    expectAcceptedEverywhere(path);
  });

  it.each([
    ['root javascript target', '/javascript:alert(1)'],
    ['encoded root javascript target', '/javascript%3aalert(1)'],
    ['double-encoded root javascript target', '/javascript%253aalert(1)'],
    ['triple-encoded root javascript target', '/javascript%25253aalert(1)'],
    ['quad-encoded root javascript target', '/javascript%2525253aalert(1)'],
    ['root data target', '/data:text/html,hi'],
    ['root file target', '/file:'],
    ['root blob target', '/blob:'],
    ['root about target', '/about:blank'],
    ['root mailto target', '/mailto:user@example.test'],
    ['root ftp target', '/ftp:host'],
    ['root ws target', '/ws:host'],
    ['root wss target', '/wss:host'],
    ['root custom plus scheme target', '/foo+bar:target'],
    ['mixed case root scheme target', '/JaVaScRiPt:alert(1)'],
    ['nested javascript target', '/preview/javascript:alert(1)'],
    ['nested encoded javascript target', '/preview/javascript%3aalert(1)'],
    ['root userinfo target', '/user@evil.test'],
    ['nested userinfo target', '/a/user@evil.test'],
    ['encoded nested userinfo target', '/a/user%40evil.test'],
    ['root host port target', '/evil.test:443'],
    ['nested host port target', '/proxy/evil.test:443'],
    ['encoded nested host port target', '/proxy/evil.test%3a443'],
    ['localhost port target', '/localhost:3000'],
    ['IPv4 port target', '/127.0.0.1:3000'],
    ['bracketed IPv6 port target', '/[::1]:3000'],
    ['encoded bracketed IPv6 port target', '/%5b::1%5d%3a3000'],
    ['space-obfuscated path target after decode', '/%20javascript%3aalert(1)'],
    ['ambiguous scalar colon path segment', '/safe/time:12:30'],
    ['numeric scalar colon path segment', '/safe/12:30'],
    ['ratio scalar colon path segment', '/safe/16:9'],
    ['timestamp scalar colon path segment', '/safe/2026-07-17T12:30:00Z'],
    ['root numeric scalar colon segment', '/12:30'],
    ['root ratio scalar colon segment', '/16:9'],
    ['root timestamp scalar colon segment', '/2026-07-17T12:30:00Z'],
    ['encoded numeric scalar colon path segment', '/safe/12%3a30'],
    ['double-encoded numeric scalar colon path segment', '/safe/12%253a30'],
    ['triple-encoded numeric scalar colon path segment', '/safe/12%25253a30'],
    ['quad-encoded numeric scalar colon path segment', '/safe/12%2525253a30'],
    ['encoded root scalar colon segment', '/12%3a30'],
    ['double-encoded root scalar colon segment', '/12%253a30'],
    ['encoded ratio path segment', '/safe/16%3a9'],
    ['double-encoded timestamp path segment', '/safe/2026-07-17T12%253a30%253a00Z'],
  ])('rejects path segment redirect/proxy target %s', (_name, path) => {
    expectRejectedEverywhere(path);
  });

  it.each([
    '/safe/file.name',
  ])('preserves ordinary non-target path punctuation %s', (path) => {
    expectAcceptedEverywhere(path);
  });

  it.each([
    ['raw line separator', '/safe\u2028secret'],
    ['encoded line separator', '/safe%E2%80%A8secret'],
    ['raw paragraph separator', '/safe\u2029secret'],
    ['encoded paragraph separator', '/safe%E2%80%A9secret'],
    ['raw NEL', '/safe\u0085secret'],
    ['encoded NEL', '/safe%C2%85secret'],
    ['raw bidi override', '/safe\u202esecret'],
    ['encoded bidi override', '/safe%E2%80%AEsecret'],
    ['raw bidi isolate', '/safe\u2066secret'],
    ['encoded bidi isolate', '/safe%E2%81%A6secret'],
    ['raw zero width space', '/safe\u200bsecret'],
    ['encoded zero width space', '/safe%E2%80%8Bsecret'],
    ['raw BOM', '/safe\ufeffsecret'],
    ['encoded BOM', '/safe%EF%BB%BFsecret'],
    ['raw fullwidth slash', '/safe\uff0fsecret'],
    ['encoded fullwidth slash', '/safe%EF%BC%8Fsecret'],
    ['raw fullwidth backslash', '/safe\uff3csecret'],
    ['encoded fullwidth backslash', '/safe%EF%BC%BCsecret'],
    ['query line separator', '/safe?next=%E2%80%A8secret'],
    ['query bidi override', '/safe?next=%E2%80%AEsecret'],
    ['query fullwidth slash', '/safe?next=safe%EF%BC%8Fsecret'],
  ])('rejects Unicode control or separator ambiguity %s', (_name, path) => {
    expectRejectedEverywhere(path);
  });

  it.each([
    '/safe/বাংলা',
    '/safe/東京',
    '/safe/check✓',
    '/safe?label=বাংলা',
    '/safe?mark=✓',
  ])('preserves safe ordinary Unicode route %s', (path) => {
    expectAcceptedEverywhere(path);
  });
});

describe('independent correction tagged cache resume planner', () => {
  it('returns precise invalid reasons for independent repros', () => {
    expect(planCacheResume({ contentId: '../secret', totalBytes: 100, verifiedRanges: [] })).toEqual({ ok: false, reason: 'bad-content-id' });
    expect(planCacheResume({ contentId: 'cid_1', totalBytes: 100, verifiedRanges: [], requestedRange: { start: 80, endExclusive: 20 } })).toEqual({ ok: false, reason: 'bad-requested-range' });
  });

  it.each([
    ['empty content id', { contentId: '', totalBytes: 100, verifiedRanges: [] }, 'bad-content-id'],
    ['path content id', { contentId: '../secret', totalBytes: 100, verifiedRanges: [] }, 'bad-content-id'],
    ['zero total', { contentId: 'cid_1', totalBytes: 0, verifiedRanges: [] }, 'bad-total-bytes'],
    ['negative total', { contentId: 'cid_1', totalBytes: -1, verifiedRanges: [] }, 'bad-total-bytes'],
    ['unsafe total', { contentId: 'cid_1', totalBytes: Number.MAX_SAFE_INTEGER + 1, verifiedRanges: [] }, 'bad-total-bytes'],
    ['inverted requested range', { contentId: 'cid_1', totalBytes: 100, verifiedRanges: [], requestedRange: { start: 80, endExclusive: 20 } }, 'bad-requested-range'],
    ['zero requested range', { contentId: 'cid_1', totalBytes: 100, verifiedRanges: [], requestedRange: { start: 20, endExclusive: 20 } }, 'bad-requested-range'],
    ['out-of-bounds requested range', { contentId: 'cid_1', totalBytes: 100, verifiedRanges: [], requestedRange: { start: 0, endExclusive: 101 } }, 'bad-requested-range'],
    ['invalid verified range alone', { contentId: 'cid_1', totalBytes: 100, verifiedRanges: [{ start: 90, endExclusive: 80 }] }, 'bad-verified-range'],
    ['invalid verified mixed with valid', { contentId: 'cid_1', totalBytes: 100, verifiedRanges: [{ start: 0, endExclusive: 10 }, { start: 100, endExclusive: 101 }] }, 'bad-verified-range'],
  ] as const)('fails closed for %s', (_name, input, reason) => {
    expect(planCacheResume(input)).toEqual({ ok: false, reason });
  });

  it('normalizes duplicate, overlapping, adjacent, and out-of-order verified ranges', () => {
    const plan = planCacheResume({
      contentId: 'cid_1',
      totalBytes: 100,
      verifiedRanges: [
        { start: 40, endExclusive: 50 },
        { start: 0, endExclusive: 10 },
        { start: 10, endExclusive: 20 },
        { start: 5, endExclusive: 15 },
        { start: 70, endExclusive: 80 },
        { start: 70, endExclusive: 80 },
      ],
      requestedRange: { start: 0, endExclusive: 90 },
    });
    expect(plan).toEqual({
      ok: true,
      contentId: 'cid_1',
      requestedRange: { start: 0, endExclusive: 90 },
      missingRanges: [
        { start: 20, endExclusive: 40 },
        { start: 50, endExclusive: 70 },
        { start: 80, endExclusive: 90 },
      ],
    });
  });

  it('distinguishes fully verified success from invalid input', () => {
    expect(planCacheResume({
      contentId: 'cid_1',
      totalBytes: 100,
      verifiedRanges: [{ start: 0, endExclusive: 100 }],
    })).toEqual({
      ok: true,
      contentId: 'cid_1',
      requestedRange: { start: 0, endExclusive: 100 },
      missingRanges: [],
    });
  });

  it('computes missing ranges inside a partial requested subrange only', () => {
    expect(planCacheResume({
      contentId: 'cid_1',
      totalBytes: 1_000,
      verifiedRanges: [{ start: 0, endExclusive: 250 }, { start: 300, endExclusive: 450 }, { start: 900, endExclusive: 1_000 }],
      requestedRange: { start: 200, endExclusive: 500 },
    })).toEqual({
      ok: true,
      contentId: 'cid_1',
      requestedRange: { start: 200, endExclusive: 500 },
      missingRanges: [{ start: 250, endExclusive: 300 }, { start: 450, endExclusive: 500 }],
    });
  });
});
