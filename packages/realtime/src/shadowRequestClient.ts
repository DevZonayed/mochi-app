/**
 * shadowRequestClient — Phase 3A2a shared, portable signed-transport client for
 * the native-controller enrollment runtime (desktop host + Expo mobile).
 *
 * Both the host (Node) and the controller (React Native / Hermes) talk to the
 * relay's `/api/shadow/*` surface. Every enrolled request must carry the exact
 * Ed25519 request proof the server re-derives in
 * `apps/server/src/shadowRequestAuth.ts` — over
 *   method · normalized path+query · SHA-256(body) · accountId · deviceId ·
 *   keyId · timestampMs · nonce
 * This module reproduces that canonical proof against the injected
 * {@link ShadowCryptoBackend} (so it is byte-identical on Node and Hermes) and
 * wraps it in a strict transport (bounded timeout, response size cap, origin
 * allowlist, fresh nonce per attempt, no secret/header/body logging).
 *
 * It is deliberately platform-free: `fetch`, the clock, the CSPRNG nonce and
 * the crypto backend are all injected. The runtimes supply the platform
 * specifics; a byte-for-byte known-answer test against the server's own
 * `shadowRequestProofBytes` proves compatibility.
 */
import {
  base64urlEncode,
  structuredEncode,
  utf8Encode,
  type ShadowCryptoBackend,
} from './shadowCrypto.js';

/** Must match `SHADOW_REQUEST_PROOF_DOMAIN` in apps/server/src/shadowRequestAuth.ts. */
export const SHADOW_REQUEST_PROOF_DOMAIN = 'maestro.shadow.request-proof.v1';
/** Server tolerance is ±5 min; clients stamp with the injected clock. */
export const SHADOW_REQUEST_SKEW_MS = 5 * 60_000;

/** Canonical proof header names the enrolled surface expects. */
export const SHADOW_REQUEST_HEADERS = {
  device: 'x-maestro-device-id',
  keyId: 'x-maestro-shadow-key-id',
  timestamp: 'x-maestro-shadow-timestamp',
  nonce: 'x-maestro-shadow-nonce',
  signature: 'x-maestro-shadow-signature',
} as const;

/**
 * Deterministic path+query normalization — identical to the server's
 * `normalizePathQuery`: pathname verbatim, query params sorted by (key, value)
 * and re-encoded. Reordering query params cannot change the signed bytes.
 */
