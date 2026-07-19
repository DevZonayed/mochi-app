// Decision core for local-release.sh — the SAFE preview/promote driver.
//
// Every non-trivial decision (semver ordering, the active-job guard, channel /
// fingerprint / version validation, and the ordered execution plan) lives here as
// a PURE, unit-testable function so the bash orchestrator only wires I/O. Keeping
// the guards here — not in shell — is what lets the RED tests prove the safety
// contract without touching /Applications, a live store, or real processes.
//
// SECURITY: never print store contents, tokens, or source bytes. Functions return
// COUNTS and REASONS, never the underlying job records or file text.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── semver ───────────────────────────────────────────────────────────────────
// Strict X.Y.Z, no leading zeros (matches resolve-next-version.sh / package-app.sh).
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(v) {
  const m = SEMVER_RE.exec(typeof v === 'string' ? v.trim() : '');
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/** -1 / 0 / +1. Throws on non-semver so a malformed version can never compare
 *  "equal" and slip past a > check. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`compareSemver: non-semver input (${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
export const isFingerprint = (s) => FINGERPRINT_RE.test(typeof s === 'string' ? s : '');

// ── active-job guard ──────────────────────────────────────────────────────────
// Canonical JobStatus (MacOS/brain/store.ts): pending | running | done | failed |
// cancelled | gated. Promotion may quit/replace production ONLY when nothing is in flight,
// so we ALLOWLIST the terminal statuses and treat everything else — including an
// unknown or malformed status — as active. Fail safe, never fail open.
export const TERMINAL_JOB_STATUSES = Object.freeze(['done', 'failed', 'cancelled', 'gated']);

export function isTerminalStatus(status) {
  return typeof status === 'string' && TERMINAL_JOB_STATUSES.includes(status.trim().toLowerCase());
}

/** A job blocks promotion unless its status is EXACTLY a known terminal status. */
export function isActiveJob(job) {
  if (!job || typeof job !== 'object') return true; // malformed record → active
  return !isTerminalStatus(job.status);
}

/**
 * Scan a store file for active jobs without ever exposing its contents.
 * Returns { ok, reason, activeCount, totalJobs }. ok===true ONLY when the store
 * parses AND has zero active jobs. Missing / unreadable / malformed / no-jobs-array
 * all fail closed (ok:false) — the caller decides whether a truly absent production
 * install is a distinct first-run branch.
 */
export function scanStoreForActiveJobs(storePath, io = {}) {
  const readFile = io.readFile || readFileSync;
  const exists = io.exists || existsSync;
  if (!storePath || !exists(storePath)) {
    return { ok: false, reason: 'store-missing', activeCount: null, totalJobs: null };
  }
  let raw;
  try { raw = readFile(storePath, 'utf8'); } catch {
    return { ok: false, reason: 'store-unreadable', activeCount: null, totalJobs: null };
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    return { ok: false, reason: 'store-malformed', activeCount: null, totalJobs: null };
  }
  const jobs = data && Array.isArray(data.jobs) ? data.jobs : null;
  if (!jobs) return { ok: false, reason: 'jobs-missing-or-malformed', activeCount: null, totalJobs: null };
  let active = 0;
  for (const j of jobs) if (isActiveJob(j)) active++;
  return {
    ok: active === 0,
    reason: active === 0 ? 'clean' : 'active-jobs',
    activeCount: active,
    totalJobs: jobs.length,
  };
}

// ── provenance / promotion validation ────────────────────────────────────────
/** Validate a packaged bundle's signed Info.plist metadata against what THIS run
 *  intends to ship. Returns { ok, errors }. */
export function validateProvenance({ channel, version, fingerprint, expectedChannel, expectedVersion, expectedFingerprint }) {
  const errors = [];
  if (channel !== expectedChannel) errors.push(`channel '${channel}' != expected '${expectedChannel}'`);
  if (!parseSemver(version)) errors.push(`version '${version}' is not strict semver`);
  else if (expectedVersion && version !== expectedVersion) errors.push(`version '${version}' != expected '${expectedVersion}'`);
  if (!isFingerprint(fingerprint)) errors.push('fingerprint malformed');
  else if (expectedFingerprint && fingerprint !== expectedFingerprint) errors.push('fingerprint != expected');
  return { ok: errors.length === 0, errors };
}

/**
 * Decide whether an installed preview bundle may be promoted to production.
 * Requires: channel===preview, strict-semver preview version, preview version
 * STRICTLY GREATER than the installed production version (when one exists), a
 * well-formed preview fingerprint, and that fingerprint EXACTLY equal to the
 * current source fingerprint (i.e. nothing changed since preview was cut).
 */
export function decidePromotion({ previewChannel, previewVersion, previewFingerprint, prodVersion, sourceFingerprint }) {
  const errors = [];
  if (previewChannel !== 'preview') errors.push(`preview app channel '${previewChannel}' != 'preview'`);
  if (!parseSemver(previewVersion)) errors.push(`preview version '${previewVersion}' is not strict semver`);
  if (prodVersion !== undefined && prodVersion !== null && prodVersion !== '') {
    if (!parseSemver(prodVersion)) errors.push(`installed production version '${prodVersion}' is not strict semver`);
    else if (parseSemver(previewVersion) && compareSemver(previewVersion, prodVersion) <= 0)
      errors.push(`preview version '${previewVersion}' is not greater than production '${prodVersion}'`);
  }
  if (!isFingerprint(previewFingerprint)) errors.push('preview fingerprint malformed');
  else if (!isFingerprint(sourceFingerprint)) errors.push('source fingerprint malformed');
  else if (previewFingerprint !== sourceFingerprint) errors.push('preview fingerprint != current source — rebuild the preview');
  return { ok: errors.length === 0, errors };
}

// ── execution plan ────────────────────────────────────────────────────────────
// The canonical ordered steps for each mode. The preview plan MUST contain none
// of the production-mutating step kinds — the safety contract the tests assert.
export const PRODUCTION_MUTATING_STEPS = Object.freeze([
  'backup-production', 'quit-production', 'replace-production', 'rollback-production', 'launch-production',
]);

export function buildPlan(mode, opts = {}) {
  const applicationsDir = opts.applicationsDir || '/Applications';
  if (mode === 'preview') {
    return {
      mode, applicationsDir,
      target: `${applicationsDir}/Mochlet Preview.app`,
      steps: [
        'capture-source-fingerprint',
        'resolve-candidate-version',
        'gate-install-frozen', 'gate-test', 'gate-typecheck', 'gate-build',
        'package-preview',
        'smoke-preview-app',
        'recompute-fingerprint-guard',
        'codesign-verify-preview', 'validate-plist-preview',
        'stage-preview',               // ditto to a hidden same-fs path + validate BEFORE any touch
        'capture-production-pid',      // READ-ONLY
        // exact shell order: stop the preview → backup → atomic replace → launch
        'stop-preview', 'backup-preview', 'replace-preview', 'launch-preview',
        'assert-preview-ready',        // wait for the exact dest executable + require a pid
        'assert-production-pid-unchanged',
      ],
    };
  }
  if (mode === 'promote') {
    return {
      mode, applicationsDir,
      target: `${applicationsDir}/Mochlet.app`,
      steps: [
        'read-preview-provenance',
        'decide-promotion',
        'package-production',
        'smoke-production-app',
        'codesign-verify-production', 'validate-plist-production',
        'assert-fingerprint-version-match',
        'stage-production',            // ditto to a hidden same-fs path + verify BEFORE guard/quit
        'guard-production-active-jobs',
        'recheck-active-jobs',
        'capture-production-pid',
        // exact shell order: quit (exact bid) → backup → atomic replace → launch → verify
        'quit-production', 'backup-production', 'replace-production', 'launch-production',
        'verify-production-executable',
      ],
    };
  }
  throw new Error(`buildPlan: unknown mode '${mode}'`);
}

/** True if a plan contains any production-mutating step (used by the safety test
 *  and by the bash contract check). */
export function planMutatesProduction(plan) {
  return plan.steps.some((s) => PRODUCTION_MUTATING_STEPS.includes(s));
}

// ── CLI dispatch (bash calls these; never runs on import) ─────────────────────
function fail(reason) { process.stderr.write(`${reason}\n`); process.exit(1); }

function argMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; }
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'plan': {
      const a = argMap(rest);
      const mode = rest[0] && !rest[0].startsWith('--') ? rest[0] : a.mode;
      process.stdout.write(JSON.stringify(buildPlan(mode, { applicationsDir: a['applications-dir'] }), null, 2) + '\n');
      return;
    }
    case 'guard-jobs': {
      const storePath = rest[0];
      const r = scanStoreForActiveJobs(storePath);
      // Emit only a reason + count — never store contents.
      process.stdout.write(`reason=${r.reason} active=${r.activeCount == null ? 'n/a' : r.activeCount}\n`);
      process.exit(r.ok ? 0 : 3);
      return;
    }
    case 'check-promotion': {
      const a = argMap(rest);
      const r = decidePromotion({
        previewChannel: a['preview-channel'],
        previewVersion: a['preview-version'],
        previewFingerprint: a['preview-fingerprint'],
        prodVersion: a['prod-version'],
        sourceFingerprint: a['source-fingerprint'],
      });
      if (!r.ok) { r.errors.forEach((e) => process.stderr.write(`promotion-blocked: ${e}\n`)); process.exit(4); }
      process.stdout.write('promotion-ok\n');
      return;
    }
    case 'validate-provenance': {
      const a = argMap(rest);
      const r = validateProvenance({
        channel: a.channel, version: a.version, fingerprint: a.fingerprint,
        expectedChannel: a['expected-channel'], expectedVersion: a['expected-version'], expectedFingerprint: a['expected-fingerprint'],
      });
      if (!r.ok) { r.errors.forEach((e) => process.stderr.write(`provenance-invalid: ${e}\n`)); process.exit(5); }
      process.stdout.write('provenance-ok\n');
      return;
    }
    case 'compare-semver': {
      try { process.stdout.write(`${compareSemver(rest[0], rest[1])}\n`); } catch (e) { fail(String(e.message || e)); }
      return;
    }
    default:
      fail(`local-release.mjs: unknown command '${cmd}'`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main(process.argv.slice(2));
