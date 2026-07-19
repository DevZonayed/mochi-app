// Safety tests for the local preview/promote driver (local-release.sh + its
// decision core local-release.mjs).
//
// The point of these tests is to PROVE the guardrails without touching
// /Applications, a live store, or real processes: semver ordering, the fail-safe
// active-job guard (only terminal statuses allow a promotion; queued / awaiting /
// unknown / malformed all BLOCK), channel/fingerprint/version validation, and the
// structural contract that PREVIEW mode can never quit or replace production.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSemver, compareSemver, isFingerprint,
  isTerminalStatus, isActiveJob, scanStoreForActiveJobs, TERMINAL_JOB_STATUSES,
  validateProvenance, decidePromotion,
  buildPlan, planMutatesProduction, PRODUCTION_MUTATING_STEPS,
} from './local-release.mjs';

const SCRIPT = fileURLToPath(new URL('./local-release.sh', import.meta.url));
const FP0 = 'a'.repeat(64);
const FP1 = 'b'.repeat(64);

describe('semver ordering', () => {
  it('parses strict X.Y.Z and rejects malformed / leading-zero', () => {
    expect(parseSemver('0.1.52')).toEqual({ major: 0, minor: 1, patch: 52 });
    expect(parseSemver('01.2.3')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('1.2.3-rc1')).toBeNull();
    expect(parseSemver('v1.2.3')).toBeNull();
  });

  it('orders numerically, not lexically (0.10.9 > 0.9.99, 0.1.52 > 0.1.51)', () => {
    expect(compareSemver('0.10.9', '0.9.99')).toBe(1);
    expect(compareSemver('0.1.52', '0.1.51')).toBe(1);
    expect(compareSemver('0.1.51', '0.1.52')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('throws on non-semver so nothing can compare "equal" by accident', () => {
    expect(() => compareSemver('1.2', '1.2.3')).toThrow();
    expect(() => compareSemver('', '1.2.3')).toThrow();
  });

  it('recognizes a 64-hex fingerprint only', () => {
    expect(isFingerprint(FP0)).toBe(true);
    expect(isFingerprint('ABCD')).toBe(false);
    expect(isFingerprint(FP0.toUpperCase())).toBe(false);
    expect(isFingerprint('')).toBe(false);
  });
});

describe('active-job guard (fail safe: allowlist terminal only)', () => {
  it('allows ONLY the terminal statuses', () => {
    expect(TERMINAL_JOB_STATUSES).toEqual(['done', 'failed', 'cancelled', 'gated']);
    for (const s of ['done', 'failed', 'cancelled', 'gated', 'DONE', ' Cancelled ', ' GATED ']) expect(isTerminalStatus(s)).toBe(true);
  });

  it('treats queued / running / pending / awaiting / unknown / malformed as ACTIVE', () => {
    for (const s of ['queued', 'running', 'pending', 'awaiting', 'in_progress', 'weird', '', undefined, null, 42]) {
      expect(isActiveJob({ status: s })).toBe(true);
    }
    expect(isActiveJob(null)).toBe(true);      // malformed record
    expect(isActiveJob('nope')).toBe(true);    // not an object
    expect(isActiveJob({ status: 'done' })).toBe(false);
  });

  it('scanStoreForActiveJobs: clean store (all terminal) passes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mochi-lr-'));
    try {
      const f = path.join(dir, 'maestro-store.json');
      writeFileSync(f, JSON.stringify({ jobs: [{ status: 'done' }, { status: 'failed' }, { status: 'cancelled' }, { status: 'gated' }] }));
      const r = scanStoreForActiveJobs(f);
      expect(r.ok).toBe(true);
      expect(r.activeCount).toBe(0);
      expect(r.totalJobs).toBe(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('scanStoreForActiveJobs: any nonterminal job blocks (ok:false)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mochi-lr-'));
    try {
      const f = path.join(dir, 'maestro-store.json');
      writeFileSync(f, JSON.stringify({ jobs: [{ status: 'done' }, { status: 'running' }] }));
      const r = scanStoreForActiveJobs(f);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('active-jobs');
      expect(r.activeCount).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('scanStoreForActiveJobs fails CLOSED on missing / malformed / no-jobs store', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mochi-lr-'));
    try {
      expect(scanStoreForActiveJobs(path.join(dir, 'nope.json')).ok).toBe(false);
      const bad = path.join(dir, 'bad.json'); writeFileSync(bad, '{ not json');
      expect(scanStoreForActiveJobs(bad)).toMatchObject({ ok: false, reason: 'store-malformed' });
      const nojobs = path.join(dir, 'nojobs.json'); writeFileSync(nojobs, JSON.stringify({ projects: [] }));
      expect(scanStoreForActiveJobs(nojobs)).toMatchObject({ ok: false, reason: 'jobs-missing-or-malformed' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never returns store contents — only counts and reasons', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mochi-lr-'));
    try {
      const f = path.join(dir, 'maestro-store.json');
      writeFileSync(f, JSON.stringify({ accessToken: 'SECRET_TOKEN_XYZ', jobs: [{ status: 'running', title: 'SECRET_TITLE' }] }));
      const r = scanStoreForActiveJobs(f);
      const blob = JSON.stringify(r);
      expect(blob).not.toContain('SECRET_TOKEN_XYZ');
      expect(blob).not.toContain('SECRET_TITLE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('provenance & promotion validation', () => {
  it('validateProvenance flags channel / version / fingerprint mismatch', () => {
    expect(validateProvenance({
      channel: 'preview', version: '0.1.52', fingerprint: FP0,
      expectedChannel: 'preview', expectedVersion: '0.1.52', expectedFingerprint: FP0,
    }).ok).toBe(true);
    expect(validateProvenance({
      channel: 'production', version: '0.1.52', fingerprint: FP0,
      expectedChannel: 'preview', expectedVersion: '0.1.52', expectedFingerprint: FP0,
    }).ok).toBe(false);
    expect(validateProvenance({
      channel: 'preview', version: '0.1.51', fingerprint: FP0,
      expectedChannel: 'preview', expectedVersion: '0.1.52', expectedFingerprint: FP0,
    }).ok).toBe(false);
    expect(validateProvenance({
      channel: 'preview', version: '0.1.52', fingerprint: FP1,
      expectedChannel: 'preview', expectedVersion: '0.1.52', expectedFingerprint: FP0,
    }).ok).toBe(false);
  });

  it('decidePromotion requires channel=preview, candidate>prod, and fingerprint==source', () => {
    expect(decidePromotion({ previewChannel: 'preview', previewVersion: '0.1.52', previewFingerprint: FP0, prodVersion: '0.1.51', sourceFingerprint: FP0 }).ok).toBe(true);
    // wrong channel
    expect(decidePromotion({ previewChannel: 'production', previewVersion: '0.1.52', previewFingerprint: FP0, prodVersion: '0.1.51', sourceFingerprint: FP0 }).ok).toBe(false);
    // not greater than production
    expect(decidePromotion({ previewChannel: 'preview', previewVersion: '0.1.51', previewFingerprint: FP0, prodVersion: '0.1.51', sourceFingerprint: FP0 }).ok).toBe(false);
    // fingerprint drifted from source
    expect(decidePromotion({ previewChannel: 'preview', previewVersion: '0.1.52', previewFingerprint: FP0, prodVersion: '0.1.51', sourceFingerprint: FP1 }).ok).toBe(false);
    // fresh production (no installed version) still allowed if the rest holds
    expect(decidePromotion({ previewChannel: 'preview', previewVersion: '0.1.52', previewFingerprint: FP0, prodVersion: '', sourceFingerprint: FP0 }).ok).toBe(true);
  });
});

describe('execution plan safety contract', () => {
  const ord = (plan: { steps: string[] }, step: string) => plan.steps.indexOf(step);

  it('PREVIEW plan contains NO production-mutating step', () => {
    const plan = buildPlan('preview', { applicationsDir: '/tmp/apps' });
    expect(planMutatesProduction(plan)).toBe(false);
    for (const step of plan.steps) expect(PRODUCTION_MUTATING_STEPS).not.toContain(step);
    expect(plan.target).toBe('/tmp/apps/Mochlet Preview.app');
    // it MAY read the production pid (read-only) — that is not a mutation
    expect(plan.steps).toContain('capture-production-pid');
    expect(plan.steps).toContain('assert-production-pid-unchanged');
  });

  it('PREVIEW plan order: stage → (capture prod pid) → stop → backup → replace → launch → ready → prod-unchanged', () => {
    const plan = buildPlan('preview');
    // stage the copied app and validate BEFORE touching the existing preview
    expect(ord(plan, 'stage-preview')).toBeGreaterThanOrEqual(0);
    expect(ord(plan, 'stage-preview')).toBeLessThan(ord(plan, 'stop-preview'));
    // exact shell order: stop → backup → replace
    expect(ord(plan, 'stop-preview')).toBeLessThan(ord(plan, 'backup-preview'));
    expect(ord(plan, 'backup-preview')).toBeLessThan(ord(plan, 'replace-preview'));
    expect(ord(plan, 'replace-preview')).toBeLessThan(ord(plan, 'launch-preview'));
    // read the production pid before we stop/replace preview
    expect(ord(plan, 'capture-production-pid')).toBeLessThan(ord(plan, 'stop-preview'));
    // launch readiness precedes the production-pid-unchanged proof, which is last
    expect(ord(plan, 'launch-preview')).toBeLessThan(ord(plan, 'assert-preview-ready'));
    expect(ord(plan, 'assert-preview-ready')).toBeLessThan(ord(plan, 'assert-production-pid-unchanged'));
    expect(ord(plan, 'assert-production-pid-unchanged')).toBe(plan.steps.length - 1);
  });

  it('PROMOTE plan DOES mutate production; order: stage → guard → recheck → quit → backup → replace → launch → verify', () => {
    const plan = buildPlan('promote');
    expect(planMutatesProduction(plan)).toBe(true);
    expect(plan.target).toBe('/Applications/Mochlet.app');
    // stage + verify the bundle BEFORE the job guard / quit
    expect(ord(plan, 'stage-production')).toBeGreaterThanOrEqual(0);
    expect(ord(plan, 'stage-production')).toBeLessThan(ord(plan, 'guard-production-active-jobs'));
    // guard → recheck → quit → backup → replace → launch → verify
    expect(ord(plan, 'guard-production-active-jobs')).toBeLessThan(ord(plan, 'recheck-active-jobs'));
    expect(ord(plan, 'recheck-active-jobs')).toBeLessThan(ord(plan, 'quit-production'));
    expect(ord(plan, 'quit-production')).toBeLessThan(ord(plan, 'backup-production'));
    expect(ord(plan, 'backup-production')).toBeLessThan(ord(plan, 'replace-production'));
    expect(ord(plan, 'replace-production')).toBeLessThan(ord(plan, 'launch-production'));
    expect(ord(plan, 'launch-production')).toBeLessThan(ord(plan, 'verify-production-executable'));
  });

  it('rejects an unknown mode', () => {
    expect(() => buildPlan('nuke')).toThrow();
  });
});

describe('local-release.sh script contract', () => {
  it('exists and is Bash 3.2 parseable under the macOS system shell', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    if (existsSync('/bin/bash')) {
      const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
      expect(r.status, `bash -n stderr: ${r.stderr}`).toBe(0);
    }
  });

  it('PREVIEW code path never quits, kills, or replaces the production bundle', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Extract the do_preview() function body (up to the next top-level `}` at col 0).
    const start = src.indexOf('\ndo_preview()');
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const end = rest.indexOf('\n}\n');
    const body = end > -1 ? rest.slice(0, end) : rest;
    // No production-mutating helper calls and no raw destructive ops on the prod app.
    for (const forbidden of ['production_quit', 'production_replace', 'production_backup', 'production_launch', 'production_rollback']) {
      expect(body, `preview body must not call ${forbidden}`).not.toContain(forbidden);
    }
    // No kill/pkill and no write/remove targeting the production .app path.
    expect(body).not.toMatch(/\bp?kill\b/);
    expect(body).not.toMatch(/\bosascript\b[^\n]*webkit"(\s|$)/); // quitting prod bundle id
    expect(body).not.toMatch(/(rm|ditto|cp|mv)\s+[^\n]*Mochlet\.app/); // mutate prod bundle
  });

  it('exposes no force/bypass flag', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/--force\b/);
    expect(src).not.toMatch(/--bypass\b/);
    expect(src).not.toMatch(/--skip-(guard|checks|smoke)\b/);
  });
});

// Extract a shell function body: from `\n<name>()` to the next top-level `\n}\n`.
function funcBody(src: string, name: string): string {
  const start = src.indexOf(`\n${name}()`);
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\n}\n');
  return end > -1 ? rest.slice(0, end) : rest;
}

describe('local-release.sh hardening contract', () => {
  const src = () => readFileSync(SCRIPT, 'utf8');

  it('preview install gate uses offline frozen install and fails closed on an incomplete local store', () => {
    const body = funcBody(src(), 'do_preview');
    expect(body).toContain('pnpm install --frozen-lockfile --offline');
    expect(body).not.toContain('pnpm install --frozen-lockfile )');
    expect(body).not.toContain('pnpm install --frozen-lockfile\n');
    expect(body).toMatch(/already-resolved lockfile and local pnpm store/);
    expect(body).toMatch(/fail clearly if the local package cache is incomplete/);
    expect(body).not.toMatch(/kill[^\n]*pnpm|pkill[^\n]*pnpm|timeout[^\n]*pnpm install/);
  });

  it('smoke runs in a subshell with an EXIT trap — never a leaking RETURN trap', () => {
    const s = src();
    expect(s).not.toMatch(/trap[^\n]*\bRETURN\b/);       // RETURN traps leak past the function
    const body = funcBody(s, 'smoke_app');
    expect(body).toMatch(/\(\s*$/m);                       // opens a subshell
    expect(body).toMatch(/trap\s+'[^']*rm -rf[^']*'\s+EXIT/); // subshell-scoped cleanup
  });

  it('preview STAGES + validates before touching the existing preview, and aborts if it will not exit', () => {
    const body = funcBody(src(), 'do_preview');
    const iStage = body.indexOf('ditto "$src" "$stage"');
    const iValidateStage = body.indexOf('verify_bundle "$stage"');
    const iStop = body.search(/osascript[^\n]*PREVIEW_BID/);
    const iBackup = body.indexOf('mv "$dest" "$backup"');
    const iReplace = body.indexOf('mv "$stage" "$dest"');
    expect(iStage).toBeGreaterThan(-1);
    expect(iValidateStage).toBeGreaterThan(iStage);       // validate the stage…
    expect(iBackup).toBeGreaterThan(iValidateStage);      // …before touching the installed preview
    expect(iReplace).toBeGreaterThan(iBackup);            // exact order: backup → replace (atomic mv)
    // bounded wait + abort if the existing preview executable does not exit
    expect(body).toContain('wait_exec_gone');
    expect(body).toMatch(/did not exit/);
    // launch readiness: wait for the exact dest executable + require a pid
    expect(body).toContain('wait_exec_up');
  });

  it('production_quit aborts (never proceeds) if the exact production executable survives the timeout', () => {
    const body = funcBody(src(), 'production_quit');
    expect(body).toMatch(/osascript[^\n]*PROD_BID/);      // quit by EXACT bundle id
    expect(body).toContain('wait_exec_gone');             // bounded wait
    expect(body).toMatch(/die /);                          // abort if it survives
    expect(body).not.toMatch(/\bp?kill\b/);               // never kill by name
    expect(body).not.toMatch(/killall/);
  });

  it('promote STAGES + verifies before the job guard and the quit', () => {
    const body = funcBody(src(), 'do_promote');
    const iStage = body.indexOf('ditto "$src" "$stage"');
    const iGuard = body.indexOf('guard_active_jobs');
    const iQuit = body.indexOf('production_quit');
    const iReplace = body.indexOf('production_replace');
    expect(iStage).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(iStage);
    expect(iQuit).toBeGreaterThan(iGuard);
    expect(iReplace).toBeGreaterThan(iQuit);
    // launch-failure rollback restores the previous bundle (never leaves prod absent)
    expect(body).toContain('production_rollback');
  });

  it('production smoke uses the non-production test port 9238 and never binds the live 9235', () => {
    const s = src();
    expect(s).toContain('smoke_app "$src" production 9238');
    // 9235 (the live production MCP port) is never passed to smoke_app as a target.
    for (const line of s.split('\n')) {
      if (/^\s*smoke_app\b/.test(line)) expect(line).not.toMatch(/\b9235\b/);
    }
  });

  it('declares the process/utility prereqs it actually uses', () => {
    const body = funcBody(src(), 'require_prereqs');
    for (const c of ['ps', 'open', 'mktemp', 'date', 'osascript', 'ditto', 'codesign', 'plutil']) {
      expect(body, `require_prereqs must check for ${c}`).toContain(c);
    }
  });

  it('pid_of_exec matches the EXACT executable path via read-only ps — never pgrep/substring', () => {
    const s = src();
    expect(s).not.toMatch(/\bpgrep\b/);                 // no pgrep anywhere
    const body = funcBody(s, 'pid_of_exec');
    expect(body).toMatch(/ps\s+-ww\b/);                 // read-only, full-width (untruncated)
    expect(body).toMatch(/comm=/);                       // compare against the executable path (comm)
    expect(body).toMatch(/\[\s+"\$comm"\s+=\s+"\$want"\s+\]/); // byte-for-byte string equality
    expect(body).not.toMatch(/=~/);                      // not a regex compare
    expect(body).not.toMatch(/\bgrep\b/);                // not grep/substring matching
  });

  it('pid_of_exec is pipefail-safe and byte-exact when EXECUTED under /bin/bash (found + spaces + absent)', () => {
    // Execute the ACTUAL function (a static grep cannot catch the `set -o pipefail`
    // exit-status bug). ps is stubbed so no real process is touched, and the whole
    // thing runs under `set -e; set -o pipefail` — the exact context that aborted
    // the caller when the pipeline returned nonzero after emitting a PID.
    const def = funcBody(src(), 'pid_of_exec') + '\n}';
    const PROD = '/Applications/Mochlet.app/Contents/MacOS/MaestroWebKit';
    const PREV = '/Applications/Mochlet Preview.app/Contents/MacOS/MaestroWebKit';
    const harness = [
      'set -e',
      'set -o pipefail',
      'PROD_EXEC_REL="Contents/MacOS/MaestroWebKit"',
      // canned `ps` output incl. a path WITH SPACES; the query paths differ only by
      // "Mochlet.app" vs "Mochlet Preview.app", proving byte-exact (not substring).
      `ps() { printf '%s\\n' '  111 /Applications/Other.app/Contents/MacOS/Other' '  222 ${PROD}' '  333 ${PREV}'; }`,
      def,
      `f="$(pid_of_exec "${PROD}")"`,
      `v="$(pid_of_exec "${PREV}")"`,
      `a="$(pid_of_exec "/no/such/exec")"`,
      `printf 'FOUND[%s] PREV[%s] ABSENT[%s] DONE\\n' "$f" "$v" "$a"`,
    ].join('\n');
    const r = spawnSync('/bin/bash', ['-c', harness], { encoding: 'utf8' });
    // set -e must NOT have aborted — the function returns 0 for found AND absent.
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('FOUND[222]');   // exact match on the production path
    expect(r.stdout).toContain('PREV[333]');    // space-containing path matched byte-for-byte
    expect(r.stdout).toContain('ABSENT[]');     // absent → empty output, still success
    expect(r.stdout).toContain('DONE');         // reached the end under set -e/pipefail
  });

  it('low-level validators RETURN (never exit) so top-level callers can clean up the stage', () => {
    const s = src();
    const vb = funcBody(s, 'verify_bundle');
    expect(vb).toMatch(/return 1/);
    expect(vb).not.toMatch(/\bdie\b/);                   // must not exit the shell out from under a caller
    const gj = funcBody(s, 'guard_active_jobs');
    expect(gj).toMatch(/return 1/);
    expect(gj).not.toMatch(/\bdie\b/);
    // a script-level EXIT trap guarantees the unique hidden stage is removed on ANY failure
    expect(s).toMatch(/trap\s+cleanup_stage\s+EXIT/);
    expect(funcBody(s, 'cleanup_stage')).toMatch(/rm -rf/);
    // top-level callers own the die after a returning validator
    expect(s).toMatch(/verify_bundle "\$stage"[^\n]*\|\| die/);
    expect(s).toMatch(/guard_active_jobs "\$store"[^\n]*\|\| die/);
  });

  it('cleanup_stage EXIT trap preserves the script exit status (0 on success, N on failure) — EXECUTED under /bin/bash', () => {
    // The real-run bug: after a successful move `stage` is empty, so the trap
    // function ended on `[ -n "" ]` → status 1, which overrode a fully successful
    // exit 0. A static grep cannot catch this — run the ACTUAL trap under /bin/bash.
    const def = funcBody(src(), 'cleanup_stage') + '\n}';
    const run = (pre: string, tail: string) => {
      // Match the real script's options — the EXIT-trap status override only
      // manifests under `set -e` (an empty-stage trap ending on `[ -n "" ]` → 1).
      const harness = ['set -euo pipefail', 'stage=""', pre, def, 'trap cleanup_stage EXIT', tail].filter(Boolean).join('\n');
      return spawnSync('/bin/bash', ['-c', harness], { encoding: 'utf8' });
    };
    // empty (neutralized) stage + successful run → exit 0 (the reported bug)
    expect(run('', 'true').status, 'empty stage + success must exit 0').toBe(0);
    // empty stage + failing run → the original failure is PRESERVED, not masked to 0
    expect(run('', 'exit 3').status, 'cleanup must not mask a real failure').toBe(3);
    // a non-empty stage is actually removed, and success is still preserved
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mochi-stage-'));
    const stagePath = path.join(dir, 'stage.app');
    mkdirSync(stagePath, { recursive: true });
    try {
      const r = run(`stage="${stagePath}"`, 'true');
      expect(r.status, 'non-empty stage + success must exit 0').toBe(0);
      expect(existsSync(stagePath), 'stage must be removed by the trap').toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('production_rollback never rm -rf a still-running bundle — it aborts loudly and proves restore readiness', () => {
    const body = funcBody(src(), 'production_rollback');
    expect(body).not.toMatch(/wait_exec_gone[^\n]*\|\|\s*true/); // the old bug: wait then ignore
    const iWait = body.search(/wait_exec_gone/);
    const iRm = body.indexOf('rm -rf "$dest"');
    expect(iWait).toBeGreaterThan(-1);
    expect(iRm).toBeGreaterThan(iWait);                  // rm ONLY after the exit-confirmed guard
    expect(body).toMatch(/NOT removing a running bundle/);
    // after restoring the backup, prove the restored app actually came up
    expect(body).toContain('wait_exec_up');
    expect(body).toMatch(/did not come up|manual intervention/);
  });
});
