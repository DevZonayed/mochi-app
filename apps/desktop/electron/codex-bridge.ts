/* Codex ⇄ Maestro tool bridge.
   Codex can't host an in-process MCP (unlike Claude), so to give it the SAME
   skill-registry and background-task tools Claude has, we register a per-run stdio
   MCP that codex launches. That MCP is a thin shim (embedded below, written to disk
   at boot, run via Electron's own node so there's no PATH dependency in a packaged
   app). The shim speaks MCP to codex on stdio and forwards every tool call to THIS
   process over a local unix socket, where the tools execute in-process.

   Proven (probe, 2026-06-14): codex reaches a `-c mcp_servers.<name>={…}` server
   and the result round-trips, but ONLY at `-s danger-full-access -c
   approval_policy=never` (its sandbox auto-cancels MCP tool calls otherwise). The
   shim command/args/env are all honoured. runCodex applies those flags whenever the
   bridge is registered (parity with Claude, which already runs bypassPermissions). */

import { app } from 'electron';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Store } from './store.js';
import type { BgTaskRecord } from './engine.js';
import type { GitCtx } from './git-ctx.js';
import { registryBase, searchRegistry, getRegistrySkill, fetchSkillContent, installSkillFiles, removeSkillFiles } from './skills-registry.js';
import { nextActionFor } from './git-ctx.js';

/** Background-task hooks injected from main.ts — the engine OWNS the processes; the
    bridge just forwards Codex's tool calls to it (Claude reaches the same manager via
    its in-process MCP server). Signatures mirror LocalEngine's bg* methods. */
export interface BridgeBg {
  start(opts: { projectId: string | null; sessionId: string | null; command: string; cwd: string }): BgTaskRecord;
  output(id: string, tailKB?: number): { record: BgTaskRecord; output: string } | null;
  list(projectId: string | null): BgTaskRecord[];
  stop(id: string): BgTaskRecord | null;
}

/** A registered codex run: the project its tools target + the optional
    per-session git/PR ctx (only present for chat turns on a GitHub repo). */
interface RunReg { projectId: string | null; skills: boolean; bg: boolean; git?: GitCtx }
interface RunOptions { skills?: boolean; bg?: boolean; git?: GitCtx }

/** Handle returned to runCodex: the codex `-c` config to add. */
export interface CodexRunRegistration {
  /** The `mcp_servers.maestro={…}` TOML value to pass via `-c`. */
  mcpServerConfig: string;
  /** Invalidate the run token (call once the codex run finishes). */
  release(): void;
}

const TOOL_NAMES = [
  'search_skills', 'get_skill', 'download_skill', 'add_skill_to_project',
  'list_project_skills', 'remove_project_skill',
  'run_in_background', 'background_output', 'list_background', 'stop_background',
  'git_status', 'git_push', 'pr_create', 'pr_merge', 'pr_resolve_conflicts', 'branch_rename',
] as const;

