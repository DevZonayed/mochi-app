/* repo-metadata — fetch GitHub repo metadata via the gh CLI so the "Clone
   from GitHub" tab can show a confirmation card (description, default branch,
   private/public) before the clone runs. Pure module: takes an injected
   runner so it's unit-testable without touching the network or shelling out. */

import { execFile } from 'node:child_process';

export interface RepoMetadata {
  name: string;
  fullName: string;       // "owner/repo" as GitHub canonicalises it
  description: string;    // empty string when GitHub returns null
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  sshUrl: string;
}

/** A pluggable command runner so tests can supply canned stdout instead of
    spawning a process. Returns gh's stdout text (empty string on success
    with no body) or throws an Error with `.stderr` populated. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

/** Default runner — shells out to the bundled `gh` binary. */
export function makeGhRunner(ghPath: string): GhRunner {
  return (args) =>
    new Promise<string>((resolve, reject) => {
      execFile(ghPath, args as string[], { timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) { (err as Error & { stderr?: string }).stderr = String(stderr || ''); reject(err); return; }
        resolve(String(stdout || ''));
      });
    });
}

/** Friendly mapping from gh's raw failure modes to actionable messages. */
function normaliseGhError(err: unknown): Error {
  const e = err as Error & { stderr?: string; code?: number };
  const tail = (e.stderr || e.message || '').toLowerCase();
  if (tail.includes('http 404') || tail.includes('not found')) {
    return Object.assign(new Error('Repository not found. Check the owner/repo spelling — or, if it is private, sign in to GitHub first.'), { statusCode: 404 });
  }
  if (tail.includes('http 401') || tail.includes('unauthorized') || tail.includes('authentication')) {
    return Object.assign(new Error('GitHub authentication needed to view this repo. Run "gh auth login" or sign in from Settings.'), { statusCode: 401 });
  }
  if (tail.includes('could not resolve host') || tail.includes('network') || tail.includes('connection')) {
    return Object.assign(new Error('Network error reaching GitHub. Check your connection.'), { statusCode: 503 });
  }
  return Object.assign(new Error(e.message || 'Failed to reach GitHub.'), { statusCode: 500 });
}

/** Coerce gh's JSON shape into a safe, fully-populated RepoMetadata. We
    accept any extra fields silently and only require the four we surface. */
function fromGhJson(json: unknown, fallbackOwner: string, fallbackRepo: string): RepoMetadata {
  const j = (json && typeof json === 'object') ? json as Record<string, unknown> : {};
  const name = typeof j.name === 'string' && j.name ? j.name : fallbackRepo;
  const owner = (() => {
    const o = j.owner as Record<string, unknown> | undefined;
    if (o && typeof o.login === 'string' && o.login) return o.login;
    if (typeof j.nameWithOwner === 'string' && j.nameWithOwner.includes('/')) return j.nameWithOwner.split('/')[0];
    return fallbackOwner;
  })();
  const description = typeof j.description === 'string' ? j.description : '';
  const defaultBranch =
    (typeof j.defaultBranchRef === 'object' && j.defaultBranchRef && typeof (j.defaultBranchRef as Record<string, unknown>).name === 'string')
      ? String((j.defaultBranchRef as Record<string, unknown>).name)
      : (typeof j.defaultBranch === 'string' ? j.defaultBranch : 'main');
  const isPrivate = j.isPrivate === true || j.private === true;
  return {
    name,
    fullName: `${owner}/${name}`,
    description,
    defaultBranch,
    isPrivate,
    htmlUrl: `https://github.com/${owner}/${name}`,
    sshUrl: `git@github.com:${owner}/${name}.git`,
  };
}

/** Fetch metadata for `owner/repo` via gh. Injectable runner = unit-testable. */
export async function fetchRepoMetadata(
  owner: string, repo: string, runner: GhRunner,
): Promise<RepoMetadata> {
  if (!owner || !repo) throw Object.assign(new Error('owner and repo are required'), { statusCode: 400 });
  try {
    // `gh repo view` with explicit JSON fields gives us a stable, narrow shape.
    const stdout = await runner([
      'repo', 'view', `${owner}/${repo}`,
      '--json', 'name,owner,description,defaultBranchRef,isPrivate,nameWithOwner',
    ]);
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); }
    catch { throw Object.assign(new Error('GitHub returned an unexpected response.'), { statusCode: 502 }); }
    return fromGhJson(parsed, owner, repo);
  } catch (e) {
    if ((e as Error & { statusCode?: number }).statusCode) throw e;
    throw normaliseGhError(e);
  }
}
