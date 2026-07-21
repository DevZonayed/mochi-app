/**
 * shadowErrorSanitize — Phase 3B0 NOTE-3 central bounded error mapper.
 *
 * ONE source of truth for turning an arbitrary thrown error (or error string)
 * into a SAFE, bounded, allowlisted message that may cross a trust boundary:
 * server JSON, command ACK, shadow event, relay storage, mobile SQLite, or a
 * product-captured log/error result.
 *
 * A message is EXPOSED verbatim only when it is short and free of any token that
 * could leak a filesystem path, a URL (with userinfo), a host:port, a stack
 * frame, an SQL/connection detail, a secret/token/hash, or a control character.
 * Everything else — and every UNEXPECTED / internal (statusCode-less or 5xx-
 * internal) failure — collapses to a stable generic string. Raw `err.message`
 * is NEVER echoed verbatim for internal failures.
 *
 * Deterministic, allocation-light, and time/regex-bounded (all patterns are
 * linear, anchored, with fixed quantifiers) so it is safe on every tier.
 */

/** Maximum length of a message that may cross a boundary as-is (generic mapper). */
export const SAFE_ERROR_MESSAGE_MAX_LEN = 200;
/** Wire ACK errors keep the historical 512 protocol bound (content still checked). */
export const SAFE_ACK_ERROR_MESSAGE_MAX_LEN = 512;
/** Stable generic message/code emitted for any unexpected/internal failure. */
export const GENERIC_ERROR_MESSAGE = 'internal error';
export const GENERIC_ERROR_CODE = 'internal';
/** Generic message used for a bounded command ACK whose reason is unsafe. */
export const GENERIC_ACK_ERROR_MESSAGE = 'command failed';

// A long opaque run is treated as a possible secret / token / hash / opaque id.
const OPAQUE_TOKEN_RE = /[A-Za-z0-9_-]{24,}/;
// A `:` immediately followed by a digit → host:port or a stack line:col.
const HOST_PORT_OR_STACK_RE = /:\d/;
// O-3: Unicode confusable SEPARATORS that stand in for `/`, `:`, `@` and are NOT
// folded to ASCII by NFKC (fullwidth forms ARE folded, and caught via the NFKC form).
const CONFUSABLE_SEPARATOR_RE = /[⁄∕⧸╱／∶：꞉׃։ⸯ＠﹫⦂﹕；]/;
// O-3: bracketed or hex-group IPv6 (base `:\d` check misses hextets like `db8`).
const IPV6_RE = /\[[0-9A-Fa-f:]+\]|(?:[0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4}/;
// O-3: SQL-statement shapes (injection payloads) — targeted so lone words like
// "select an option" are NOT rejected.
const SQL_SYNTAX_RE = /(union\s+select|select\s+[\s\S]*\s+from\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s|drop\s+(table|database)\s|;\s*(drop|delete|insert|update|select)\b|--\s|\/\*)/i;

/** Core content predicate over ONE concrete string form (no decoding). Linear/bounded. */
function baseUnsafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0x20 || c === 0x7f) return true; } // control chars
  if (s.includes('/') || s.includes('\\') || s.includes('~')) return true; // filesystem paths
  if (s.includes('://') || s.includes('@')) return true; // URLs / userinfo / emails
  if (s.includes('..')) return true; // parent-dir traversal / ellipsis
  if (HOST_PORT_OR_STACK_RE.test(s)) return true; // host:port / stack line:col
  if (OPAQUE_TOKEN_RE.test(s)) return true; // secrets / tokens / hashes / long ids
  if (CONFUSABLE_SEPARATOR_RE.test(s)) return true; // Unicode confusable `/` `:` `@`
  if (IPV6_RE.test(s)) return true; // hex-group / bracketed IPv6
  if (SQL_SYNTAX_RE.test(s)) return true; // SQL injection shapes
  return false;
}

/**
 * Expand `value` into the concrete forms an attacker could hide content behind:
 * the original, its NFKC normalization (folds fullwidth/compat confusables to
 * ASCII), and up to TWO bounded percent-decode passes of each (defeats `%2F` and
 * double-encoding `%252F`). Returns `null` if a percent-escape is malformed
 * (`decodeURIComponent` throws) — the whole string is then treated as unsafe.
 */
function candidateForms(value: string): string[] | null {
  const forms = new Set<string>();
  const seeds: string[] = [value];
  try { const n = value.normalize('NFKC'); if (n !== value) seeds.push(n); } catch { /* normalize never throws in practice */ }
  for (const seed of seeds) {
    forms.add(seed);
    let cur = seed;
    for (let pass = 0; pass < 2; pass++) {
      if (!/%[0-9A-Fa-f]{2}/.test(cur)) break; // no percent-escape → nothing to decode
      let dec: string;
      try { dec = decodeURIComponent(cur); } catch { return null; } // malformed escape → unsafe
      if (dec === cur) break;
      forms.add(dec);
      cur = dec;
    }
  }
  return [...forms];
}

/**
 * True iff `value` is a bounded, human-safe error string with no path / URL /
 * userinfo / host:port / stack / secret / IPv6 / SQL / control-char content —
 * evaluated over the ORIGINAL and every NFKC-normalized / percent-decoded form so
 * obfuscated content cannot slip through. `maxLen` defaults to the strict generic
 * bound; the wire ACK path passes 512. Regexes are linear/bounded; the candidate
 * value is never echoed on failure.
 */
export function isSafeBoundedErrorText(value: unknown, maxLen: number = SAFE_ERROR_MESSAGE_MAX_LEN): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > maxLen) return false;
  const forms = candidateForms(value);
  if (forms === null) return false; // malformed percent-escape
  for (const f of forms) {
    if (f.length > maxLen * 2) return false; // a decode that balloons length is suspect
    if (baseUnsafe(f)) return false;
  }
  return true;
}

/** Strict (≤200) safe-message predicate for the generic mapper. */
export function isSafeExternalErrorMessage(value: unknown): value is string {
  return isSafeBoundedErrorText(value, SAFE_ERROR_MESSAGE_MAX_LEN);
}

/** Return the message if safe, else a stable fallback (generic by default). */
export function sanitizeExternalErrorMessage(value: unknown, fallback: string = GENERIC_ERROR_MESSAGE): string {
  return isSafeExternalErrorMessage(value) ? value : fallback;
}

/** Bounded (≤512) wire-ACK message predicate (same content rules). */
export function isSafeAckErrorMessage(value: unknown): value is string {
  return isSafeBoundedErrorText(value, SAFE_ACK_ERROR_MESSAGE_MAX_LEN);
}

/** Sanitize an ACK error message at CONSTRUCTION (falls back to a generic string). */
export function sanitizeAckErrorMessage(value: unknown, fallback: string = GENERIC_ACK_ERROR_MESSAGE): string {
  return isSafeAckErrorMessage(value) ? value : fallback;
}
