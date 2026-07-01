import { describe, test, expect } from 'vitest';
import { slugify, checkRepoAvailable, suggestAvailableSlug } from './github-slug.js';

/** A fetch impl driven by a per-URL map. Tracks every call so we can assert
    ordering / parallelism downstream. */
function mapFetch(
  byPath: Record<string, { status: number; body?: unknown } | (() => { status: number; body?: unknown })>,
  hits: string[] = [],
): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    hits.push(u);
    // match by trailing path
    const key = Object.keys(byPath).find(k => u.endsWith(k));
    if (!key) return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({ message: `no route for ${u}` }) };
    const spec = byPath[key];
    const r = typeof spec === 'function' ? spec() : spec;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: () => null },
      json: async () => r.body ?? {},
    };
  }) as unknown as typeof fetch;
}

describe('slugify', () => {
  test('lowercases + dashes a normal name', () => {
    expect(slugify('My New App')).toBe('my-new-app');
  });
  test('collapses repeated non-alnum runs into a single dash', () => {
    expect(slugify('Hello!!  world__again')).toBe('hello-world-again');
  });
  test('strips leading/trailing punctuation', () => {
    expect(slugify('!!!hello!!!')).toBe('hello');
  });
  test('empty input → "project" placeholder (lets the cascade do its job)', () => {
    expect(slugify('')).toBe('project');
    expect(slugify(undefined as unknown as string)).toBe('project');
  });
  test('all-symbol input → "project"', () => {
    expect(slugify('!!!---!!!')).toBe('project');
  });
  test('strips diacritics so unicode names produce a clean ASCII slug', () => {
    expect(slugify('Naïve Résumé')).toBe('naive-resume');
  });
  test('caps at 100 chars without trailing dash', () => {
    const slug = slugify('a'.repeat(120));
    expect(slug.length).toBe(100);
    expect(slug.endsWith('-')).toBe(false);
  });
  test('drops chars github would reject (emoji, slashes, dots)', () => {
    expect(slugify('foo/bar.baz 🚀 qux')).toBe('foo-bar-baz-qux');
  });
});

describe('checkRepoAvailable', () => {
  test('404 → available', async () => {
    const f = mapFetch({ '/repos/o/r': { status: 404, body: { message: 'Not Found' } } });
    expect(await checkRepoAvailable('t', 'o', 'r', f)).toEqual({ available: true });
  });
  test('200 → taken, returns the existing repo summary', async () => {
    const f = mapFetch({ '/repos/o/r': { status: 200, body: { full_name: 'o/r', private: true } } });
    expect(await checkRepoAvailable('t', 'o', 'r', f)).toEqual({
      available: false, existing: { fullName: 'o/r', private: true },
    });
  });
  test('5xx propagates (so the UI never shows a stale "available")', async () => {
    const f = mapFetch({ '/repos/o/r': { status: 503, body: { message: 'unavailable' } } });
    await expect(checkRepoAvailable('t', 'o', 'r', f)).rejects.toThrow();
  });
});

describe('suggestAvailableSlug', () => {
  test('returns the bare base when nothing exists', async () => {
    const f = mapFetch({ '/repos/o/my-app': { status: 404 } });
    expect(await suggestAvailableSlug('t', 'o', 'My App', f)).toBe('my-app');
  });

  test('cascades to -v2 when the base is taken (and only the base + v2 are queried)', async () => {
    const hits: string[] = [];
    const f = mapFetch({
      '/repos/o/my-app':     { status: 200, body: { full_name: 'o/my-app', private: false } },
      '/repos/o/my-app-v2':  { status: 404 },
      '/repos/o/my-app-v3':  { status: 200, body: { full_name: 'o/my-app-v3', private: false } },
      '/repos/o/my-app-v4':  { status: 200, body: { full_name: 'o/my-app-v4', private: false } },
      '/repos/o/my-app-v5':  { status: 200, body: { full_name: 'o/my-app-v5', private: false } },
    }, hits);
    const r = await suggestAvailableSlug('t', 'o', 'My App', f);
    expect(r).toBe('my-app-v2');
    // base + the v2..v5 parallel batch (5 calls total, no sequential walk).
    expect(hits.length).toBe(5);
  });

  test('returns -v3 when base and -v2 are taken', async () => {
    const f = mapFetch({
      '/repos/o/my-app':     { status: 200, body: { full_name: 'o/my-app', private: false } },
      '/repos/o/my-app-v2':  { status: 200, body: { full_name: 'o/my-app-v2', private: false } },
      '/repos/o/my-app-v3':  { status: 404 },
      '/repos/o/my-app-v4':  { status: 200, body: { full_name: 'o/my-app-v4', private: false } },
      '/repos/o/my-app-v5':  { status: 200, body: { full_name: 'o/my-app-v5', private: false } },
    });
    expect(await suggestAvailableSlug('t', 'o', 'My App', f)).toBe('my-app-v3');
  });

  test('walks v6..v20 sequentially once the parallel batch is exhausted', async () => {
    const taken = new Set<string>(['my-app', 'my-app-v2', 'my-app-v3', 'my-app-v4', 'my-app-v5']);
    // free up v8 specifically — we expect the walk to land there.
    const f = (async (url: string) => {
      const m = String(url).match(/\/repos\/o\/(.+)$/);
      const slug = m?.[1] ?? '';
      const isFree = !taken.has(slug) && slug === 'my-app-v8';
      const status = isFree ? 404 : (taken.has(slug) ? 200 : 200);
      return {
        status, ok: status === 200,
        headers: { get: () => null },
        json: async () => ({ full_name: `o/${slug}`, private: false }),
      };
    }) as unknown as typeof fetch;
    expect(await suggestAvailableSlug('t', 'o', 'My App', f)).toBe('my-app-v8');
  });

  test('falls back to a short-hash suffix when v2..v20 are ALL taken', async () => {
    const f = (async (url: string) => {
      // anything we ask about is "taken" — forces step 4.
      return {
        status: 200, ok: true,
        headers: { get: () => null },
        json: async () => ({ full_name: 'o/whatever', private: false }),
      };
    }) as unknown as typeof fetch;
    const r = await suggestAvailableSlug('t', 'o', 'My App', f);
    // expected shape: my-app-{4 base36 chars}
    expect(r).toMatch(/^my-app-[a-z0-9]{3,4}$/);
  });

  test('a transient error on the bare-base check does not abort the cascade', async () => {
    let firstCall = true;
    const f = (async (url: string) => {
      if (firstCall && String(url).endsWith('/repos/o/my-app')) {
        firstCall = false;
        return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({ message: 'flap' }) };
      }
      if (String(url).endsWith('/repos/o/my-app-v2')) {
        return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
      }
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ full_name: 'o/x', private: false }) };
    }) as unknown as typeof fetch;
    expect(await suggestAvailableSlug('t', 'o', 'My App', f)).toBe('my-app-v2');
  });
});