const txt = (s: string) => ({ content: [{ type: 'text', text: s }] });
const errRes = (s: string) => ({ content: [{ type: 'text', text: s }], isError: true });
const tomlStr = (s: string) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export class CodexBridge {
  private server?: net.Server;
  private sockDir: string;
  private sockPath: string;
  private shimPath: string;
  private runs = new Map<string, RunReg>();
  private bgHooks?: BridgeBg;
  /** Wire the engine's background-task manager (from main.ts, after both exist). */
  setBg(bg: BridgeBg) { this.bgHooks = bg; }

  constructor(private store: Store) {
    // Socket lives in a 0700 dir we own (not world-traversable /tmp), so it's never
    // even briefly group/other-connectable; keep the path short (macOS caps unix
    // socket paths ~104 chars) and per-pid to avoid cross-instance clashes.
    this.sockDir = path.join(app.getPath('userData'), 'sock');
    this.sockPath = path.join(this.sockDir, `br-${process.pid}.sock`);
    this.shimPath = path.join(app.getPath('userData'), 'maestro-mcp-shim.cjs');
  }

  /** Materialise the shim on disk + start the local socket server. */
  start(): void {
    try { writeFileSync(this.shimPath, SHIM_SRC, 'utf8'); } catch { /* will fail loudly when codex can't find it */ }
    try { mkdirSync(this.sockDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    try { unlinkSync(this.sockPath); } catch { /* no stale socket */ }
    this.server = net.createServer((conn) => this.onConnection(conn));
    this.server.on('error', () => { /* port/path in use — codex runs will report the failure */ });
    try { this.server.listen(this.sockPath, () => { try { chmodSync(this.sockPath, 0o600); } catch { /* best effort */ } }); } catch { /* listen failed */ }
  }

  stop(): void {
    try { this.server?.close(); } catch { /* already closed */ }
    try { unlinkSync(this.sockPath); } catch { /* gone */ }
  }

  /** Register a codex run: returns the `-c mcp_servers` config. */
  register(projectId: string | null, opts: RunOptions = { skills: true, bg: true }): CodexRunRegistration {
    const token = randomBytes(18).toString('hex');
    const reg: RunReg = { projectId, skills: !!opts.skills, bg: !!opts.bg, git: opts.git };
    this.runs.set(token, reg);
    // Run the shim via Electron's own node (always present; no PATH dependency).
    // The per-run token goes in the MCP server's ENV (not the shim's argv) so it
    // isn't exposed in the shim's `ps` output; the 0700-dir 0600 socket is the
    // primary boundary.
    const args = `[${tomlStr(this.shimPath)}, ${tomlStr(this.sockPath)}]`;
    const mcpServerConfig =
      `mcp_servers.maestro={ command = ${tomlStr(process.execPath)}, args = ${args}, env = { ELECTRON_RUN_AS_NODE = "1", MAESTRO_TOKEN = ${tomlStr(token)} } }`;
    return { mcpServerConfig, release: () => { this.runs.delete(token); } };
  }

  private onConnection(conn: net.Socket): void {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) void this.handle(conn, line);
      }
    });
    conn.on('error', () => { /* shim went away mid-call */ });
  }

  private async handle(conn: net.Socket, line: string): Promise<void> {
    let msg: { id?: number; token?: string; tool?: string; args?: Record<string, unknown> };
    try { msg = JSON.parse(line); } catch { return; }
    const reply = (payload: Record<string, unknown>) => { try { conn.write(JSON.stringify({ id: msg.id, ...payload }) + '\n'); } catch { /* shim gone */ } };
    const reg = msg.token ? this.runs.get(msg.token) : undefined;
    if (!reg) { reply({ ok: true, result: errRes('session is no longer authorised') }); return; }
    try {
      const result = await this.runTool(reg, String(msg.tool ?? ''), msg.args ?? {});
      reply({ ok: true, result });
    } catch (e) {
      reply({ ok: true, result: errRes(e instanceof Error ? e.message : String(e)) });
    }
  }

  /** Execute an MCP tool call in-process (codex's projectId comes from the trusted
      registration, never the wire). */
  private async runTool(reg: RunReg, tool: string, a: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const pid = reg.projectId;
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const projectRoot = () => {
      if (!pid) throw new Error('project skill tools require a project');
      const p = this.store.getProject(pid);
      if (!p) throw new Error('project not found');
      if (p.path && existsSync(p.path)) return p.path;
      const safe = (p.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
      return path.join(homedir(), 'Maestro', safe);
    };
    switch (tool) {
      case 'search_skills': {
        if (!reg.skills) return errRes('skill tools are not enabled for this run');
        const r = await searchRegistry(registryBase(), String(a.query ?? ''), n(a.limit) ?? 8);
        if (!r.results.length) return txt(`No skills found for "${a.query ?? ''}".`);
        return txt(r.results.map(x => `- ${x.id} — ${x.name}: ${x.description || '(no description)'} [risk=${x.risk}${x.version ? `, version=${x.version}` : ''}${x.sha256 ? `, sha256=${x.sha256.slice(0, 12)}` : ''}${x.sourceRepo ? `, source=${x.sourceRepo}` : ''}${x.sourceStatus ? `, sourceStatus=${x.sourceStatus}` : ''}]`).join('\n'));
      }
      case 'get_skill': {
        if (!reg.skills) return errRes('skill tools are not enabled for this run');
        const x = await getRegistrySkill(registryBase(), String(a.skillId ?? ''));
        return txt(`${x.id} — ${x.name}\n${x.description || ''}\nrisk=${x.risk}\nenabled=${x.enabled !== false}\nversion=${x.version ?? 'latest'}\nsha256=${x.sha256 ?? ''}\nsourceRepo=${x.sourceRepo ?? x.id.split('/').slice(0, 2).join('/')}\nsourceStatus=${x.sourceStatus ?? ''}\nsource=${x.source}\ndirectory=${x.directory}\naudit=${x.auditStatus ?? ''}\n\n${x.excerpt ? `Excerpt:\n${x.excerpt}` : ''}`);
      }
      case 'download_skill': {
        if (!reg.skills) return errRes('skill tools are not enabled for this run');
        const c = await fetchSkillContent(registryBase(), String(a.skillId ?? ''));
        const body = c.skillMd.length > 32000 ? c.skillMd.slice(0, 32000) + '\n\n[truncated by Maestro after 32000 characters]' : c.skillMd;
        return txt(`# ${c.name}\n\nid=${c.id}\nsha256=${c.sha256 ?? 'unknown'}\n\n${body}`);
      }
      case 'add_skill_to_project': {
        if (!reg.skills) return errRes('skill tools are not enabled for this run');
        if (!pid) return errRes('project skill tools require a project');
        const skillId = String(a.skillId ?? '');
        const base = registryBase();
        const [content, meta] = await Promise.all([
          fetchSkillContent(base, skillId),
          getRegistrySkill(base, skillId).catch(() => null),
        ]);
        const root = projectRoot();
        mkdirSync(root, { recursive: true });
        const slug = installSkillFiles(root, skillId, content.skillMd);
        const rec = this.store.recordSkillInstall(pid, {
          id: skillId,
          slug,
          name: meta?.name || content.name,
          description: meta?.description,
          risk: meta?.risk,
          source: meta?.source,
          version: meta?.version || 'latest',
          sha256: content.sha256,
          enabled: content.enabled !== false && meta?.enabled !== false,
          disabledReason: meta?.disabledReason,
          mirrorRepo: meta?.sourceRepo ?? meta?.mirrorRepo,
          auditStatus: meta?.auditStatus,
          addedBy: 'agent',
        });
        return txt(`Installed "${rec.name}" -> .claude/skills/${rec.slug}/SKILL.md${rec.sha256 ? ` (sha256 ${rec.sha256.slice(0, 12)})` : ''}. Read that file before using the skill.`);
      }
      case 'list_project_skills': {
        if (!reg.skills) return errRes('skill tools are not enabled for this run');
        if (!pid) return errRes('project skill tools require a project');
        const rows = this.store.listInstalledSkills(pid);
        return txt(rows.length ? rows.map(x => `- ${x.id} — ${x.name} (.claude/skills/${x.slug}/SKILL.md${x.version ? `, version=${x.version}` : ''}${x.sha256 ? `, sha256=${x.sha256.slice(0, 12)}` : ''}${x.risk ? `, risk=${x.risk}` : ''})`).join('\n') : 'No skills are installed in this project yet.');
      }
      case 'remove_project_skill': {
        if (!reg.skills) return errRes('skill tools are not enabled for this run');
        if (!pid) return errRes('project skill tools require a project');
        const skillId = String(a.skillId ?? '');
        removeSkillFiles(projectRoot(), skillId);
        this.store.removeInstalledSkill(pid, skillId);
        return txt(`Removed project skill ${skillId}.`);
      }
      case 'run_in_background': {
        if (!reg.bg || !this.bgHooks) return errRes('background tools are not enabled for this run');
        const dir = s(a.cwd);
        const cwd = dir ? (path.isAbsolute(dir) ? dir : path.join(projectRoot(), dir)) : projectRoot();
        const r = this.bgHooks.start({ projectId: pid, sessionId: null, command: String(a.command ?? ''), cwd });
        return txt(`Started background task ${r.id} (pid ${r.pid ?? '?'}) in ${cwd}: \`${a.command ?? ''}\`. It keeps running after this turn. Use background_output("${r.id}") to read its logs / confirm it started, and stop_background("${r.id}") to stop it.`);
      }
      case 'background_output': {
        if (!reg.bg || !this.bgHooks) return errRes('background tools are not enabled for this run');
        const r = this.bgHooks.output(String(a.id ?? ''), n(a.tailKB));
        if (!r) return txt(`No background task ${a.id ?? ''} (it may have been cleared).`);
        return txt(`status=${r.record.status}${r.record.exitCode != null ? ` exit=${r.record.exitCode}` : ''} bytes=${r.record.bytes}\n\n${r.output || '(no output yet)'}`);
      }
      case 'list_background': {
        if (!reg.bg || !this.bgHooks) return errRes('background tools are not enabled for this run');
        const rows = this.bgHooks.list(pid);
        return txt(rows.length ? rows.map(r => `- ${r.id} [${r.status}${r.pid != null ? ` pid ${r.pid}` : ''}]: \`${r.command}\``).join('\n') : 'No background tasks for this project.');
      }
      case 'stop_background': {
        if (!reg.bg || !this.bgHooks) return errRes('background tools are not enabled for this run');
        const r = this.bgHooks.stop(String(a.id ?? ''));
        return txt(r ? `Stopped background task ${a.id ?? ''} (status ${r.status}).` : `No background task ${a.id ?? ''}.`);
      }
      // Git/PR lifecycle — only enabled when the codex run was registered with a
      // GitCtx (i.e. this chat owns a worktree + branch on a GitHub repo).
      case 'git_status': {
        if (!reg.git) return errRes('git/PR tools are not available — this session has no worktree/branch on a GitHub repo.');
        if (!reg.git.available()) return txt('No live git/PR lifecycle for this session.');
        const st = await reg.git.status();
        const lines: string[] = [];
        lines.push(`state=${st.state}  branch=${st.branch ?? '?'}  base=${st.base ?? '?'}`);
        lines.push(`ahead=${st.ahead}  behind=${st.behind}  dirty=${st.dirty}  pushed=${st.pushed}`);
        if (st.pr) lines.push(`PR #${st.pr.number} (${st.pr.state}): ${st.pr.title}  ${st.pr.url}`);
        lines.push(`\nNext: ${st.nextAction}`);
        return txt(lines.join('\n'));
      }
      case 'git_push': {
        if (!reg.git) return errRes('git/PR tools are not available for this run.');
        const r = await reg.git.push();
        return txt(r.ok ? 'Pushed. Now call pr_create to open a pull request.' : `Push failed: ${r.reason ?? 'unknown'}`);
      }
      case 'pr_create': {
        if (!reg.git) return errRes('git/PR tools are not available for this run.');
        const r = await reg.git.createPr({ title: s(a.title), body: s(a.body) });
        if (!r.ok) return txt(`Could not open PR: ${r.reason ?? 'unknown'}`);
        return txt(`PR #${r.number} is open: ${r.url}\nUse git_status to check mergeability, then pr_merge once it's clean.`);
      }
      case 'pr_merge': {
        if (!reg.git) return errRes('git/PR tools are not available for this run.');
        const method = s(a.method);
        const r = await reg.git.mergePr({ method: method === 'merge' || method === 'squash' || method === 'rebase' ? method : undefined });
        return txt(r.ok ? "Merged. The session's work is on the base branch now — you can archive the worktree if you're done." : `Merge failed: ${r.reason ?? 'unknown'}`);
      }
      case 'pr_resolve_conflicts': {
        if (!reg.git) return errRes('git/PR tools are not available for this run.');
        const r = await reg.git.resolveConflicts();
        if (r.ok && (!r.conflicts || r.conflicts.length === 0)) {
          return txt('Conflicts resolved cleanly (or the branch was already up to date) — pushed the merged branch. Call git_status to verify the PR is now mergeable.');
        }
        if (r.conflicts && r.conflicts.length > 0) {
          const list = r.conflicts.map(f => `  - ${f}`).join('\n');
          return txt(`Pulled base; ${r.conflicts.length} file(s) need conflict markers resolved:\n${list}\n\nNext: Read each file, resolve the <<<<<<< / ======= / >>>>>>> markers, then commit (\`git add -A && git commit -m "resolve merge conflicts"\`), then call pr_resolve_conflicts again.`);
        }
        return txt(`pr_resolve_conflicts failed: ${r.reason ?? 'unknown'}`);
      }
      case 'branch_rename': {
        if (!reg.git) return errRes('git/PR tools are not available for this run.');
        const r = await reg.git.renameBranch();
        if (!r.ok) return txt(`Rename failed: ${r.reason ?? 'unknown'}`);
        if (r.unchanged) return txt(`Rename skipped (${r.reason ?? 'no-op'}).`);
        // satisfy the unused-import linter — even when this path doesn't run,
        // keep nextActionFor exported as a shared helper for both engines.
        void nextActionFor;
        return txt(`Renamed ${r.from} → ${r.to}.`);
      }
      default: return errRes(`unknown tool: ${tool}`);
    }
  }

}

