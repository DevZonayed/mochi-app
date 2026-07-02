/* Memory repository sync — mirrors every project's `.continuum` memory
   (STATE.md + checkpoint chain) into ONE private GitHub repo so memory
   survives machine loss and is shareable across the operator's Macs.

   Layout inside the memory repo:

     projects/<project-slug>/<github-login>/STATE.md
     projects/<project-slug>/<github-login>/chain/...
     projects/<project-slug>/<github-login>/project.json

   The <github-login> namespace is the MULTI-DEVELOPER conflict answer:
   two developers working on the same project each sync into their OWN
   subtree, so their memory never collides — while both can still read the
   teammate's state by browsing the repo. Combined with `.continuum/` being
   excluded from the project repo itself (repo-provision.ensureContinuumExcluded),
   project-memory merge conflicts become structurally impossible.

   The repo location (personal profile vs an organization) and name come
   from Settings (memoryRepoOwner / memoryRepoName). The local mirror lives
   at ~/Maestro/memory/<owner>__<repo>. All pushes are token-authenticated via
   GIT_ASKPASS — the token never lands in argv or git config. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Store, Project } from './store.js';
import type { Providers } from './providers.js';
import { resolveGit, buildAskpassScript } from './git.js';
import { createRepo, repoExists, getViewer } from './github.js';

type Emit = (name: string, data: unknown, opts?: { live?: boolean; desktopOnly?: boolean }) => void;

/** Stable, filesystem/GitHub-safe folder slug for a project inside the memory
    repo: readable name + a short id suffix so renames/duplicates never collide. */
export function memoryProjectSlug(p: Pick<Project, 'id' | 'name'>): string {
  const base = (p.name || 'project').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  return `${base}-${String(p.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()}`;
}

export interface MemorySyncStatus {
  enabled: boolean;
  fullName?: string;
  lastSyncAt?: number;
  lastError?: string;
  syncing?: boolean;
}

export class MemorySync {
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = false;
  private queue: string[] = [];
  private login: string | null = null;
  private status: MemorySyncStatus = { enabled: false };

  constructor(private store: Store, private providers: Providers, private emit: Emit) {}

  private token(): string | undefined { return this.providers.getLocalKey('github'); }
  private settings() {
    const s = this.store.getSettings();
    return {
      enabled: s.memorySyncEnabled !== false, // default ON — memory must not be a single-Mac asset
      owner: (s.memoryRepoOwner ?? '').trim(),
      name: (s.memoryRepoName ?? '').trim() || 'maestro-memory',
    };
  }

  getStatus(): MemorySyncStatus { return { ...this.status, enabled: this.settings().enabled }; }

  private setStatus(patch: Partial<MemorySyncStatus>): void {
    this.status = { ...this.status, ...patch, enabled: this.settings().enabled };
    try { this.emit('memory-sync', this.status, { desktopOnly: true }); } catch { /* UI-only */ }
  }

