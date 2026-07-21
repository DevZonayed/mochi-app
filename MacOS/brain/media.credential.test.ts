/* The FAL credential boundary, at the media engine.

   A stored fal key that decodes to U+FFFD mojibake (a wrong-signature Keychain
   entry decrypted by the WebKit passthrough shim) must NEVER reach fetch's
   Headers — that throws a cryptic native "Cannot convert argument to a
   ByteString" TypeError (the exact production failure). Instead the media
   engine must surface an actionable, secret-free "reconnect FAL" failure and
   never leave an asset stuck in `generating`. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaEngine } from './media.js';

/* A structural fake of the Store surface MediaEngine touches. */
function fakeStore() {
  const assets = new Map<string, Record<string, unknown>>();
  const events: Array<Record<string, unknown>> = [];
  let n = 0;
  const store = {
    createAsset: (a: Record<string, unknown>) => {
      const id = 'asset-' + ++n;
      const asset = { id, error: null, createdAt: 1_700_000_000_000, ...a };
      assets.set(id, asset);
      return asset;
    },
    updateAsset: (id: string, patch: Record<string, unknown>) => {
      const a = { ...assets.get(id), ...patch };
      assets.set(id, a);
      return a;
    },
    getAsset: (id: string) => assets.get(id),
    listAssets: () => [...assets.values()],
    getProject: () => undefined,
    pushEvent: (e: Record<string, unknown>) => { events.push(e); },
  };
  return { store, assets, events };
}

const ACTIONABLE = 'FAL credential is invalid or corrupted. Reconnect FAL in Settings.';
const MOJIBAKE = 'fal_' + '�'.repeat(6) + 'key'; // U+FFFD = 65533 > 255
const GOOD_KEY = 'fal_' + 'a1B2c3D4'.repeat(6);       // clean ASCII

afterEach(() => { vi.unstubAllGlobals(); });

describe('MediaEngine.generate — corrupt credential never reaches a header', () => {
  it('a U+FFFD key fails the asset with the actionable message, NOT a ByteString TypeError', async () => {
    const { store, events } = fakeStore();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const media = new MediaEngine(store as never, () => {}, () => MOJIBAKE);

    const asset = await media.generate({ projectId: null, modelKey: 'flux-schnell', prompt: 'a cat' });

    expect(asset.status).toBe('failed');
    expect(asset.error).toBe(ACTIONABLE);
    expect(String(asset.error)).not.toMatch(/ByteString/i);
    // it must fail BEFORE ever calling fetch (the header would throw natively)
    expect(fetchSpy).not.toHaveBeenCalled();
    // the failed asset is not stuck generating, and a Media failed event fired
    expect(events.some(e => String(e.title).startsWith('Media failed'))).toBe(true);
    // no secret bytes leak into the asset error or the pushed event
    expect(String(asset.error)).not.toContain(MOJIBAKE);
    expect(JSON.stringify(events)).not.toContain(MOJIBAKE);
  });

  it('a corrupt keyState (key withheld by the boundary) still fails as an asset, not a bare throw', async () => {
    const { store, events } = fakeStore();
    vi.stubGlobal('fetch', vi.fn());
    const media = new MediaEngine(store as never, () => {}, () => undefined, () => 'corrupt');

    const asset = await media.generate({ projectId: null, modelKey: 'flux-schnell', prompt: 'a dog' });

    expect(asset.status).toBe('failed');
    expect(asset.error).toBe(ACTIONABLE);
    expect(events.some(e => String(e.title).startsWith('Media failed'))).toBe(true);
  });

  it('a genuinely MISSING key throws the "Connect your fal.ai" 503 (no asset persisted)', async () => {
    const { store, assets } = fakeStore();
    vi.stubGlobal('fetch', vi.fn());
    const media = new MediaEngine(store as never, () => {}, () => undefined, () => 'missing');

    await expect(media.generate({ projectId: null, modelKey: 'flux-schnell', prompt: 'x' }))
      .rejects.toThrow(/Connect your fal\.ai/i);
    expect(assets.size).toBe(0); // nothing to persist when there's no credential at all
  });
});

describe('MediaEngine.generate — a valid key + Unicode prompt', () => {
  it('sends an ASCII/header-safe authorization header and keeps the Unicode prompt in the JSON body', async () => {
    const { store } = fakeStore();
    const captured: { headers?: Record<string, string>; body?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured.headers = init.headers as Record<string, string>;
      captured.body = init.body as string;
      return { ok: true, json: async () => ({ request_id: 'req-1', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' }) } as Response;
    }));
    const media = new MediaEngine(store as never, () => {}, () => GOOD_KEY);

    const prompt = 'a serene 日本庭園 with 🌸 and café lights';
    const asset = await media.generate({ projectId: null, modelKey: 'flux-schnell', prompt });

    expect(asset.status).toBe('generating');
    // the header is exactly `Key <asciiKey>` and every unit is a valid ByteString byte
    const auth = captured.headers?.authorization ?? '';
    expect(auth).toBe(`Key ${GOOD_KEY}`);
    for (let i = 0; i < auth.length; i++) expect(auth.charCodeAt(i)).toBeLessThanOrEqual(0xff);
    // the Unicode prompt travels in the JSON body, never in a header
    expect(captured.body).toContain('日本庭園');
    expect(JSON.stringify(captured.headers)).not.toContain('日本庭園');
  });
});