/* ── The embedded stdio MCP shim (plain CommonJS — runs under Electron's node) ──
   Speaks MCP to codex on stdio; forwards each tool call to the bridge over the
   unix socket; returns the bridge's MCP-shaped result verbatim. Kept dependency-
   free and defensive (the socket may drop). */
const SHIM_TOOLS = JSON.stringify([
  { name: 'search_skills', description: 'Search the live Maestro skill registry for specialized SKILL.md instructions. Public search excludes disabled skills.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'get_skill', description: 'Fetch metadata for one registry skill by id, including audit, version, and original source state.', inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] } },
  { name: 'download_skill', description: 'Download a registry skill SKILL.md without installing it into the project.', inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] } },
  { name: 'add_skill_to_project', description: 'Install a registry skill into this project at .claude/skills/<slug>/SKILL.md. Read that file before using the skill.', inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] } },
  { name: 'list_project_skills', description: 'List skills already installed in this project.', inputSchema: { type: 'object', properties: {} } },
  { name: 'remove_project_skill', description: 'Remove an installed project skill by registry id or slug.', inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] } },
  { name: 'run_in_background', description: 'Start a long-lived or never-returning command (a dev/preview server like `npm run dev`/`vite`/`next dev`, a file watcher, `build --watch`, `tail -f`, a worker) as a TRACKED BACKGROUND process. Use this — NOT a normal shell command — for anything that does not exit on its own within a few seconds. It keeps running after you reply, survives the user sending the next message, and the user sees it as a running session they can stop. Returns IMMEDIATELY with a task id (does not wait). After starting, poll background_output to confirm it came up (the URL), then finish your reply — never run a server in the foreground.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
  { name: 'background_output', description: 'Read recent stdout+stderr and status of a background task started with run_in_background (e.g. to confirm a server came up and find its URL). Works across turns — background tasks persist.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, tailKB: { type: 'number' } }, required: ['id'] } },
  { name: 'list_background', description: 'List this project\'s background tasks (running first) with id, status and command.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stop_background', description: 'Stop a background task (kills its whole process tree).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'git_status', description: 'Read this chat\'s live git/PR state (branch, ahead/behind, dirty, open PR, next-action hint). Call before push/pr/merge/resolve to confirm the lifecycle position.', inputSchema: { type: 'object', properties: {} } },
  { name: 'git_push', description: 'Push this chat\'s branch to origin using the user\'s saved GitHub token. Use when git_status says ready-to-push.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pr_create', description: 'Open (or resurface) a pull request from this chat\'s branch. Pushes first if needed; idempotent.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } } },
  { name: 'pr_merge', description: 'Merge the open PR for this chat using the repo\'s preferred merge method (or override with method=merge|squash|rebase). Only call when git_status reports pr-mergeable.', inputSchema: { type: 'object', properties: { method: { type: 'string' } } } },
  { name: 'pr_resolve_conflicts', description: 'Pull the base branch in. If clean, pushes; if conflicts, returns the conflicted files so you can Read/Edit them, commit, and call again.', inputSchema: { type: 'object', properties: {} } },
  { name: 'branch_rename', description: 'Force a one-shot of the auto-rename (codename-only → task-derived slug). No-op if the branch is already pushed or a PR exists.', inputSchema: { type: 'object', properties: {} } },
]);

const SHIM_SRC = `'use strict';
// Maestro MCP shim — auto-generated; do not edit. Forwards codex's MCP
// tool calls to the Maestro app over a unix socket.
const net = require('net');
const readline = require('readline');
const TOOLS = ${SHIM_TOOLS};
const sockPath = process.argv[2];
const token = process.env.MAESTRO_TOKEN;
let sock = null, rbuf = '', nextId = 1; const pending = new Map();
function connect() {
  sock = net.connect(sockPath);
  sock.on('data', (d) => { rbuf += d.toString(); let nl; while ((nl = rbuf.indexOf('\\n')) >= 0) { const line = rbuf.slice(0, nl); rbuf = rbuf.slice(nl + 1); try { const m = JSON.parse(line); const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } } catch (e) {} } });
  sock.on('error', () => {}); sock.on('close', () => { sock = null; });
}
connect();
function callBridge(tool, args) {
  return new Promise((resolve) => {
    if (!sock) connect();
    const id = nextId++;
    pending.set(id, resolve);
    try { sock.write(JSON.stringify({ id, token, tool, args }) + '\\n'); } catch (e) { pending.delete(id); resolve({ ok: true, result: { content: [{ type: 'text', text: 'bridge unavailable' }], isError: true } }); return; }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: true, result: { content: [{ type: 'text', text: 'tool call timed out' }], isError: true } }); } }, 90000);
  });
}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'maestro', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  else if (method === 'tools/call') {
    const r = await callBridge((params && params.name) || '', (params && params.arguments) || {});
    send({ jsonrpc: '2.0', id, result: (r && r.result) || { content: [{ type: 'text', text: 'no result' }], isError: true } });
  } else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
});
`;

export { TOOL_NAMES };
