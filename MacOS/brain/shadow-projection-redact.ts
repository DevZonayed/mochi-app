/**
 * shadow-projection-redact — Phase 3A2b1 Section B deterministic deep redactor.
 *
 * Defence-in-depth: the projection schema (`shadow-projection-schema.ts`) already
 * ALLOWLISTS only known-safe fields, but a legitimate allowlisted value (a title,
 * an error summary) could still embed a secret. This module is the second, generic
 * scrub applied to every projected payload before it is encrypted + published:
 *
 *   - bounded recursion (depth / keys-per-object / array length / string bytes /
 *     total serialized bytes) with deterministic truncation markers;
 *   - deny secret-bearing KEYS (token/secret/password/cookie/authorization/apiKey/
 *     privateKey/scopeKey/env/headers/credential/…) — value replaced, never echoed;
 *   - detect + redact secret VALUE patterns (bearer/JWT/PEM private key/common API
 *     key prefixes/long hex-or-base64 secrets/`.env` + secure-storage paths);
 *   - drop prototype-pollution keys (`__proto__`/constructor/prototype);
 *   - omit undefined/function/symbol; mark cycles + binary; canonical (sorted-key)
 *     output so the same input always yields byte-identical output.
 *
 * The redactor NEVER throws on hostile input and NEVER echoes a matched secret into
 * its output or its diagnostics — a redaction is reported only as a count + marker.
 */

export interface RedactBounds {
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
  maxStringBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_REDACT_BOUNDS: RedactBounds = {
  maxDepth: 8,
  maxKeys: 64,
  maxArray: 256,
  maxStringBytes: 4096,
  maxTotalBytes: 65_536,
};

export interface RedactResult {
  value: unknown;
  /** Number of values redacted/truncated/dropped. 0 → input was already clean. */
  redactions: number;
  /** True when the whole payload exceeded `maxTotalBytes` and was replaced fail-closed. */
  overflow: boolean;
}

/** Marker strings (constant, never contain a secret). */
const M_REDACTED_KEY = '[redacted]';
const M_REDACTED_VALUE = '[redacted]';
const M_MAX_DEPTH = '[max-depth]';
const M_CYCLE = '[cycle]';
const M_TRUNCATED = '…[truncated]';
const M_OVERFLOW = '[payload-too-large]';

/** Keys whose VALUE is always dropped (case-insensitive substring match). */
const DENY_KEY_PATTERNS: readonly RegExp[] = [
  /token/i, /secret/i, /password/i, /passwd/i, /cookie/i, /authorization/i,
  /\bauth\b/i, /apikey/i, /api[_-]?key/i, /privatekey/i, /private[_-]?key/i,
  /scopekey/i, /scope[_-]?key/i, /credential/i, /bearer/i, /pepper/i,
  /mnemonic/i, /passphrase/i, /\benv\b/i, /headers?/i, /session[_-]?token/i,
  /access[_-]?token/i, /refresh[_-]?token/i, /deck[_-]?secret/i, /\bpin\b/i,
  /signingkey/i, /agreementkey/i, /wrappedscopekey/i, /ciphertext/i,
];

/** Prototype-pollution keys — always dropped. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Secret VALUE patterns — the matched region is replaced (not the whole field). Every
 * pattern uses BOUNDED quantifiers over single character classes (no nested/overlapping
 * `(a+)+` groups), so none can backtrack catastrophically on hostile input, and none
 * captures + echoes the matched secret (the replacement is a constant marker).
 *
 * Ordered structured-first so a credential caught with its surrounding syntax
 * (connection string, stack frame, `key=value`, filesystem path) is neutralised before
 * the generic high-entropy catch-alls run.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  // ── connection-string / URL userinfo: scheme://[user[:pass]]@host → drop through the
  //    LAST '@' before a path/space (host after the '@' is kept; the credential is not).
  /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/]{1,256}@/g,                        // postgres://user:pass@ , https://ci-bot:tok@ , redis://u:p@x@
  // ── stack frames: "at fn (path:line:col)" (parens must hold a path/line, not prose).
  /\bat\s+[^\s()]{1,128}\s*\([^)\n]{0,256}[:/][^)\n]{0,64}\)/g,
  /\bat\s+\/[^\s)]{1,256}:\d{1,7}(?::\d{1,7})?/g,                              // at /abs/file:line:col
  // ── inline secrets: `password|token|secret|credential|api_key = / : value`.
  /\b(?:password|passwd|pwd|secret|token|credential|api[_-]?key)\b\s*[:=]\s*\S{1,256}/gi,
  // ── filesystem paths (home-rooted, common secret dirs, generic absolute, Windows, UNC).
  /\/(?:Users|home|root)\/[^\s"']{1,512}/g,                                    // /Users/alice/… , /home/… , /root/…
  /~\/[^\s"']{1,512}/g,                                                        // ~/…
  /\.(?:aws|ssh|kube|docker|gnupg)\/[^\s"']{1,256}/g,                          // .aws/credentials , .ssh/id_rsa
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/g,                                         // private-key filenames
  /(?<![A-Za-z0-9._~-])\/(?:[A-Za-z0-9._-]{1,64}\/){1,11}[A-Za-z0-9._-]{1,64}/g, // generic absolute POSIX path (>=2 segs, at a boundary)
  /\b[A-Za-z]:\\[^\s"'|<>]{1,512}/g,                                           // Windows drive path C:\…
  /\\\\[^\s\\"']{1,128}\\[^\s"'|<>]{1,512}/g,                                  // UNC \\server\share\…
  // ── high-entropy token catch-alls.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM private key
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,               // JWT
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,                                        // bearer token
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,                                              // anthropic key
  /\bsk-[A-Za-z0-9]{16,}/g,                                                    // openai-style key
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,                                             // github token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,                                           // github fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                                           // slack token
  /\bAKIA[0-9A-Z]{16}\b/g,                                                     // aws access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                                // google api key
  /\bfal_[A-Za-z0-9_-]{12,}/g,                                                 // fal key
  /\b[A-Fa-f0-9]{48,}\b/g,                                                     // long hex secret (>=48)
  /\b[A-Za-z0-9_-]{64,}\b/g,                                                   // long base64url secret (>=64)
  /(?:\/[^\s"']*)?\.env(?:\.[A-Za-z0-9]+)?\b/g,                                // .env path
  /(?:~|\/Users\/[^/\s"']+)\/Library\/Keychains\/[^\s"']*/g,                   // macOS keychain path
];

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function truncateString(s: string, maxBytes: number): { out: string; truncated: boolean } {
  if (utf8Bytes(s) <= maxBytes) return { out: s, truncated: false };
  // Trim by chars until under the byte budget minus the marker, deterministically.
  const budget = Math.max(0, maxBytes - utf8Bytes(M_TRUNCATED));
  let end = Math.min(s.length, budget);
  while (end > 0 && utf8Bytes(s.slice(0, end)) > budget) end--;
  return { out: s.slice(0, end) + M_TRUNCATED, truncated: true };
}