export function normalizePathQuery(rawUrl: string): string {
  const u = new URL(rawUrl, 'http://shadow.invalid');
  const params = [...u.searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const qs = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return u.pathname + (qs ? `?${qs}` : '');
}

export interface ShadowRequestProofInput {
  method: string;
  rawUrl: string;
  rawBody: string;
  accountId: string;
  deviceId: string;
  keyId: string;
  timestampMs: number;
  nonce: string;
}

/**
 * The exact bytes an enrolled client signs (portable mirror of the server's
 * `shadowRequestProofBytes`). The only difference from the server copy is that
 * the body SHA-256 is computed through the injected backend instead of
 * `node:crypto`, yielding identical output.
 */
export async function shadowRequestProofBytes(
  backend: ShadowCryptoBackend,
  input: ShadowRequestProofInput,
): Promise<Uint8Array> {
  const bodyHash = await backend.sha256(utf8Encode(input.rawBody));
  return structuredEncode(SHADOW_REQUEST_PROOF_DOMAIN, [
    input.method.toUpperCase(),
    normalizePathQuery(input.rawUrl),
    bodyHash,
    input.accountId,
    input.deviceId,
    input.keyId,
    input.timestampMs,
    input.nonce,
  ]);
}

/** Minimal fetch surface (Node 18+/RN/undici/whatwg all satisfy this). */
export type ShadowFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ShadowFetchResponse>;

export interface ShadowFetchResponse {
  readonly status: number;
  readonly ok?: boolean;
  text(): Promise<string>;
}

/** Better Auth account session + verified device identity. */
export interface ShadowSession {
  readonly accountId: string;
  readonly deviceId: string;
  /** Better Auth bearer token (sent as `Authorization: Bearer …`). */
  readonly sessionToken: string;
}

/** Signs enrolled-route proofs with the device's registered Ed25519 sign key. */
export interface ShadowRequestSigner {
  /** The active registered signing key id (fingerprint) for `deviceId`. */
  readonly keyId: string;
  /** Ed25519 signature over the canonical proof bytes. */
  sign(proofBytes: Uint8Array): Promise<Uint8Array>;
}

export interface ShadowTransportConfig {
  /** Relay origin, e.g. `https://api.nexalance.cloud` or `http://127.0.0.1:PORT`. */
  readonly baseUrl: string;
  readonly fetch: ShadowFetch;
  readonly backend: ShadowCryptoBackend;
  /** Injected monotonic-enough wall clock (ms). */
  readonly now: () => number;
  /**
   * Fresh CSPRNG nonce per attempt (base64url, matches server ID grammar). If
   * omitted, `backend.randomBytes` is used.
   */
  readonly randomNonce?: () => string;
  /** Allow `http://` to loopback hosts only (tests/dev). Default false. */
  readonly allowInsecureLoopback?: boolean;
  /** Hard per-request timeout. Default 15s. */
  readonly timeoutMs?: number;
  /** Response body cap (bytes of decoded text). Default 8 MiB. */
  readonly maxResponseBytes?: number;
}

export interface ShadowRequestOptions {
  readonly method: string;
  /** Path + query beginning with `/`, e.g. `/api/shadow/enroll/session`. */
  readonly path: string;
  /** JSON-serializable body; serialized once and both signed and sent. */
  readonly body?: unknown;
  /** Abort/cancel the request (composed with the timeout). */
  readonly signal?: AbortSignal;
}

export interface ShadowResponse<T = unknown> {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON (or undefined for empty bodies); `null` on non-JSON. */
  readonly json: T | undefined;
  /** Server `{ error }` message when `ok` is false, else undefined. */
  readonly error?: string;
}

/** Bounded, non-leaking transport error. Never carries secrets/headers/body. */
export class ShadowTransportError extends Error {
  readonly kind:
    | 'origin-not-allowed'
    | 'timeout'
    | 'network'
    | 'too-large'
    | 'bad-json';
  readonly status?: number;
  constructor(kind: ShadowTransportError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'ShadowTransportError';
    this.kind = kind;
    this.status = status;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function assertAllowedOrigin(baseUrl: string, allowInsecureLoopback: boolean): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new ShadowTransportError('origin-not-allowed', 'bad relay origin');
  }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && allowInsecureLoopback && LOOPBACK_HOSTS.has(u.hostname)) {
    return u;
  }
  throw new ShadowTransportError('origin-not-allowed', 'relay origin not allowed');
}

function joinUrl(base: URL, path: string): { url: string; rawUrl: string } {
  if (!path.startsWith('/')) throw new ShadowTransportError('origin-not-allowed', 'bad path');
  const trimmedBase = base.origin;
  return { url: `${trimmedBase}${path}`, rawUrl: path };
}

/**
 * Signed transport over the enrolled `/api/shadow/*` surface. Reused verbatim by
 * the desktop host runtime and the mobile controller runtime; only the injected
 * `fetch`/`backend`/clock/nonce differ.
 */
