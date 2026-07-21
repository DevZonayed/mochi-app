/**
 * errorSanitize — Phase 3B0 NOTE-3 server-side bounded error mapper.
 *
 * The relay's `forward()` catch used to echo `err.message` verbatim for any
 * statusCode-less failure (a raw 500), which could leak a filesystem path, a
 * stack frame, an SQL error, or a Postgres/HTTPS connection string (with
 * userinfo/password/token) straight into the client JSON body. This mapper is
 * the single chokepoint that decides what an error is allowed to say:
 *
 *   - An UNEXPECTED / internal failure (no explicit `statusCode`, or an internal
 *     500) always collapses to a stable generic `{ statusCode: 500, code:
 *     'internal', message: 'internal error' }` — the raw text never crosses.
 *   - An EXPLICIT typed/domain error (its own 4xx / 502 / 503 / 504 statusCode)
 *     keeps a SAFE, bounded message (via the shared realtime allowlist); an
 *     unsafe message still degrades to generic, so a domain error that happened
 *     to interpolate a path/secret cannot leak either.
 */
import {
  sanitizeExternalErrorMessage,
  GENERIC_ERROR_MESSAGE,
  GENERIC_ERROR_CODE,
} from '@maestro/realtime/shadowErrorSanitize';

export interface SanitizedForwardError {
  statusCode: number;
  message: string;
  code: string;
}

const SAFE_CODE_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Map an arbitrary caught value to a safe `{ statusCode, message, code }`.
 * Internal/unknown → generic 500; typed 4xx/5xx-domain → sanitized message.
 */
export function sanitizeForwardError(e: unknown): SanitizedForwardError {
  const err = (e ?? {}) as { statusCode?: unknown; message?: unknown; code?: unknown };
  const status = typeof err.statusCode === 'number' && Number.isInteger(err.statusCode) ? err.statusCode : undefined;

  // Unexpected/internal: no explicit status, an internal 500, or an out-of-range
  // status → generic. Raw exception text (paths, stacks, SQL, connection strings)
  // never leaves the server for these.
  if (status === undefined || status === 500 || status < 400 || status > 599) {
    return { statusCode: 500, message: GENERIC_ERROR_MESSAGE, code: GENERIC_ERROR_CODE };
  }

  // Explicit typed/domain error: preserve a SAFE bounded message, else generic.
  const message = sanitizeExternalErrorMessage(err.message, GENERIC_ERROR_MESSAGE);
  const code = typeof err.code === 'string' && SAFE_CODE_RE.test(err.code) ? err.code : 'request_failed';
  return { statusCode: status, message, code };
}
