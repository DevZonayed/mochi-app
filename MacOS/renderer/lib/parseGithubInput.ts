/* parseGithubInput — accept the many ways a human pastes a repo identifier.
   The add-project "Clone from GitHub" tab takes ONE input and figures out
   owner/repo so the user doesn't have to think about URL shape:

     - owner/repo                                      → { owner, repo }
     - https://github.com/owner/repo                   → { owner, repo }
     - https://github.com/owner/repo.git               → { owner, repo }
     - git@github.com:owner/repo.git                   → { owner, repo }
     - ssh://git@github.com/owner/repo.git             → { owner, repo }
     - https://github.com/owner/repo/pull/123          → { owner, repo }
     - https://github.com/owner/repo/tree/main/foo     → { owner, repo }

   Anything else (gibberish, lone token, bare URL with no path) → null.
   Pure function, no node deps — safe to import from renderer and tests. */

export interface GithubRepoRef { owner: string; repo: string }

/** Owner/repo identifiers are loose on case but constrained on chars; we
    accept the same set GitHub itself enforces so we don't false-positive
    on slashes that aren't actually repo slugs. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** GitHub-flavoured tail trim: drop trailing `.git`, slashes, query, hash. */
function cleanRepoSegment(raw: string): string {
  return raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

/** Strict validator — returns the pair only if BOTH segments look like real
    GitHub identifiers, so we never fire a clone against a typo'd URL. */
function pair(owner: string, repo: string): GithubRepoRef | null {
  const o = owner.trim(); const r = cleanRepoSegment(repo);
  if (!o || !r) return null;
  if (!SEGMENT.test(o) || !SEGMENT.test(r)) return null;
  // GitHub rejects names that are just dots — mirror that so we don't try.
  if (/^\.+$/.test(o) || /^\.+$/.test(r)) return null;
  return { owner: o, repo: r };
}

export function parseGithubInput(text: string): GithubRepoRef | null {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;

  // 1) SSH form:  git@github.com:owner/repo(.git)?
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) return pair(ssh[1], ssh[2]);

  // 2) ssh:// or https:// (or bare github.com URLs) — pull out the path and
  //    take only the first two segments; anything after (pull/123, tree/main,
  //    blob/…) is repo-internal and safely ignored.
  //    Accept github.com with or without scheme, with or without `www.`, and
  //    with an optional `<user>@` userinfo (covers ssh://git@github.com/…).
  const urlMatch = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/?#]+)(?:[/?#].*)?$/.exec(s);
  if (urlMatch) return pair(urlMatch[1], urlMatch[2]);

  // 3) Bare "owner/repo" — exactly one slash, two valid segments, no scheme.
  //    Rejects "foo", "foo/bar/baz", "http://x", and other unintended inputs.
  if (!/[\s:]/.test(s) && (s.match(/\//g)?.length === 1)) {
    const [o, r] = s.split('/');
    return pair(o, r);
  }

  return null;
}

/** The HTTPS clone URL we hand to git/gh; always normalised (no .git suffix
    needed since git tolerates both, and the cleaner form is friendlier to
    show in error toasts). */
export function githubHttpsUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}