  /** Local mirror folder for the configured memory repo. */
  mirrorDir(owner: string, name: string): string {
    return path.join(homedir(), 'Maestro', 'memory', `${owner}__${name}`.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }

  private git(dir: string, args: string[], opts: { timeout?: number; auth?: boolean } = {}): { ok: boolean; out: string } {
    const bin = resolveGit();
    if (!bin) return { ok: false, out: 'git is not installed' };
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    let askpass: string | undefined;
    try {
      if (opts.auth) {
        const token = this.token();
        if (!token) return { ok: false, out: 'connect GitHub first' };
        askpass = path.join(tmpdir(), `mst-mem-askpass-${process.pid}-${Date.now()}.sh`);
        writeFileSync(askpass, buildAskpassScript(), { mode: 0o700 });
        env.GIT_ASKPASS = askpass;
        env.GIT_TOKEN = token;
      }
      const out = execFileSync(bin, dir ? ['-C', dir, ...args] : args, { encoding: 'utf8', timeout: opts.timeout ?? 60_000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      return { ok: true, out };
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      const stderr = err.stderr == null ? (err.message ?? '') : typeof err.stderr === 'string' ? err.stderr : err.stderr.toString();
      return { ok: false, out: stderr.trim().slice(0, 400) };
    } finally {
      if (askpass) { try { rmSync(askpass, { force: true }); } catch { /* ignore */ } }
    }
  }

  /** GitHub login of the token owner (cached) — the per-developer namespace. */
  private async ghLogin(): Promise<string | null> {
    if (this.login) return this.login;
    const token = this.token();
    if (!token) return null;
    try { this.login = (await getViewer(token)).login || null; } catch { this.login = null; }
    return this.login;
  }

  /** Ensure the memory repo exists on GitHub AND is cloned/fresh locally.
      Creates the repo (private, auto-init so a default branch exists) under
      the personal account or the configured organization. */
  async ensureRepo(): Promise<{ ok: boolean; dir?: string; fullName?: string; reason?: string }> {
    const { enabled, owner, name } = this.settings();
    if (!enabled) return { ok: false, reason: 'memory sync is disabled in Settings' };
    const token = this.token();
    if (!token) return { ok: false, reason: 'connect GitHub first' };
    const login = await this.ghLogin();
    if (!login) return { ok: false, reason: 'could not resolve the GitHub user' };
    const repoOwner = owner || login;
    const fullName = `${repoOwner}/${name}`;
    try {
      const exists = await repoExists(token, repoOwner, name);
      if (!exists) {
        await createRepo(token, name, { private: true, org: owner || undefined, autoInit: true, description: 'Maestro project memory (auto-synced .continuum state)' });
        this.store.pushEvent({ kind: 'memory-repo-created', title: `Memory repository created: ${fullName}` });
      }
    } catch (e) {
      return { ok: false, reason: `GitHub: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
    }
    // Local mirror: clone once, then keep fresh with pull --rebase.
    const dir = this.mirrorDir(repoOwner, name);
    if (!existsSync(path.join(dir, '.git'))) {
      mkdirSync(path.dirname(dir), { recursive: true });
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      const clone = this.git('', ['clone', '--quiet', `https://github.com/${fullName}.git`, dir], { auth: true, timeout: 120_000 });
      if (!clone.ok) return { ok: false, reason: `clone failed: ${clone.out}` };
    } else {
      // Best-effort freshen; a temporarily-offline pull must not block the commit.
      this.git(dir, ['pull', '--rebase', '--quiet'], { auth: true });
    }
    this.setStatus({ fullName });
    return { ok: true, dir, fullName };
  }

  /** Debounced sync — call after every checkpoint/STATE write. Trailing edge
      so a burst of turns produces one commit. */
  scheduleSync(projectId: string, delayMs = 15_000): void {
    if (!this.settings().enabled) return;
    const t = this.timers.get(projectId);
    if (t) clearTimeout(t);
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      void this.syncProject(projectId).catch(() => { /* logged in status */ });
    }, delayMs));
  }

  /** Copy the project's .continuum into the mirror under the per-dev namespace,
      commit, pull --rebase, push. Serialized — one sync at a time. */
  async syncProject(projectId: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.busy) { if (!this.queue.includes(projectId)) this.queue.push(projectId); return { ok: true, reason: 'queued' }; }
    this.busy = true;
    this.setStatus({ syncing: true });
    try {
      const project = this.store.getProject(projectId);
      if (!project?.path) return { ok: false, reason: 'project has no folder' };
      const contDir = path.join(project.path, '.continuum');
      if (!existsSync(contDir)) return { ok: true, reason: 'no memory yet' };

      const repo = await this.ensureRepo();
      if (!repo.ok || !repo.dir) { this.setStatus({ lastError: repo.reason }); return { ok: false, reason: repo.reason }; }
      const login = (await this.ghLogin())!;
      const slug = memoryProjectSlug(project);
      const dest = path.join(repo.dir, 'projects', slug, login);

      // Mirror STATE.md + chain (NOT Attachment/ — attachments can be huge
      // binaries; memory text is what must survive).
      try { rmSync(path.join(dest, 'STATE.md'), { force: true }); rmSync(path.join(dest, 'chain'), { recursive: true, force: true }); } catch { /* ignore */ }
      mkdirSync(dest, { recursive: true });
      for (const entry of ['STATE.md', 'chain'] as const) {
        const src = path.join(contDir, entry);
        if (existsSync(src)) cpSync(src, path.join(dest, entry), { recursive: true });
      }
      writeFileSync(path.join(dest, 'project.json'), JSON.stringify({
        name: project.name, projectId: project.id, machine: hostname(), path: project.path, syncedAt: new Date().toISOString(),
      }, null, 2) + '\n', 'utf8');

      const add = this.git(repo.dir, ['add', '-A']);
      if (!add.ok) { this.setStatus({ lastError: add.out }); return { ok: false, reason: add.out }; }
      const staged = this.git(repo.dir, ['diff', '--cached', '--quiet']);
      if (staged.ok) { this.setStatus({ lastSyncAt: Date.now(), lastError: undefined }); return { ok: true, reason: 'nothing new' }; }
      const commit = this.git(repo.dir, ['-c', 'user.name=Maestro Memory', `-c`, `user.email=${login}@users.noreply.github.com`, 'commit', '-q', '-m', `memory(${slug}): checkpoint from ${hostname()}`]);
      if (!commit.ok) { this.setStatus({ lastError: commit.out }); return { ok: false, reason: commit.out }; }
      // Push; a rejected push (another Mac/dev synced first) rebases + retries once.
      let push = this.git(repo.dir, ['push', '--quiet'], { auth: true, timeout: 120_000 });
      if (!push.ok) {
        this.git(repo.dir, ['pull', '--rebase', '--quiet'], { auth: true });
        push = this.git(repo.dir, ['push', '--quiet'], { auth: true, timeout: 120_000 });
      }
      if (!push.ok) { this.setStatus({ lastError: push.out }); return { ok: false, reason: push.out }; }
      this.setStatus({ lastSyncAt: Date.now(), lastError: undefined });
      return { ok: true };
    } finally {
      this.busy = false;
      this.setStatus({ syncing: false });
      const next = this.queue.shift();
      if (next) void this.syncProject(next).catch(() => { /* status carries it */ });
    }
  }

  /** Boot sweep: sync every project that has memory on disk. Staggered so the
      app start isn't dominated by git traffic. */
  async syncAll(): Promise<void> {
    if (!this.settings().enabled || !this.token()) return;
    for (const p of this.store.listProjects()) {
      if (p.path && existsSync(path.join(p.path, '.continuum'))) {
        await this.syncProject(p.id).catch(() => { /* keep sweeping */ });
      }
    }
  }
}
