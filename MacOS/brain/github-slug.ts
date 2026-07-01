/* GitHub slug helpers — turn a free-form project name into a valid repo slug,
   check whether it's already taken under the operator's account, and pick a
   non-colliding alternative (`name`, then `name-v2`, `name-v3`, …). All pure
   helpers: they take the token + an injectable fetch, never touch Electron or
   Keychain. Used by the GitHub-first new-project flow to keep the renderer
   responsive while typing. */

import { ghRequest, GhError } from './github.js';

type FetchImpl = typeof fetch;

/** Normalize a free-form display name into a valid GitHub repo slug.
    Rules (matching GitHub's own validation):
      - lowercase
      - non-alphanumeric runs collapse to a single `-`
      - leading/trailing `-` trimmed
      - hard cap at 100 characters (GitHub's limit)
      - empty/all-symbol inputs → 'project' (a safe placeholder that
        still passes GitHub's validation and lets the cascade do its job). */
export function slugify(name: string): string {
  const s = (name ?? '')
    .toString()
    .normalize('NFKD')               // strip diacritics: "naïve" → "naive"
    .replace(/\p{M}+/gu, '')         // combining marks (NFKD splits them out)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');             // trailing dashes from the slice
  return s || 'project';
}

export interface RepoSummary { fullName: string; private: boolean }

/** Is `owner/slug` free? 404 → available; 200 → taken (return the existing repo
    summary); any other status throws so the caller surfaces a real error
    instead of silently treating an outage as "available". */
export async function checkRepoAvailable(
  token: string,
  owner: string,
  slug: string,
  fetchImpl?: FetchImpl,
): Promise<{ available: boolean; existing?: RepoSummary }> {
  try {
    const r = await ghRequest<{ full_name: string; private: boolean }>({
      token, path: `/repos/${owner}/${slug}`, fetchImpl,
    });
    return { available: false, existing: { fullName: r.data.full_name, private: !!r.data.private } };
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return { available: true };
    throw e;
  }
}

/** Find a slug under `owner` that isn't taken yet. Strategy:
      1. If `base` is free, return it.
      2. Parallel-check `base-v2 … base-v5` (one round-trip's worth of work
         in parallel, covers the common case where one prior version exists).
      3. If all of those are taken, walk sequentially `v6 … v20`.
      4. Final fallback: `base-{shortHash}` (4-char base36, never collides
         in practice for a single user's namespace).
    On a transient API failure during the cascade we fall back to the hash
    rather than failing — the caller can still create *something*, and a
    follow-up create will surface a real GitHub error if it's not free. */
export async function suggestAvailableSlug(
  token: string,
  owner: string,
  base: string,
  fetchImpl?: FetchImpl,
): Promise<string> {
  const root = slugify(base);
  // Step 1: the bare slug.
  try {
    const probe = await checkRepoAvailable(token, owner, root, fetchImpl);
    if (probe.available) return root;
  } catch {
    // network blip — fall through to the cascade; the create call will be
    // the real source of truth either way.
  }

  // Step 2: parallel batch v2..v5.
  const fast = [2, 3, 4, 5].map(n => withSuffix(root, n));
  try {
    const results = await Promise.all(
      fast.map(s => checkRepoAvailable(token, owner, s, fetchImpl).catch(() => null)),
    );
    for (let i = 0; i < fast.length; i++) {
      const r = results[i];
      if (r && r.available) return fast[i];
    }
  } catch {
    /* fall through */
  }

  // Step 3: sequential v6..v20.
  for (let n = 6; n <= 20; n++) {
    const candidate = withSuffix(root, n);
    try {
      const r = await checkRepoAvailable(token, owner, candidate, fetchImpl);
      if (r.available) return candidate;
    } catch {
      // keep trying — a single transient error shouldn't doom the cascade.
    }
  }

  // Step 4: short-hash fallback.
  return withSuffix(root, randomShortHash());
}

/** Compose `base-v{n}` (or `base-{hash}`) while honouring GitHub's 100-char cap.
    If appending the suffix would overflow, the base is truncated from the right
    so the suffix is always intact. */
function withSuffix(base: string, suffix: number | string): string {
  const tail = typeof suffix === 'number' ? `-v${suffix}` : `-${suffix}`;
  const room = 100 - tail.length;
  return (base.length > room ? base.slice(0, room).replace(/-+$/g, '') : base) + tail;
}

/** 4-char base36 (~1.7M codepoints) — plenty for a per-account namespace. */
function randomShortHash(): string {
  return Math.random().toString(36).slice(2, 6) || 'x123';
}