export class ShadowRequestClient {
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: ShadowTransportConfig) {
    this.origin = assertAllowedOrigin(config.baseUrl, config.allowInsecureLoopback ?? false);
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 8 * 1024 * 1024;
  }

  private nonce(): string {
    if (this.config.randomNonce) return this.config.randomNonce();
    // Leading 'n' guarantees the server ID grammar (first char alphanumeric):
    // a raw base64url string may begin with '-' or '_', which the proof-id regex
    // rejects.
    return 'n' + base64urlEncode(this.config.backend.randomBytes(18));
  }

  private serialize(body: unknown): string {
    if (body === undefined) return '';
    return JSON.stringify(body);
  }

  /**
   * Bootstrap request (session-only auth): Better Auth bearer + optional device
   * header. Used for host-identity registration and controller
   * enroll/request/poll, which authenticate via body-level signatures rather
   * than the enrolled proof.
   */
  async requestBootstrap<T = unknown>(
    session: ShadowSession,
    opts: ShadowRequestOptions & { includeDeviceId?: boolean },
  ): Promise<ShadowResponse<T>> {
    const rawBody = this.serialize(opts.body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${session.sessionToken}`,
    };
    if (rawBody !== '') headers['content-type'] = 'application/json';
    if (opts.includeDeviceId !== false) headers[SHADOW_REQUEST_HEADERS.device] = session.deviceId;
    return this.send<T>(opts.method, opts.path, rawBody, headers, opts.signal);
  }

  /**
   * Enrolled request: adds the five `x-maestro-shadow-*` proof headers. A fresh
   * nonce + timestamp are stamped and a new signature is produced on every call,
   * so a retry is always a distinct, replay-safe proof.
   */
  async requestEnrolled<T = unknown>(
    session: ShadowSession,
    signer: ShadowRequestSigner,
    opts: ShadowRequestOptions,
  ): Promise<ShadowResponse<T>> {
    const rawBody = this.serialize(opts.body);
    const timestampMs = this.config.now();
    const nonce = this.nonce();
    const proofBytes = await shadowRequestProofBytes(this.config.backend, {
      method: opts.method,
      rawUrl: opts.path,
      rawBody,
      accountId: session.accountId,
      deviceId: session.deviceId,
      keyId: signer.keyId,
      timestampMs,
      nonce,
    });
    const signature = base64urlEncode(await signer.sign(proofBytes));
    const headers: Record<string, string> = {
      authorization: `Bearer ${session.sessionToken}`,
      [SHADOW_REQUEST_HEADERS.device]: session.deviceId,
      [SHADOW_REQUEST_HEADERS.keyId]: signer.keyId,
      [SHADOW_REQUEST_HEADERS.timestamp]: String(timestampMs),
      [SHADOW_REQUEST_HEADERS.nonce]: nonce,
      [SHADOW_REQUEST_HEADERS.signature]: signature,
    };
    if (rawBody !== '') headers['content-type'] = 'application/json';
    return this.send<T>(opts.method, opts.path, rawBody, headers, opts.signal);
  }

  private async send<T>(
    method: string,
    path: string,
    rawBody: string,
    headers: Record<string, string>,
    external?: AbortSignal,
  ): Promise<ShadowResponse<T>> {
    const { url } = joinUrl(this.origin, path);
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: ShadowFetchResponse;
    try {
      res = await this.config.fetch(url, {
        method,
        headers,
        body: rawBody === '' ? undefined : rawBody,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted && !(external?.aborted)) {
        throw new ShadowTransportError('timeout', 'shadow request timed out');
      }
      throw new ShadowTransportError('network', 'shadow request failed');
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ShadowTransportError('network', 'shadow response read failed', res.status);
    }
    if (text.length > this.maxResponseBytes) {
      throw new ShadowTransportError('too-large', 'shadow response too large', res.status);
    }
    const ok = res.ok ?? (res.status >= 200 && res.status < 300);
    let json: T | undefined;
    if (text.trim() === '') {
      json = undefined;
    } else {
      try {
        json = JSON.parse(text) as T;
      } catch {
        if (ok) throw new ShadowTransportError('bad-json', 'shadow response not json', res.status);
        json = undefined;
      }
    }
    const error =
      !ok && json && typeof json === 'object' && 'error' in (json as Record<string, unknown>)
        ? String((json as Record<string, unknown>).error)
        : !ok
          ? 'request failed'
          : undefined;
    return { status: res.status, ok, json, error };
  }
}