interface Ctx { bounds: RedactBounds; redactions: number }

function scrubStringValue(s: string, ctx: Ctx): string {
  let out = s;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, () => { ctx.redactions++; return M_REDACTED_VALUE; });
  }
  const { out: capped, truncated } = truncateString(out, ctx.bounds.maxStringBytes);
  if (truncated) ctx.redactions++;
  return capped;
}

function isDeniedKey(key: string): boolean {
  return DENY_KEY_PATTERNS.some((re) => re.test(key));
}

function redactNode(value: unknown, depth: number, seen: WeakSet<object>, ctx: Ctx): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return scrubStringValue(value as string, ctx);
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (t === 'boolean') return value;
  if (t === 'bigint') { ctx.redactions++; return `[bigint]`; }
  if (t === 'undefined' || t === 'function' || t === 'symbol') { ctx.redactions++; return undefined; }

  // object / array / binary
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    ctx.redactions++;
    const len = value instanceof ArrayBuffer ? value.byteLength : (value as ArrayBufferView).byteLength;
    return `[binary:${len}]`;
  }
  if (depth >= ctx.bounds.maxDepth) { ctx.redactions++; return M_MAX_DEPTH; }
  if (typeof value === 'object') {
    if (seen.has(value as object)) { ctx.redactions++; return M_CYCLE; }
    seen.add(value as object);
    let out: unknown;
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      const limit = Math.min(value.length, ctx.bounds.maxArray);
      for (let i = 0; i < limit; i++) {
        const child = redactNode(value[i], depth + 1, seen, ctx);
        arr.push(child === undefined ? null : child); // arrays keep positions; undefined→null
      }
      if (value.length > limit) { ctx.redactions++; arr.push(`[+${value.length - limit} more]`); }
      out = arr;
    } else {
      const src = value as Record<string, unknown>;
      // Deterministic: sort own enumerable string keys.
      const keys = Object.keys(src).filter((k) => !FORBIDDEN_KEYS.has(k)).sort();
      const obj: Record<string, unknown> = {};
      let kept = 0;
      for (const key of keys) {
        if (kept >= ctx.bounds.maxKeys) { obj.__truncated__ = true; ctx.redactions++; break; }
        if (isDeniedKey(key)) { obj[key] = M_REDACTED_KEY; ctx.redactions++; kept++; continue; }
        const child = redactNode(src[key], depth + 1, seen, ctx);
        if (child === undefined) continue; // omit undefined/function/symbol
        obj[key] = child;
        kept++;
      }
      out = obj;
    }
    seen.delete(value as object);
    return out;
  }
  ctx.redactions++;
  return null;
}

/**
 * Redact + bound an arbitrary value into a canonical, secret-free projection payload.
 * Never throws. If the scrubbed payload still exceeds `maxTotalBytes` it is replaced
 * with a bounded overflow marker (fail-closed), never a partial secret leak.
 */
export function redactProjectionPayload(value: unknown, bounds: RedactBounds = DEFAULT_REDACT_BOUNDS): RedactResult {
  const ctx: Ctx = { bounds, redactions: 0 };
  let scrubbed: unknown;
  try {
    scrubbed = redactNode(value, 0, new WeakSet<object>(), ctx);
  } catch {
    // Any unexpected hostile shape → fail closed to an inert marker.
    return { value: M_OVERFLOW, redactions: ctx.redactions + 1, overflow: true };
  }
  const serialized = canonicalStringify(scrubbed);
  if (utf8Bytes(serialized) > bounds.maxTotalBytes) {
    return { value: M_OVERFLOW, redactions: ctx.redactions + 1, overflow: true };
  }
  return { value: scrubbed, redactions: ctx.redactions, overflow: false };
}

/**
 * Deterministic JSON with sorted keys — the canonical form used both for the size
 * check and for the projection digest, so identical payloads hash identically.
 * Undefined/function values are already stripped by `redactNode`.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const v = src[key];
    if (v === undefined) continue;
    out[key] = sortDeep(v);
  }
  return out;
}
