/* Codex spawn env helper — make `node` resolvable for Codex sub-processes.

   The Codex CLI itself is a native Rust binary, but the tools it invokes at
   run-time (its own MCP shims, hook scripts, codex-internal helpers, custom
   MCP servers configured via -c) routinely start with `#!/usr/bin/env node`.
   When the desktop app is launched from Finder on macOS, the inherited
   `process.env.PATH` is minimal — typically just `/usr/bin:/bin:/usr/sbin:/sbin`,
   no `/opt/homebrew/bin`, no `/usr/local/bin`, often no `node` at all. So
   those sub-spawns die with:

     env: node: No such file or directory      (exit 127)

   and the user sees "Codex exited 127" in chat (image_br9a4.png) even though
   they ARE signed into Codex. This is the same class of bug the bg-task path
   already worked around for `npm run dev` via `/bin/zsh -lc`, but Codex needs
   to be spawned DIRECTLY (it streams structured JSON), so we can't wrap the
   whole thing in a login shell.

   Fix: build a tiny `node` SHIM at startup that re-execs Electron with
   ELECTRON_RUN_AS_NODE=1. Electron's executable embeds a working node — we
   already leverage this for the maestro MCP shim (see codex-bridge.ts:106
   `command = process.execPath`, `env = { ELECTRON_RUN_AS_NODE = "1" }`).
   Then we prepend the shim's directory to PATH whenever we spawn Codex.

   We ALSO probe the user's real login-shell PATH (one `/bin/zsh -lc`, cached
   for the app's lifetime) and stitch it in, so other shebangs Codex might hit
   (git, npm, gh, python3 via asdf/fnm/pyenv) keep resolving too.

   Net effect: Codex works on a Mac with no system node installed at all,
   which is exactly the promise of "downloaded, not bundled" engines. */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const isWin = (): boolean => process.platform === 'win32';

/* Memoize so we pay the cost (one write, one /bin/zsh probe) at most once. */
let shimDir: string | null = null;
let shellPath: string | null | undefined; // undefined = not yet probed; null = probe failed.

/** Probe the user's REAL shell PATH (same trick as bg tasks + systemBinary). */
function probeUserShellPath(): string | null {
  if (isWin()) return null;
  try {
    const out = execFileSync('/bin/zsh', ['-lc', 'printf "%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Build (or reuse) a directory containing a `node` shim that wraps Electron
    via ELECTRON_RUN_AS_NODE=1. Idempotent: rewrites only if the file content
    drifted (e.g. process.execPath changed after an app move). Returns the dir. */
export function ensureNodeShim(installRoot: string): string {
  if (shimDir && existsSync(shimDir)) return shimDir;
  const dir = path.join(installRoot, 'node-shim');
  mkdirSync(dir, { recursive: true });
  const electronExe = process.execPath; // Electron's exec, acts as `node` with the env flag.
  if (isWin()) {
    // Windows: a tiny .cmd is the cleanest way to be found as `node` on PATH.
    const cmd = path.join(dir, 'node.cmd');
    const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronExe}" %*\r\n`;
    if (!existsSync(cmd) || safeRead(cmd) !== content) writeFileSync(cmd, content);
  } else {
    // POSIX: a sh wrapper. We `exec` so signals propagate and there's no extra PID.
    // process.execPath can contain spaces (e.g. "/Applications/Maestro.app/...")
    // — the double-quoted "$electronExe" handles that.
    const sh = path.join(dir, 'node');
    const content = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${electronExe}" "$@"\n`;
    if (!existsSync(sh) || safeRead(sh) !== content) {
      writeFileSync(sh, content);
    }
    // Always ensure +x — chmod is cheap and protects us against tar/copy operations
    // that may have stripped the executable bit.
    try { chmodSync(sh, 0o755); } catch { /* best effort */ }
  }
  shimDir = dir;
  return dir;
}

function safeRead(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/** Return a PATH string with: 1) the node shim dir, 2) the user's login-shell
    PATH (so npm/git/asdf/fnm/pyenv tools resolve too), 3) the app's inherited
    PATH. Duplicates removed, order preserved. */
export function codexPathEnv(installRoot: string): string {
  const shim = ensureNodeShim(installRoot);
  if (shellPath === undefined) shellPath = probeUserShellPath();
  const sep = isWin() ? ';' : ':';
  const parts: string[] = [shim];
  if (shellPath) parts.push(...shellPath.split(sep));
  if (process.env.PATH) parts.push(...process.env.PATH.split(sep));
  const seen = new Set<string>();
  return parts.filter(p => !!p && !seen.has(p) && (seen.add(p), true)).join(sep);
}

/** Build a spawn env that ensures `node` (and the user's normal PATH) are
    reachable, plus optional caller-supplied overrides. Use this for every
    Codex spawn (and any other engine sub-tool that may shell out to node). */
export function codexSpawnEnv(installRoot: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...(extra ?? {}), PATH: codexPathEnv(installRoot) };
}

/** Mutate `process.env.PATH` IN-PLACE at app startup so every child this process
    spawns inherits the node shim + login-shell PATH — including spawns we
    DON'T directly control, like the Claude Agent SDK's internal `claude`
    binary spawn (see engine.ts:528 — it calls `query()`, the SDK spawns the
    native binary itself, we can't pass it an env). The mutation is purely
    ADDITIVE (we only prepend), idempotent (running twice is a no-op), and
    harmless to existing code that already wraps spawns in `/bin/zsh -lc`. */
export function bootstrapNodePath(installRoot: string): void {
  const merged = codexPathEnv(installRoot);
  if (process.env.PATH === merged) return;
  process.env.PATH = merged;
}

/** Test-only: reset the memoization. Not exported through index. */
export function _resetForTests(): void {
  shimDir = null;
  shellPath = undefined;
}
