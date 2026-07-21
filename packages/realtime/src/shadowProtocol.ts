import { isSafeAckErrorMessage } from './shadowErrorSanitize.js';

export const SHADOW_PROTOCOL_VERSION = 1 as const;
export const SHADOW_MAX_FUTURE_CLOCK_SKEW_MS = 60_000 as const;
export const SHADOW_PREVIEW_SESSION_MAX_TTL_MS = 15 * 60_000;
export const SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS = 5 * 60_000;
export const SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS = 10 * 60_000;
export const SHADOW_ASSET_CAPABILITY_MAX_TTL_MS = 10 * 60_000;
export const SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS = 2 * 60_000;
export const SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS = 15 * 60_000;
export const SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES = 256_000;

export type ShadowProtocolVersion = typeof SHADOW_PROTOCOL_VERSION;
export type ShadowTransport = 'relay' | 'lan' | 'webrtc-data';
export type ShadowPreviewMode = 'artifact' | 'web-tunnel' | 'pixel-stream';
export type ShadowAssetVariant = 'placeholder' | 'small' | 'medium' | 'screen' | 'original';
export type ShadowCollection =
  | 'workspace' | 'project' | 'session' | 'job' | 'approval' | 'schedule'
  | 'asset' | 'event' | 'settings' | 'question' | 'diff-summary'
  | 'blob-manifest' | 'command' | 'audit' | 'host-status';

export type AccountId = string & { readonly __brand: 'AccountId' };
export type DeviceId = string & { readonly __brand: 'DeviceId' };
export type HostDeviceId = DeviceId & { readonly __host: true };
export type ControllerDeviceId = DeviceId & { readonly __controller: true };
export type ScopeId = string & { readonly __brand: 'ScopeId' };
export type LeaseId = string & { readonly __brand: 'LeaseId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type CommandId = string & { readonly __brand: 'CommandId' };
export type SnapshotId = string & { readonly __brand: 'SnapshotId' };
export type ContentId = string & { readonly __brand: 'ContentId' };
export type ChunkId = ContentId & { readonly __chunk: true };
export type KeyId = string & { readonly __brand: 'KeyId' };

export interface ValidatedId<T extends string> {
  readonly value: string & { readonly __brand: T };
}

export interface Fence {
  accountId: string;
  scopeId: string;
  hostDeviceId: string;
  epoch: number;
  leaseId: string;
}

export interface ShadowConnectHello {
  protocolVersion: ShadowProtocolVersion;
  accountId?: string;
  scopeId?: string;
  controllerDeviceId?: string;
  hostDeviceId: string;
  epoch: number;
  lastSeq: number;
  snapshotId?: string;
  collectionDigests: Record<string, string>;
  supportedTransports?: ShadowTransport[];
}

export type ResumeDecision =
  | { decision: 'delta'; fromSeq: number; toSeq: number }
  | { decision: 'manifest-repair'; snapshotId: string; baseSeqHint?: number; replayFromSeq: number }
  | { decision: 'fenced'; reason: 'wrong-host' | 'stale-epoch' | 'future-epoch' }
  | { decision: 'incompatible'; supportedProtocolVersions: readonly number[] };

export interface ShadowStateEvent {
  v: ShadowProtocolVersion;
  eventId: string;
  seq: number;
  prevSeq: number;
  fence: Fence;
  collection: ShadowCollection;
  op: 'upsert' | 'delete' | 'patch' | 'checkpoint';
  entityId: string;
  revision: number;
  commandId?: string;
  durable: true;
  payloadCiphertext: string;
  payloadDigest: string;
  keyId: string;
  createdAt: number;
  signature: string;
}

export interface HostCommandAck {
  family?: 'command-ack';
  v: ShadowProtocolVersion;
  commandId: string;
  status: 'accepted' | 'rejected' | 'duplicate' | 'stale-epoch' | 'unauthorized' | 'expired' | 'host-busy';
  fence: Fence;
  acceptedSeq?: number;
  resultSeq?: number;
  duplicateOf?: string;
  error?: { code: string; message: string };
  signedAt: number;
  signature: string;
}

export interface FamilyMessage { family: string; v?: ShadowProtocolVersion }
export type ShadowWireMessage =
  | (ShadowConnectHello & { family: 'connect-hello' })
  | ({ family: 'connect-decision'; v: ShadowProtocolVersion } & ResumeDecision & { signedAt: number; signature: string })
  | (ShadowStateEvent & { family: 'state-event' })
  | { family: 'event-ack'; v: ShadowProtocolVersion; eventId: string; controllerDeviceId: string; fence: Fence; lastSeq: number; ackedAt: number; signature: string }
  | { family: 'cursor-ack'; v: ShadowProtocolVersion; controllerDeviceId: string; fence: Fence; lastSeq: number; snapshotId?: string; collectionDigests: Record<string, string>; ackedAt: number; signature: string }
  | { family: 'gap-repair-request'; v: ShadowProtocolVersion; controllerDeviceId: string; fence: Fence; fromSeq: number; toSeq: number; reason: 'gap' | 'digest-mismatch' | 'missing-snapshot'; requestedAt: number; signature: string }
  | { family: 'gap-repair-response'; v: ShadowProtocolVersion; fence: Fence; fromSeq: number; toSeq: number; eventIds: string[]; snapshotId?: string; createdAt: number; signature: string }
  | ShadowCommandEnvelope
  | HostCommandAck
  | { family: 'command-state'; v: ShadowProtocolVersion; commandId: string; fence: Fence; state: Exclude<CommandLifecycleStatus, 'pending-local'>; durable: boolean; seq?: number; createdAt: number; signature: string }
  | (SnapshotManifest & { family: 'snapshot-manifest' })
  | { family: 'snapshot-chunk-request'; v: ShadowProtocolVersion; snapshotId: string; contentId: string; range?: ByteRange; requestedAt: number; signature: string }
  | { family: 'snapshot-chunk-response'; v: ShadowProtocolVersion; snapshotId: string; contentId: string; range: ByteRange; ciphertextDigest: string; encryptedBytes: number; keyId: string; createdAt: number; signature: string }
  | { family: 'asset-manifest'; v: ShadowProtocolVersion; assetId: string; revisionId: string; fence: Fence; variants: Record<ShadowAssetVariant, BlobVariantRef>; createdAt: number; signature: string }
  | (BlobCapability & { family: 'asset-capability' })
  | { family: 'asset-range-request'; v: ShadowProtocolVersion; capabilityId: string; contentId: string; variant: ShadowAssetVariant; range: ByteRange; requestedAt: number; signature: string }
  | { family: 'asset-range-response'; v: ShadowProtocolVersion; capabilityId: string; contentId: string; variant: ShadowAssetVariant; range: ByteRange; ciphertextDigest: string; encryptedBytes: number; createdAt: number; signature: string }
  | (VisualSession & { family: 'preview-session' })
  | WebTunnelRequest
  | WebTunnelResponse
  | WebTunnelWsMessage
  | VisualFrame
  | { family: 'visual-control-grant'; v: ShadowProtocolVersion; grantId?: string; visualSessionId: string; fence: Fence; controllerDeviceId: string; mode: 'view-only' | 'control'; expiresAt: number; signedAt: number; signature: string }
  | (VisualInputEvent & { family: 'visual-input'; v: ShadowProtocolVersion })
  | { family: 'enrollment-request'; v: ShadowProtocolVersion; accountId: string; controllerDeviceId: string; devicePublicKeyId: string; requestedAt: number; signature: string }
  | { family: 'enrollment-grant'; v: ShadowProtocolVersion; fence: Fence; controllerDeviceId: string; grantId: string; expiresAt: number; keyId: string; signedAt: number; signature: string }
  | { family: 'device-revocation'; v: ShadowProtocolVersion; fence: Fence; controllerDeviceId: string; revokedAt: number; keyRotationId: string; signature: string }
  | { family: 'key-rotation'; v: ShadowProtocolVersion; fence: Fence; keyId: string; previousKeyId: string; effectiveSeq: number; createdAt: number; signature: string }
  | HandoffWireMessage;

export interface ShadowCommandEnvelope {
  family: 'command-envelope';
  v: ShadowProtocolVersion;
  commandId: string;
  idempotencyKey: string;
  controllerDeviceId: string;
  fence: Fence;
  method: string;
  paramsCiphertext: string;
  grantScopes: string[];
  createdAt: number;
  expiresAt: number;
  causality?: { afterSeq?: number; snapshotId?: string };
  signature: string;
}

export interface SnapshotChunkRef {
  contentId: string;
  collection: ShadowCollection;
  pageKey: string;
  entityCount: number;
  compressedBytes: number;
  encryptedBytes: number;
  plaintextDigest: string;
  ciphertextDigest: string;
  encryptionKeyId: string;
  nonce: string;
  compression: 'zstd' | 'gzip';
  encryption: 'xchacha20poly1305' | 'aes-256-gcm';
}

export interface SnapshotManifest {
  v: ShadowProtocolVersion;
  snapshotId: string;
  fence: Fence;
  baseSeq: number;
  schemaVersion: number;
  createdAt: number;
  collectionDigests: Partial<Record<ShadowCollection, string>>;
  chunks: SnapshotChunkRef[];
  manifestDigest: string;
  signature: string;
}

export interface BlobCapability {
  family?: 'asset-capability';
  v: ShadowProtocolVersion;
  capabilityId: string;
  fence: Fence;
  controllerDeviceId: string;
  assetId?: string;
  contentId: string;
  variant: string;
  permissions: Array<'read' | 'range-read' | 'pin-offline'>;
  expiresAt: number;
  signature: string;
}

export interface BlobVariantRef {
  contentId: string;
  variant: ShadowAssetVariant;
  bytes: number;
  sha256: string;
  mime: string;
  availableOffline: boolean;
}

export interface WebTunnelSession {
  v: ShadowProtocolVersion;
  tunnelId: string;
  fence: Fence;
  projectId: string;
  sessionId?: string;
  controllerDeviceId: string;
  allowedLoopbackPort: number;
  allowedOrigin: string;
  route: string;
  expiresAt: number;
}

export interface WebTunnelRequest {
  family: 'web-tunnel-http-request';
  v: ShadowProtocolVersion;
  tunnelId: string;
  requestId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  path: string;
  headers: Record<string, string>;
  bodyContentId?: string;
  createdAt: number;
  signature: string;
}

export interface WebTunnelResponse {
  family: 'web-tunnel-http-response';
  v: ShadowProtocolVersion;
  tunnelId: string;
  requestId: string;
  status: number;
  headers: Record<string, string>;
  bodyContentId?: string;
  etag?: string;
  range?: string;
  createdAt: number;
  signature: string;
}

export interface WebTunnelWsMessage {
  family: 'web-tunnel-ws';
  v: ShadowProtocolVersion;
  tunnelId: string;
  streamId: string;
  frameSeq: number;
  kind: 'open' | 'frame' | 'close';
  path?: string;
  headers?: Record<string, string>;
  dataContentId?: string;
  code?: number;
  reason?: string;
  createdAt: number;
  signature: string;
}

export interface VisualSession {
  v: ShadowProtocolVersion;
  visualSessionId: string;
  fence: Fence;
  controllerDeviceId: string;
  source: 'browser' | 'native-window' | 'design' | 'host-app' | 'file-preview';
  mode: ShadowPreviewMode;
  inputMode: 'view-only' | 'control';
  transport: 'relay-frame' | 'lan' | 'webrtc-direct' | 'webrtc-turn' | 'encrypted-relay';
  projectId?: string;
  sessionId?: string;
  surfaceId?: string;
  expiresAt: number;
  signature: string;
}

export interface VisualFrame {
  family: 'visual-frame';
  v: ShadowProtocolVersion;
  visualSessionId: string;
  frameSeq: number;
  hostStateSeq: number;
  projectRevision?: string;
  contentId?: string;
  timestamp: number;
  codec: 'h264' | 'jpeg' | 'png';
  keyframe: boolean;
  signature: string;
}

export interface VisualInputEvent {
  family?: 'visual-input';
  v?: ShadowProtocolVersion;
  visualSessionId: string;
  fence?: Fence;
  inputSeq: number;
  frameSeqSeen: number;
  kind: 'pointer' | 'tap' | 'scroll' | 'key' | 'resize';
  viewport: { width: number; height: number; scale: number };
  payloadCiphertext: string;
  createdAt: number;
  signature: string;
}

export type HandoffWireMessage =
  | { family: 'handoff-prepare'; v: ShadowProtocolVersion; scopeId: string; fromHostDeviceId: string; toHostDeviceId: string; currentEpoch: number; reason: string; requestedAt: number; signature: string }
  | { family: 'handoff-quiesced'; v: ShadowProtocolVersion; oldFence: Fence; finalSnapshotId: string; finalBaseSeq: number; quiescedAt: number; signature: string }
  | { family: 'handoff-grant'; v: ShadowProtocolVersion; oldFence: Fence; newFence: Fence; finalSnapshotId: string; finalBaseSeq: number; oldHostFenceExpiresAt: number; secretReauthRequired: boolean; serverSignature: string }
  | { family: 'handoff-commit'; v: ShadowProtocolVersion; oldFence: Fence; newFence: Fence; committedAt: number; signature: string }
  | { family: 'handoff-abort'; v: ShadowProtocolVersion; oldFence: Fence; reason: string; abortedAt: number; signature: string }
  | { family: 'handoff-fenced'; v: ShadowProtocolVersion; oldFence: Fence; newEpoch: number; fencedAt: number; signature: string };

export interface AuthorityContext {
  fence: Fence;
  leaseExpiresAt: number;
  revokedControllerDeviceIds?: ReadonlySet<string>;
}

export interface ShadowCursor {
  fence: Fence;
  lastSeq: number;
  lastEventId: string | null;
  lastDigest: string | null;
  history?: ReadonlyArray<{ seq: number; eventId: string; payloadDigest: string }>;
}

export type CommandLifecycleStatus =
  | 'pending-local' | 'sent' | 'accepted' | 'executing' | 'awaiting-state-event' | 'applied'
  | 'rejected' | 'expired' | 'cancelled' | 'stale-epoch' | 'unauthorized' | 'conflict' | 'revoked';

export interface CommandLifecycleState {
  status: CommandLifecycleStatus;
  commandId: string;
  fence: Fence;
  createdAt: number;
  expiresAt: number;
  ack?: HostCommandAck;
  resultSeq?: number;
  pendingEvent?: Pick<ShadowStateEvent, 'eventId' | 'seq' | 'commandId'>;
  appliedEventId?: string;
  rejectReason?: string;
}

function decodeAckError(value: unknown): DecodeResult<{ code: string; message: string }> {
  if (!isRecord(value) || !exactKeys(value, ['code', 'message'])) return fail('bad-ack-error');
  // Phase 3B0 NOTE-3: an ACK error message crosses into the controller's product
  // error result / persisted reject_reason, so it is fail-closed against any path,
  // URL/userinfo, host:port, stack, secret/token, or control-char content (the old
  // `isPathLike` check only caught a leading path, missing embedded canaries).
  if (!isSafeId(value.code) || !isSafeAckErrorMessage(value.message)) return fail('bad-ack-error');
  return ok({ code: value.code, message: value.message });
}

type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface ShadowDecodeContext { nowMs?: number }
type NormalizedShadowDecodeContext = { nowMs: number };
export type ShadowTtlFamily = 'preview-session' | 'visual-control-grant' | 'enrollment-grant' | 'asset-capability' | 'command-envelope' | 'web-tunnel-session';

const COLLECTIONS: ReadonlySet<string> = new Set<ShadowCollection>([
  'workspace', 'project', 'session', 'job', 'approval', 'schedule',
  'asset', 'event', 'settings', 'question', 'diff-summary',
  'blob-manifest', 'command', 'audit', 'host-status',
]);
const TRANSPORTS: ReadonlySet<string> = new Set<ShadowTransport>(['relay', 'lan', 'webrtc-data']);
const EVENT_OPS = new Set(['upsert', 'delete', 'patch', 'checkpoint']);
const ACK_STATUSES = new Set(['accepted', 'rejected', 'duplicate', 'stale-epoch', 'unauthorized', 'expired', 'host-busy']);
const VISUAL_INPUT_KINDS = new Set(['pointer', 'tap', 'scroll', 'key', 'resize']);
const COMMAND_STATUSES = new Set<CommandLifecycleStatus>(['pending-local', 'sent', 'accepted', 'executing', 'awaiting-state-event', 'applied', 'rejected', 'expired', 'cancelled', 'stale-epoch', 'unauthorized', 'conflict', 'revoked']);
const TERMINAL_COMMAND_STATUSES = new Set<CommandLifecycleStatus>(['applied', 'rejected', 'expired', 'cancelled', 'stale-epoch', 'unauthorized', 'conflict', 'revoked']);
const ASSET_VARIANTS = new Set<ShadowAssetVariant>(['placeholder', 'small', 'medium', 'screen', 'original']);
const PREVIEW_MODES = new Set<ShadowPreviewMode>(['artifact', 'web-tunnel', 'pixel-stream']);
const TUNNEL_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const WS_KINDS = new Set(['open', 'frame', 'close']);
const SAFE_HEADERS = new Set(['accept', 'accept-language', 'cache-control', 'content-type', 'if-none-match', 'if-modified-since', 'range', 'x-maestro-preview']);
const PATH_OR_PLAINTEXT_KEYS = new Set(['payload', 'plaintext', 'secret', 'content', 'localPath', 'filePath', 'bytes', 'base64', 'assetBytes', 'rawTcpTarget', 'url', 'host']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIGEST_RE = /^sha256:[A-Za-z0-9_-]{16,128}$/;
const CID_RE = /^cid_[A-Za-z0-9_.:-]{1,160}$/;
const SIG_RE = /^[A-Za-z0-9_.:=+/:-]{3,512}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail<T>(reason: string): DecodeResult<T> {
  return { ok: false, reason };
}

function ok<T>(value: T): DecodeResult<T> {
  return { ok: true, value };
}

function hasForbiddenPayloadKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenPayloadKeys);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (PATH_OR_PLAINTEXT_KEYS.has(key) && !(key === 'bytes' && typeof child === 'number')) return true;
    if (key.toLowerCase().includes('secret') && key !== 'secretReauthRequired') return true;
    if (key.toLowerCase().includes('plaintext') && key !== 'plaintextDigest') return true;
    return hasForbiddenPayloadKeys(child);
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function optionalExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value) && !isPathLike(value);
}

function isContentId(value: unknown): value is string {
  return typeof value === 'string' && (CID_RE.test(value) || isSafeId(value)) && !isPathLike(value);
}

function isPathLike(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.startsWith('/') || value.startsWith('~') || value.includes('\\') || value.includes('../') || value.includes('..\\') || /^[a-z]+:\/\//i.test(value);
}

function isSafeSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeShadowDecodeContext(context: ShadowDecodeContext = {}): DecodeResult<NormalizedShadowDecodeContext> {
  if (context.nowMs !== undefined) {
    if (!isFiniteTime(context.nowMs)) return fail('bad-now');
    return ok({ nowMs: context.nowMs });
  }
  const nowMs = Date.now();
  if (!isFiniteTime(nowMs)) return fail('bad-now');
  return ok({ nowMs });
}

function isSignature(value: unknown): value is string {
  return typeof value === 'string' && SIG_RE.test(value) && !isPathLike(value);
}

function signed(value: Record<string, unknown>, timeKey: 'signedAt' | 'createdAt' | 'ackedAt' | 'requestedAt' | 'revokedAt' | 'quiescedAt' | 'committedAt' | 'abortedAt' | 'fencedAt' = 'createdAt'): DecodeResult<{ time: number; signature: string }> {
  if (!isFiniteTime(value[timeKey]) || !isSignature(value.signature)) return fail('bad-signature');
  return ok({ time: value[timeKey], signature: value.signature });
}

export function shadowCapabilityMaxTtlMs(family: ShadowTtlFamily): number {
  switch (family) {
    case 'preview-session': return SHADOW_PREVIEW_SESSION_MAX_TTL_MS;
    case 'visual-control-grant': return SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS;
    case 'enrollment-grant': return SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS;
    case 'asset-capability': return SHADOW_ASSET_CAPABILITY_MAX_TTL_MS;
    case 'command-envelope': return SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS;
    case 'web-tunnel-session': return SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS;
  }
}

export function validateShadowCapabilityTiming(input: {
  family: ShadowTtlFamily;
  expiresAt: unknown;
  sourceAt?: unknown;
  nowMs: number;
}): DecodeResult<true> {
  if (!isFiniteTime(input.expiresAt)) return fail('bad-expiry');
  if (!isFiniteTime(input.nowMs)) return fail('bad-now');
  const expiresAt = input.expiresAt;
  const maxTtl = shadowCapabilityMaxTtlMs(input.family);
  if (input.sourceAt !== undefined) {
    if (!isFiniteTime(input.sourceAt)) return fail('bad-source-time');
    const sourceAt = input.sourceAt;
    if (expiresAt <= sourceAt) return fail('bad-time-order');
    if (expiresAt - sourceAt > maxTtl) return fail('ttl-exceeded');
    if (sourceAt > input.nowMs + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS) return fail('source-future-skew');
  }
  if (input.nowMs >= expiresAt) return fail('expired');
  if (expiresAt > input.nowMs + maxTtl + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS) return fail('expiry-future-skew');
  return ok(true);
}

function decodeFence(value: unknown): DecodeResult<Fence> {
  if (!isRecord(value)) return fail('missing-fence');
  if (!exactKeys(value, ['accountId', 'scopeId', 'hostDeviceId', 'epoch', 'leaseId'])) return fail('bad-fence-shape');
  if (!isSafeId(value.accountId) || !isSafeId(value.scopeId) || !isSafeId(value.hostDeviceId) || !isSafeId(value.leaseId)) return fail('bad-fence-id');
  if (!isPositiveSafeInt(value.epoch)) return fail('bad-epoch');
  return ok({
    accountId: value.accountId,
    scopeId: value.scopeId,
    hostDeviceId: value.hostDeviceId,
    epoch: value.epoch,
    leaseId: value.leaseId,
  });
}

export function parseAccountId(value: unknown): DecodeResult<AccountId> { return isSafeId(value) ? ok(value as AccountId) : fail('bad-account-id'); }
export function parseDeviceId(value: unknown): DecodeResult<DeviceId> { return isSafeId(value) ? ok(value as DeviceId) : fail('bad-device-id'); }
export function parseHostDeviceId(value: unknown): DecodeResult<HostDeviceId> { return isSafeId(value) ? ok(value as HostDeviceId) : fail('bad-host-device-id'); }
export function parseControllerDeviceId(value: unknown): DecodeResult<ControllerDeviceId> { return isSafeId(value) ? ok(value as ControllerDeviceId) : fail('bad-controller-device-id'); }
export function parseScopeId(value: unknown): DecodeResult<ScopeId> { return isSafeId(value) ? ok(value as ScopeId) : fail('bad-scope-id'); }
export function parseLeaseId(value: unknown): DecodeResult<LeaseId> { return isSafeId(value) ? ok(value as LeaseId) : fail('bad-lease-id'); }
export function parseSessionId(value: unknown): DecodeResult<SessionId> { return isSafeId(value) ? ok(value as SessionId) : fail('bad-session-id'); }
export function parseEventId(value: unknown): DecodeResult<EventId> { return isSafeId(value) ? ok(value as EventId) : fail('bad-event-id'); }
export function parseCommandId(value: unknown): DecodeResult<CommandId> { return isSafeId(value) ? ok(value as CommandId) : fail('bad-command-id'); }
export function parseSnapshotId(value: unknown): DecodeResult<SnapshotId> { return isSafeId(value) ? ok(value as SnapshotId) : fail('bad-snapshot-id'); }
export function parseContentId(value: unknown): DecodeResult<ContentId> { return isContentId(value) ? ok(value as ContentId) : fail('bad-content-id'); }
export function parseChunkId(value: unknown): DecodeResult<ChunkId> { return isContentId(value) ? ok(value as ChunkId) : fail('bad-chunk-id'); }
export function parseKeyId(value: unknown): DecodeResult<KeyId> { return isSafeId(value) ? ok(value as KeyId) : fail('bad-key-id'); }
export function parseDigest(value: unknown): DecodeResult<string> { return digest(value) ? ok(value) : fail('bad-digest'); }

function sameFence(a: Fence, b: Fence): boolean {
  return a.accountId === b.accountId && a.scopeId === b.scopeId && a.hostDeviceId === b.hostDeviceId && a.epoch === b.epoch && a.leaseId === b.leaseId;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function decodeStringRecord(value: unknown, options: { collectionKeysOnly?: boolean } = {}): DecodeResult<Record<string, string>> {
  if (!isRecord(value)) return fail('bad-digests');
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (options.collectionKeysOnly && !COLLECTIONS.has(key)) return fail('bad-digest-collection');
    if (!isSafeId(key) || typeof val !== 'string' || isPathLike(val)) return fail('bad-digest-entry');
    out[key] = val;
  }
  return ok(out);
}

export function decodeShadowConnectHello(value: unknown): DecodeResult<ShadowConnectHello> {
  if (!isRecord(value)) return fail('not-object');
  if (!optionalExactKeys(value, ['protocolVersion', 'hostDeviceId', 'epoch', 'lastSeq', 'collectionDigests'], ['family', 'accountId', 'scopeId', 'controllerDeviceId', 'snapshotId', 'supportedTransports'])) return fail('bad-hello-shape');
  if (value.protocolVersion !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  if (!isSafeId(value.hostDeviceId)) return fail('bad-host');
  if (!isPositiveSafeInt(value.epoch)) return fail('bad-epoch');
  if (!isSafeSeq(value.lastSeq)) return fail('bad-last-seq');
  if (value.accountId !== undefined && !isSafeId(value.accountId)) return fail('bad-account');
  if (value.scopeId !== undefined && !isSafeId(value.scopeId)) return fail('bad-scope');
  if (value.controllerDeviceId !== undefined && !isSafeId(value.controllerDeviceId)) return fail('bad-controller');
  if (value.snapshotId !== undefined && !isSafeId(value.snapshotId)) return fail('bad-snapshot');
  const digests = decodeStringRecord(value.collectionDigests);
  if (!digests.ok) return digests;
  if (value.supportedTransports !== undefined) {
    if (!Array.isArray(value.supportedTransports) || value.supportedTransports.some((t) => typeof t !== 'string' || !TRANSPORTS.has(t))) return fail('bad-transport');
  }
  return ok({
    protocolVersion: SHADOW_PROTOCOL_VERSION,
    accountId: value.accountId,
    scopeId: value.scopeId,
    controllerDeviceId: value.controllerDeviceId,
    hostDeviceId: value.hostDeviceId,
    epoch: value.epoch,
    lastSeq: value.lastSeq,
    snapshotId: value.snapshotId,
    collectionDigests: digests.value,
    supportedTransports: value.supportedTransports as ShadowTransport[] | undefined,
  });
}

function decodeStateEvent(value: Record<string, unknown>): DecodeResult<ShadowStateEvent> {
  if (!optionalExactKeys(value, ['family', 'v', 'eventId', 'seq', 'prevSeq', 'fence', 'collection', 'op', 'entityId', 'revision', 'durable', 'payloadCiphertext', 'payloadDigest', 'keyId', 'createdAt', 'signature'], ['commandId'])) return fail('bad-state-event-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  if (hasForbiddenPayloadKeys(value)) return fail('plaintext-or-path-field');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.eventId) || !isSafeSeq(value.seq) || !isSafeSeq(value.prevSeq)) return fail('bad-sequence');
  if (value.seq !== 0 && value.prevSeq >= value.seq) return fail('bad-prev-seq');
  if (typeof value.collection !== 'string' || !COLLECTIONS.has(value.collection)) return fail('bad-collection');
  if (typeof value.op !== 'string' || !EVENT_OPS.has(value.op)) return fail('bad-op');
  if (!isSafeId(value.entityId) || !isPositiveSafeInt(value.revision)) return fail('bad-entity');
  if (value.commandId !== undefined && !isSafeId(value.commandId)) return fail('bad-command');
  if (value.durable !== true || typeof value.payloadCiphertext !== 'string' || value.payloadCiphertext.length === 0 || value.payloadCiphertext.length > SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES || !digest(value.payloadDigest) || !isSafeId(value.keyId)) return fail('bad-encrypted-payload');
  const sig = signed(value);
  if (!sig.ok) return fail('bad-signature');
  return ok({
    v: SHADOW_PROTOCOL_VERSION,
    eventId: value.eventId,
    seq: value.seq,
    prevSeq: value.prevSeq,
    fence: fenceResult.value,
    collection: value.collection as ShadowCollection,
    op: value.op as ShadowStateEvent['op'],
    entityId: value.entityId,
    revision: value.revision,
    commandId: value.commandId,
    durable: true,
    payloadCiphertext: value.payloadCiphertext,
    payloadDigest: value.payloadDigest,
    keyId: value.keyId,
    createdAt: sig.value.time,
    signature: sig.value.signature,
  });
}

function decodeAck(value: Record<string, unknown>): DecodeResult<HostCommandAck> {
  if (!optionalExactKeys(value, ['family', 'v', 'commandId', 'status', 'fence', 'signedAt', 'signature'], ['acceptedSeq', 'resultSeq', 'duplicateOf', 'error'])) return fail('bad-ack-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.commandId) || typeof value.status !== 'string' || !ACK_STATUSES.has(value.status)) return fail('bad-ack');
  if (value.acceptedSeq !== undefined && !isSafeSeq(value.acceptedSeq)) return fail('bad-accepted-seq');
  if (value.resultSeq !== undefined && !isSafeSeq(value.resultSeq)) return fail('bad-result-seq');
  if (value.status === 'accepted') {
    if (value.acceptedSeq === undefined) return fail('missing-accepted-seq');
    if (value.resultSeq !== undefined && value.resultSeq < value.acceptedSeq) return fail('bad-result-boundary');
    if (value.duplicateOf !== undefined || value.error !== undefined) return fail('bad-accepted-ack-fields');
  } else if (value.status === 'duplicate') {
    if (value.duplicateOf === undefined || value.resultSeq === undefined) return fail('missing-duplicate-result');
    if (value.acceptedSeq !== undefined || value.error !== undefined) return fail('bad-duplicate-ack-fields');
  } else if (value.status === 'host-busy') {
    if (value.acceptedSeq !== undefined || value.resultSeq !== undefined || value.duplicateOf !== undefined || value.error !== undefined) return fail('bad-host-busy-fields');
  } else {
    if (value.acceptedSeq !== undefined || value.resultSeq !== undefined || value.duplicateOf !== undefined) return fail('terminal-ack-result-seq');
    const err = decodeAckError(value.error);
    if (!err.ok) return err;
  }
  if (value.duplicateOf !== undefined && !isSafeId(value.duplicateOf)) return fail('bad-duplicate');
  const sig = signed(value, 'signedAt');
  if (!sig.ok) return fail('bad-signature');
  const error = value.error === undefined ? undefined : decodeAckError(value.error);
  if (error !== undefined && !error.ok) return error;
  return ok({
    v: SHADOW_PROTOCOL_VERSION,
    family: 'command-ack',
    commandId: value.commandId,
    status: value.status as HostCommandAck['status'],
    fence: fenceResult.value,
    acceptedSeq: value.acceptedSeq,
    resultSeq: value.resultSeq,
    duplicateOf: value.duplicateOf,
    error: error?.value,
    signedAt: sig.value.time,
    signature: sig.value.signature,
  });
}

export function hostCommandAckSemanticallyEqual(left: HostCommandAck, right: HostCommandAck): boolean {
  return left.family === right.family
    && left.v === right.v
    && left.commandId === right.commandId
    && left.status === right.status
    && sameFence(left.fence, right.fence)
    && left.acceptedSeq === right.acceptedSeq
    && left.resultSeq === right.resultSeq
    && left.duplicateOf === right.duplicateOf
    && (left.error?.code ?? undefined) === (right.error?.code ?? undefined)
    && (left.error?.message ?? undefined) === (right.error?.message ?? undefined)
    && left.signedAt === right.signedAt
    && left.signature === right.signature;
}

function decodeChunk(value: unknown): DecodeResult<SnapshotChunkRef> {
  if (!isRecord(value)) return fail('bad-chunk');
  if (!exactKeys(value, ['contentId', 'collection', 'pageKey', 'entityCount', 'compressedBytes', 'encryptedBytes', 'plaintextDigest', 'ciphertextDigest', 'encryptionKeyId', 'nonce', 'compression', 'encryption'])) return fail('bad-chunk-shape');
  if (!isContentId(value.contentId) || typeof value.collection !== 'string' || !COLLECTIONS.has(value.collection) || typeof value.pageKey !== 'string' || value.pageKey.length === 0 || value.pageKey.length > 256 || isPathLike(value.pageKey)) return fail('bad-chunk-id');
  if (!isSafeSeq(value.entityCount) || !isPositiveSafeInt(value.compressedBytes) || !isPositiveSafeInt(value.encryptedBytes) || value.encryptedBytes > SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES) return fail('bad-chunk-size');
  if (!digest(value.plaintextDigest) || !digest(value.ciphertextDigest) || !isSafeId(value.encryptionKeyId) || !isSafeId(value.nonce)) return fail('bad-chunk-crypto');
  if (value.compression !== 'zstd' && value.compression !== 'gzip') return fail('bad-compression');
  if (value.encryption !== 'xchacha20poly1305' && value.encryption !== 'aes-256-gcm') return fail('bad-encryption');
  return ok({
    contentId: value.contentId,
    collection: value.collection as ShadowCollection,
    pageKey: value.pageKey,
    entityCount: value.entityCount,
    compressedBytes: value.compressedBytes,
    encryptedBytes: value.encryptedBytes,
    plaintextDigest: value.plaintextDigest,
    ciphertextDigest: value.ciphertextDigest,
    encryptionKeyId: value.encryptionKeyId,
    nonce: value.nonce,
    compression: value.compression,
    encryption: value.encryption,
  });
}

function decodeSnapshotManifest(value: Record<string, unknown>): DecodeResult<SnapshotManifest> {
  if (!optionalExactKeys(value, ['family', 'v', 'snapshotId', 'fence', 'baseSeq', 'schemaVersion', 'createdAt', 'collectionDigests', 'chunks', 'manifestDigest', 'signature'])) return fail('bad-manifest-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  if (hasForbiddenPayloadKeys(value)) return fail('plaintext-or-path-field');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.snapshotId) || !isSafeSeq(value.baseSeq) || !isPositiveSafeInt(value.schemaVersion) || !isFiniteTime(value.createdAt)) return fail('bad-manifest');
  const digests = decodeStringRecord(value.collectionDigests, { collectionKeysOnly: true });
  if (!digests.ok) return digests;
  if (!Array.isArray(value.chunks)) return fail('bad-chunks');
  const chunks: SnapshotChunkRef[] = [];
  const seenPages = new Set<string>();
  const seenContentIds = new Set<string>();
  for (const chunk of value.chunks) {
    const decoded = decodeChunk(chunk);
    if (!decoded.ok) return decoded;
    const pageKey = `${decoded.value.collection}:${decoded.value.pageKey}`;
    if (seenPages.has(pageKey)) return fail('duplicate-chunk-page');
    if (seenContentIds.has(decoded.value.contentId)) return fail('duplicate-chunk-content');
    seenPages.add(pageKey);
    seenContentIds.add(decoded.value.contentId);
    chunks.push(decoded.value);
  }
  if (!digest(value.manifestDigest) || typeof value.signature !== 'string') return fail('bad-manifest-signature');
  return ok({ v: SHADOW_PROTOCOL_VERSION, snapshotId: value.snapshotId, fence: fenceResult.value, baseSeq: value.baseSeq, schemaVersion: value.schemaVersion, createdAt: value.createdAt, collectionDigests: digests.value as Partial<Record<ShadowCollection, string>>, chunks, manifestDigest: value.manifestDigest, signature: value.signature });
}

function decodeSignedSeqMessage(value: Record<string, unknown>, family: ShadowWireMessage['family']): DecodeResult<ShadowWireMessage> {
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  if (hasForbiddenPayloadKeys(value)) return fail('plaintext-or-path-field');
  if (!signed(value, family === 'event-ack' || family === 'cursor-ack' ? 'ackedAt' : family === 'gap-repair-request' ? 'requestedAt' : 'createdAt').ok) return fail('bad-signature');
  if (family === 'event-ack') {
    if (!optionalExactKeys(value, ['family', 'v', 'eventId', 'controllerDeviceId', 'fence', 'lastSeq', 'ackedAt', 'signature'])) return fail('bad-event-ack-shape');
    if (!isSafeId(value.eventId) || !isSafeId(value.controllerDeviceId) || !isSafeSeq(value.lastSeq)) return fail('bad-event-ack');
  } else if (family === 'cursor-ack') {
    if (!optionalExactKeys(value, ['family', 'v', 'controllerDeviceId', 'fence', 'lastSeq', 'collectionDigests', 'ackedAt', 'signature'], ['snapshotId'])) return fail('bad-cursor-ack-shape');
    if (!isSafeId(value.controllerDeviceId) || !isSafeSeq(value.lastSeq) || (value.snapshotId !== undefined && !isSafeId(value.snapshotId))) return fail('bad-cursor-ack');
    const digests = decodeStringRecord(value.collectionDigests);
    if (!digests.ok) return digests;
  } else if (family === 'gap-repair-request') {
    if (!optionalExactKeys(value, ['family', 'v', 'controllerDeviceId', 'fence', 'fromSeq', 'toSeq', 'reason', 'requestedAt', 'signature'])) return fail('bad-gap-request-shape');
    if (!isSafeId(value.controllerDeviceId) || !isSafeSeq(value.fromSeq) || !isSafeSeq(value.toSeq) || value.toSeq < value.fromSeq || (value.reason !== 'gap' && value.reason !== 'digest-mismatch' && value.reason !== 'missing-snapshot')) return fail('bad-gap-request');
  } else {
    if (!optionalExactKeys(value, ['family', 'v', 'fence', 'fromSeq', 'toSeq', 'eventIds', 'createdAt', 'signature'], ['snapshotId'])) return fail('bad-gap-response-shape');
    if (!isSafeSeq(value.fromSeq) || !isSafeSeq(value.toSeq) || value.toSeq < value.fromSeq || !Array.isArray(value.eventIds) || value.eventIds.some((id) => !isSafeId(id)) || (value.snapshotId !== undefined && !isSafeId(value.snapshotId))) return fail('bad-gap-response');
  }
  return ok(value as unknown as ShadowWireMessage);
}

function decodeCommandEnvelope(value: Record<string, unknown>, context: NormalizedShadowDecodeContext): DecodeResult<ShadowCommandEnvelope> {
  if (!optionalExactKeys(value, ['family', 'v', 'commandId', 'idempotencyKey', 'controllerDeviceId', 'fence', 'method', 'paramsCiphertext', 'grantScopes', 'createdAt', 'expiresAt', 'signature'], ['causality'])) return fail('bad-command-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION || hasForbiddenPayloadKeys(value)) return fail('bad-command');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.commandId) || !isSafeId(value.idempotencyKey) || !isSafeId(value.controllerDeviceId) || !isSafeId(value.method)) return fail('bad-command-id');
  if (typeof value.paramsCiphertext !== 'string' || value.paramsCiphertext.length === 0 || !Array.isArray(value.grantScopes) || value.grantScopes.some((scope) => !isSafeId(scope))) return fail('bad-command-payload');
  const timing = validateShadowCapabilityTiming({ family: 'command-envelope', sourceAt: value.createdAt, expiresAt: value.expiresAt, nowMs: context.nowMs });
  if (!timing.ok || !isSignature(value.signature)) return fail('bad-command-time');
  return ok({ ...(value as unknown as ShadowCommandEnvelope), fence: fenceResult.value });
}

function decodeCommandState(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'commandId', 'fence', 'state', 'durable', 'createdAt', 'signature'], ['seq'])) return fail('bad-command-state-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.commandId) || typeof value.state !== 'string' || !COMMAND_STATUSES.has(value.state as CommandLifecycleStatus) || value.state === 'pending-local') return fail('bad-command-state');
  const commandState = value.state as CommandLifecycleStatus;
  const durable = commandState === 'accepted' || commandState === 'awaiting-state-event' || commandState === 'applied' || TERMINAL_COMMAND_STATUSES.has(commandState);
  if (value.durable !== durable) return fail('bad-command-durability');
  if (value.seq !== undefined && !isSafeSeq(value.seq)) return fail('bad-command-state-seq');
  if (!signed(value).ok) return fail('bad-signature');
  return ok({ ...(value as unknown as ShadowWireMessage), fence: fenceResult.value });
}

function decodeByteRange(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): DecodeResult<ByteRange> {
  if (!isRecord(value) || !exactKeys(value, ['start', 'endExclusive'])) return fail('bad-range-shape');
  if (!validRange(value as unknown as ByteRange, maxBytes)) return fail('bad-range');
  return ok(value as unknown as ByteRange);
}

function decodeChunkTransfer(value: Record<string, unknown>, family: 'snapshot-chunk-request' | 'snapshot-chunk-response' | 'asset-range-request' | 'asset-range-response'): DecodeResult<ShadowWireMessage> {
  const isResponse = family.endsWith('response');
  if (value.v !== SHADOW_PROTOCOL_VERSION || hasForbiddenPayloadKeys(value)) return fail('bad-chunk-transfer');
  const required = family.startsWith('snapshot')
    ? (isResponse ? ['family', 'v', 'snapshotId', 'contentId', 'range', 'ciphertextDigest', 'encryptedBytes', 'keyId', 'createdAt', 'signature'] : ['family', 'v', 'snapshotId', 'contentId', 'requestedAt', 'signature'])
    : (isResponse ? ['family', 'v', 'capabilityId', 'contentId', 'variant', 'range', 'ciphertextDigest', 'encryptedBytes', 'createdAt', 'signature'] : ['family', 'v', 'capabilityId', 'contentId', 'variant', 'range', 'requestedAt', 'signature']);
  if (!optionalExactKeys(value, required, family === 'snapshot-chunk-request' ? ['range'] : [])) return fail('bad-chunk-transfer-shape');
  if (value.snapshotId !== undefined && !isSafeId(value.snapshotId)) return fail('bad-snapshot');
  if (value.capabilityId !== undefined && !isSafeId(value.capabilityId)) return fail('bad-capability');
  if (!isContentId(value.contentId)) return fail('bad-content');
  if (value.variant !== undefined && (typeof value.variant !== 'string' || !ASSET_VARIANTS.has(value.variant as ShadowAssetVariant))) return fail('bad-variant');
  if (value.range !== undefined && !decodeByteRange(value.range).ok) return fail('bad-range');
  if (isResponse && (!digest(value.ciphertextDigest) || !isPositiveSafeInt(value.encryptedBytes) || value.encryptedBytes > SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES || (value.keyId !== undefined && !isSafeId(value.keyId)))) return fail('bad-response-crypto');
  if (!signed(value, isResponse ? 'createdAt' : 'requestedAt').ok) return fail('bad-signature');
  return ok(value as unknown as ShadowWireMessage);
}

function decodeConnectDecision(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'decision', 'signedAt', 'signature'], ['fromSeq', 'toSeq', 'snapshotId', 'baseSeqHint', 'replayFromSeq', 'reason', 'supportedProtocolVersions'])) return fail('bad-connect-decision-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION || !signed(value, 'signedAt').ok) return fail('bad-connect-decision');
  if (value.decision === 'delta') {
    if (!optionalExactKeys(value, ['family', 'v', 'decision', 'fromSeq', 'toSeq', 'signedAt', 'signature'])) return fail('bad-delta-decision-shape');
    if (!isSafeSeq(value.fromSeq) || !isSafeSeq(value.toSeq) || value.toSeq < value.fromSeq) return fail('bad-delta-decision');
  } else if (value.decision === 'manifest-repair') {
    if (!optionalExactKeys(value, ['family', 'v', 'decision', 'snapshotId', 'replayFromSeq', 'signedAt', 'signature'], ['baseSeqHint'])) return fail('bad-manifest-decision-shape');
    if (!isSafeId(value.snapshotId) || !isSafeSeq(value.replayFromSeq) || (value.baseSeqHint !== undefined && !isSafeSeq(value.baseSeqHint))) return fail('bad-manifest-decision');
  } else if (value.decision === 'fenced') {
    if (!optionalExactKeys(value, ['family', 'v', 'decision', 'reason', 'signedAt', 'signature'])) return fail('bad-fence-decision-shape');
    if (value.reason !== 'wrong-host' && value.reason !== 'stale-epoch' && value.reason !== 'future-epoch') return fail('bad-fence-decision');
  } else if (value.decision === 'incompatible') {
    if (!optionalExactKeys(value, ['family', 'v', 'decision', 'supportedProtocolVersions', 'signedAt', 'signature'])) return fail('bad-version-decision-shape');
    if (!Array.isArray(value.supportedProtocolVersions) || value.supportedProtocolVersions.length === 0 || value.supportedProtocolVersions.some((v) => v !== SHADOW_PROTOCOL_VERSION)) return fail('bad-version-decision');
  } else {
    return fail('bad-decision');
  }
  return ok(value as unknown as ShadowWireMessage);
}

function decodeAssetManifest(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'assetId', 'revisionId', 'fence', 'variants', 'createdAt', 'signature'])) return fail('bad-asset-manifest-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION || hasForbiddenPayloadKeys(value)) return fail('bad-asset-manifest');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.assetId) || !isSafeId(value.revisionId) || !isRecord(value.variants)) return fail('bad-asset-id');
  if (!exactKeys(value.variants, [...ASSET_VARIANTS])) return fail('bad-asset-variants-shape');
  for (const variant of ASSET_VARIANTS) {
    const ref = value.variants[variant];
    if (!isRecord(ref) || !exactKeys(ref, ['contentId', 'variant', 'bytes', 'sha256', 'mime', 'availableOffline'])) return fail('bad-variant-ref-shape');
    if (!isContentId(ref.contentId) || ref.variant !== variant || !isPositiveSafeInt(ref.bytes) || !digest(ref.sha256) || typeof ref.mime !== 'string' || ref.mime.length > 100 || typeof ref.availableOffline !== 'boolean') return fail('bad-variant-ref');
  }
  if (!signed(value).ok) return fail('bad-signature');
  return ok({ ...(value as unknown as ShadowWireMessage), fence: fenceResult.value });
}

function decodeHeaders(value: unknown): DecodeResult<Record<string, string>> {
  if (!isRecord(value)) return fail('bad-headers');
  const out: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!SAFE_HEADERS.has(lower) || key.includes('\n') || key.includes('\r') || typeof headerValue !== 'string' || headerValue.length > 2048 || /[\r\n]/.test(headerValue)) return fail('bad-header');
    out[lower] = headerValue;
  }
  return ok(out);
}

function canonicalizeTunnelPath(path: unknown): DecodeResult<string> {
  if (typeof path !== 'string') return fail('bad-route');
  if (path.length === 0 || path.length > 2048) return fail('bad-route');
  let current = path;
  for (let depth = 0; depth <= 4; depth += 1) {
    const structural = validateTunnelPathStage(current);
    if (!structural.ok) return structural;
    if (!/%[0-9a-fA-F]{2}/.test(current)) return ok(current);
    if (/%(?:2f|5c)/i.test(current)) return fail('bad-route-encoded-separator');
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return fail('bad-route-encoding');
    }
    if (decoded === current) return ok(current);
    current = decoded;
  }
  return fail('bad-route-encoding-depth');
}

function hasUnsafeTunnelUnicode(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\uff0f\uff3c]/u.test(value)) return true;
  return [...value].some((char) => {
    const normalized = char.normalize('NFKC');
    return normalized !== char && (normalized === '/' || normalized === '\\');
  });
}

function hasTunnelRedirectOrProxyTarget(value: string): boolean {
  const normalized = value.trimStart();
  return normalized.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    || /^[^/?#\\\s@]+@[^/?#\\\s]+$/u.test(normalized)
    || /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z0-9.-]+):\d+$/iu.test(normalized)
    || /^\[[0-9a-f:.]+\]:\d+$/iu.test(normalized);
}

function hasTunnelTraversal(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function validateTunnelQueryStage(query: string): DecodeResult<true> {
  if (query.length > 1024) return fail('bad-route-query');
  for (const pair of query.split('&')) {
    if (pair.length === 0) return fail('bad-route-query');
    const [key = '', ...valueParts] = pair.split('=');
    const value = valueParts.join('=');
    for (const component of [key, value]) {
      if (component.length === 0) continue;
      if (hasUnsafeTunnelUnicode(component)) return fail('bad-route-character');
      if (/%(?![0-9a-fA-F]{2})/.test(component)) return fail('bad-route-encoding');
      if (/%(?:2e|2f|5c)/i.test(component)) return fail('bad-route-encoded-structure');
      if (hasTunnelRedirectOrProxyTarget(component)) return fail('bad-route-query-target');
      if (component.includes('/') || component.includes('\\')) return fail('bad-route-query-structure');
      if (component === '.' || component === '..' || hasTunnelTraversal(component)) return fail('bad-route-traversal');
    }
  }
  return ok(true);
}

function validateTunnelPathStage(path: string): DecodeResult<true> {
  if (!path.startsWith('/') || path.startsWith('//')) return fail('bad-route-absolute');
  if (hasUnsafeTunnelUnicode(path) || path.includes('\\') || path.includes('#')) return fail('bad-route-character');
  if (/%(?![0-9a-fA-F]{2})/.test(path)) return fail('bad-route-encoding');
  if (/^\/[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return fail('bad-route-scheme');
  const [pathname = path, query] = path.split('?', 2);
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return fail('bad-route-traversal');
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment.includes(':')) return fail('bad-route-target');
    if (hasTunnelRedirectOrProxyTarget(segment)) return fail('bad-route-target');
  }
  if (query !== undefined) {
    const queryResult = validateTunnelQueryStage(query);
    if (!queryResult.ok) return queryResult;
  }
  return ok(true);
}

function decodeWebTunnelRequest(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'tunnelId', 'requestId', 'method', 'path', 'headers', 'createdAt', 'signature'], ['bodyContentId'])) return fail('bad-web-request-shape');
  const path = canonicalizeTunnelPath(value.path);
  if (value.v !== SHADOW_PROTOCOL_VERSION || !isSafeId(value.tunnelId) || !isSafeId(value.requestId) || typeof value.method !== 'string' || !TUNNEL_METHODS.has(value.method) || !path.ok) return fail('bad-web-request');
  if (value.bodyContentId !== undefined && !isContentId(value.bodyContentId)) return fail('bad-body-content');
  const headers = decodeHeaders(value.headers);
  if (!headers.ok) return headers;
  if (!signed(value).ok) return fail('bad-signature');
  return ok({ ...(value as unknown as WebTunnelRequest), path: path.value, headers: headers.value });
}

function decodeWebTunnelResponse(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'tunnelId', 'requestId', 'status', 'headers', 'createdAt', 'signature'], ['bodyContentId', 'etag', 'range'])) return fail('bad-web-response-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION || !isSafeId(value.tunnelId) || !isSafeId(value.requestId) || !Number.isSafeInteger(value.status)) return fail('bad-web-response');
  const status = value.status as number;
  if (status < 100 || status > 599) return fail('bad-web-response');
  if (value.bodyContentId !== undefined && !isContentId(value.bodyContentId)) return fail('bad-body-content');
  if (value.etag !== undefined && (typeof value.etag !== 'string' || value.etag.length > 256 || /[\r\n]/.test(value.etag))) return fail('bad-etag');
  if (value.range !== undefined && (typeof value.range !== 'string' || value.range.length > 128 || /[\r\n]/.test(value.range))) return fail('bad-range-header');
  const headers = decodeHeaders(value.headers);
  if (!headers.ok) return headers;
  if (!signed(value).ok) return fail('bad-signature');
  return ok({ ...(value as unknown as WebTunnelResponse), headers: headers.value });
}

function decodeWebTunnelWs(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (value.v !== SHADOW_PROTOCOL_VERSION || !isSafeId(value.tunnelId) || !isSafeId(value.streamId) || !isPositiveSafeInt(value.frameSeq) || typeof value.kind !== 'string' || !WS_KINDS.has(value.kind)) return fail('bad-ws');
  if (value.kind === 'open') {
    if (!optionalExactKeys(value, ['family', 'v', 'tunnelId', 'streamId', 'frameSeq', 'kind', 'path', 'headers', 'createdAt', 'signature'])) return fail('bad-ws-open-shape');
    const headers = decodeHeaders(value.headers);
    const path = canonicalizeTunnelPath(value.path);
    if (!path.ok || !headers.ok) return fail('bad-ws-open');
    if (!signed(value).ok) return fail('bad-signature');
    return ok({ ...(value as unknown as WebTunnelWsMessage), path: path.value, headers: headers.value });
  }
  if (value.kind === 'frame') {
    if (!optionalExactKeys(value, ['family', 'v', 'tunnelId', 'streamId', 'frameSeq', 'kind', 'dataContentId', 'createdAt', 'signature'])) return fail('bad-ws-frame-shape');
    if (!isContentId(value.dataContentId)) return fail('bad-ws-frame');
    if (!signed(value).ok) return fail('bad-signature');
    return ok(value as unknown as ShadowWireMessage);
  }
  if (value.kind === 'close') {
    if (!optionalExactKeys(value, ['family', 'v', 'tunnelId', 'streamId', 'frameSeq', 'kind', 'code', 'createdAt', 'signature'], ['reason'])) return fail('bad-ws-close-shape');
    if (!Number.isSafeInteger(value.code)) return fail('bad-ws-close');
    const code = value.code as number;
    if (code < 1000 || code > 4999) return fail('bad-ws-close');
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 123 || /[\r\n]/.test(value.reason))) return fail('bad-ws-close-reason');
    if (!signed(value).ok) return fail('bad-signature');
    return ok(value as unknown as ShadowWireMessage);
  }
  return fail('bad-ws');
}

function decodePreviewSession(value: Record<string, unknown>, context: NormalizedShadowDecodeContext): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'visualSessionId', 'fence', 'controllerDeviceId', 'source', 'mode', 'inputMode', 'transport', 'expiresAt', 'signature'], ['projectId', 'sessionId', 'surfaceId'])) return fail('bad-preview-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.visualSessionId) || !isSafeId(value.controllerDeviceId) || typeof value.mode !== 'string' || !PREVIEW_MODES.has(value.mode as ShadowPreviewMode)) return fail('bad-preview');
  if (value.inputMode !== 'view-only' && value.inputMode !== 'control') return fail('bad-input-mode');
  if (typeof value.source !== 'string' || !['browser', 'native-window', 'design', 'host-app', 'file-preview'].includes(value.source)) return fail('bad-source');
  if (typeof value.transport !== 'string' || !['relay-frame', 'lan', 'webrtc-direct', 'webrtc-turn', 'encrypted-relay'].includes(value.transport)) return fail('bad-transport');
  if ((value.projectId !== undefined && !isSafeId(value.projectId)) || (value.sessionId !== undefined && !isSafeId(value.sessionId)) || (value.surfaceId !== undefined && !isSafeId(value.surfaceId))) return fail('bad-preview-id');
  if (value.mode === 'artifact') {
    if (value.projectId === undefined || value.surfaceId !== undefined) return fail('bad-artifact-preview-binding');
    if (value.source !== 'file-preview' && value.source !== 'design' && value.source !== 'host-app') return fail('bad-artifact-preview-source');
    if (value.transport !== 'encrypted-relay' && value.transport !== 'relay-frame') return fail('bad-artifact-preview-transport');
  } else if (value.mode === 'web-tunnel') {
    if (value.projectId === undefined || value.sessionId === undefined || value.surfaceId !== undefined) return fail('bad-web-preview-binding');
    if (value.source !== 'browser') return fail('bad-web-preview-source');
    if (value.transport !== 'encrypted-relay' && value.transport !== 'lan') return fail('bad-web-preview-transport');
  } else if (value.mode === 'pixel-stream') {
    if (value.surfaceId === undefined || value.projectId !== undefined || value.sessionId !== undefined) return fail('bad-pixel-preview-binding');
    if (value.source !== 'native-window' && value.source !== 'browser' && value.source !== 'host-app') return fail('bad-pixel-preview-source');
    if (value.transport !== 'lan' && value.transport !== 'webrtc-direct' && value.transport !== 'webrtc-turn' && value.transport !== 'encrypted-relay') return fail('bad-pixel-preview-transport');
  }
  const timing = validateShadowCapabilityTiming({ family: 'preview-session', expiresAt: value.expiresAt, nowMs: context.nowMs });
  if (!timing.ok || !isSignature(value.signature)) return fail('bad-signature');
  return ok({ ...(value as unknown as ShadowWireMessage), fence: fenceResult.value });
}

function decodeVisualFrame(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'visualSessionId', 'frameSeq', 'hostStateSeq', 'timestamp', 'codec', 'keyframe', 'signature'], ['projectRevision', 'contentId'])) return fail('bad-frame-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION || !isSafeId(value.visualSessionId) || !isPositiveSafeInt(value.frameSeq) || !isSafeSeq(value.hostStateSeq) || !isFiniteTime(value.timestamp)) return fail('bad-frame');
  if (value.projectRevision !== undefined && !isSafeId(value.projectRevision)) return fail('bad-project-revision');
  if (value.contentId !== undefined && !isContentId(value.contentId)) return fail('bad-frame-content');
  if (value.codec !== 'h264' && value.codec !== 'jpeg' && value.codec !== 'png') return fail('bad-codec');
  if (typeof value.keyframe !== 'boolean' || !isSignature(value.signature)) return fail('bad-signature');
  return ok(value as unknown as ShadowWireMessage);
}

function decodeVisualControlGrant(value: Record<string, unknown>, context: NormalizedShadowDecodeContext): DecodeResult<ShadowWireMessage> {
  if (!optionalExactKeys(value, ['family', 'v', 'visualSessionId', 'fence', 'controllerDeviceId', 'mode', 'expiresAt', 'signedAt', 'signature'], ['grantId'])) return fail('bad-control-grant-shape');
  if (value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  const sig = signed(value, 'signedAt');
  const timing = validateShadowCapabilityTiming({ family: 'visual-control-grant', sourceAt: value.signedAt, expiresAt: value.expiresAt, nowMs: context.nowMs });
  if ((value.grantId !== undefined && !isSafeId(value.grantId)) || !isSafeId(value.visualSessionId) || !isSafeId(value.controllerDeviceId) || (value.mode !== 'view-only' && value.mode !== 'control') || !sig.ok || !timing.ok) return fail('bad-control-grant');
  return ok({ ...(value as unknown as ShadowWireMessage), fence: fenceResult.value });
}

function decodeVisualInputStatic(value: unknown): DecodeResult<VisualInputEvent & { family: 'visual-input'; v: ShadowProtocolVersion; fence: Fence }> {
  if (!isRecord(value)) return fail('bad-input');
  if (!exactKeys(value, ['family', 'v', 'visualSessionId', 'fence', 'inputSeq', 'frameSeqSeen', 'kind', 'viewport', 'payloadCiphertext', 'createdAt', 'signature'])) return fail('bad-input-shape');
  if (value.family !== 'visual-input' || value.v !== SHADOW_PROTOCOL_VERSION) return fail('unsupported-version');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.visualSessionId) || !isPositiveSafeInt(value.inputSeq) || !isSafeSeq(value.frameSeqSeen)) return fail('bad-input');
  if (typeof value.kind !== 'string' || !VISUAL_INPUT_KINDS.has(value.kind)) return fail('bad-kind');
  if (!isRecord(value.viewport) || !exactKeys(value.viewport, ['width', 'height', 'scale'])) return fail('bad-viewport-shape');
  if (!isPositiveSafeInt(value.viewport.width) || !isPositiveSafeInt(value.viewport.height)) return fail('bad-viewport');
  if (value.viewport.width > 16_384 || value.viewport.height > 16_384) return fail('bad-viewport');
  if (typeof value.viewport.scale !== 'number' || !Number.isFinite(value.viewport.scale) || value.viewport.scale <= 0 || value.viewport.scale > 10) return fail('bad-viewport');
  if (typeof value.payloadCiphertext !== 'string' || value.payloadCiphertext.length === 0 || value.payloadCiphertext.length > SHADOW_MAX_ENCRYPTED_PAYLOAD_BYTES || isPathLike(value.payloadCiphertext)) return fail('bad-payload');
  if (!isFiniteTime(value.createdAt) || !isSignature(value.signature)) return fail('bad-signature');
  return ok({
    family: 'visual-input',
    v: SHADOW_PROTOCOL_VERSION,
    visualSessionId: value.visualSessionId,
    fence: fenceResult.value,
    inputSeq: value.inputSeq,
    frameSeqSeen: value.frameSeqSeen,
    kind: value.kind as VisualInputEvent['kind'],
    viewport: { width: value.viewport.width, height: value.viewport.height, scale: value.viewport.scale },
    payloadCiphertext: value.payloadCiphertext,
    createdAt: value.createdAt,
    signature: value.signature,
  });
}

function decodeSecurityControlMessage(value: Record<string, unknown>, context: NormalizedShadowDecodeContext): DecodeResult<ShadowWireMessage> {
  if (value.v !== SHADOW_PROTOCOL_VERSION || hasForbiddenPayloadKeys(value)) return fail('bad-security-message');
  if (value.family === 'enrollment-request') {
    if (!optionalExactKeys(value, ['family', 'v', 'accountId', 'controllerDeviceId', 'devicePublicKeyId', 'requestedAt', 'signature']) || !isSafeId(value.accountId) || !isSafeId(value.controllerDeviceId) || !isSafeId(value.devicePublicKeyId) || !signed(value, 'requestedAt').ok) return fail('bad-enrollment-request');
  } else if (value.family === 'enrollment-grant') {
    const fenceResult = decodeFence(value.fence);
    if (!fenceResult.ok) return fenceResult;
    const timing = validateShadowCapabilityTiming({ family: 'enrollment-grant', sourceAt: value.signedAt, expiresAt: value.expiresAt, nowMs: context.nowMs });
    if (!optionalExactKeys(value, ['family', 'v', 'fence', 'controllerDeviceId', 'grantId', 'expiresAt', 'keyId', 'signedAt', 'signature']) || !isSafeId(value.controllerDeviceId) || !isSafeId(value.grantId) || !isSafeId(value.keyId) || !signed(value, 'signedAt').ok || !timing.ok) return fail('bad-enrollment-grant');
  } else if (value.family === 'device-revocation') {
    const fenceResult = decodeFence(value.fence);
    if (!fenceResult.ok) return fenceResult;
    if (!optionalExactKeys(value, ['family', 'v', 'fence', 'controllerDeviceId', 'revokedAt', 'keyRotationId', 'signature']) || !isSafeId(value.controllerDeviceId) || !isSafeId(value.keyRotationId) || !signed(value, 'revokedAt').ok) return fail('bad-revocation');
  } else if (value.family === 'key-rotation') {
    const fenceResult = decodeFence(value.fence);
    if (!fenceResult.ok) return fenceResult;
    if (!optionalExactKeys(value, ['family', 'v', 'fence', 'keyId', 'previousKeyId', 'effectiveSeq', 'createdAt', 'signature']) || !isSafeId(value.keyId) || !isSafeId(value.previousKeyId) || !isSafeSeq(value.effectiveSeq) || !signed(value).ok) return fail('bad-key-rotation');
  } else {
    return fail('unknown-security-message');
  }
  return ok(value as unknown as ShadowWireMessage);
}

function decodeHandoffMessage(value: Record<string, unknown>): DecodeResult<ShadowWireMessage> {
  if (value.v !== SHADOW_PROTOCOL_VERSION || hasForbiddenPayloadKeys(value)) return fail('bad-handoff');
  if (value.family === 'handoff-prepare') {
    if (!optionalExactKeys(value, ['family', 'v', 'scopeId', 'fromHostDeviceId', 'toHostDeviceId', 'currentEpoch', 'reason', 'requestedAt', 'signature']) || !isSafeId(value.scopeId) || !isSafeId(value.fromHostDeviceId) || !isSafeId(value.toHostDeviceId) || value.fromHostDeviceId === value.toHostDeviceId || !isPositiveSafeInt(value.currentEpoch) || typeof value.reason !== 'string' || value.reason.length === 0 || !signed(value, 'requestedAt').ok) return fail('bad-handoff-prepare');
  } else if (value.family === 'handoff-quiesced') {
    const oldFence = decodeFence(value.oldFence);
    if (!oldFence.ok) return oldFence;
    if (!optionalExactKeys(value, ['family', 'v', 'oldFence', 'finalSnapshotId', 'finalBaseSeq', 'quiescedAt', 'signature']) || !isSafeId(value.finalSnapshotId) || !isSafeSeq(value.finalBaseSeq) || !signed(value, 'quiescedAt').ok) return fail('bad-handoff-quiesced');
  } else if (value.family === 'handoff-grant') {
    const oldFence = decodeFence(value.oldFence);
    const newFence = decodeFence(value.newFence);
    if (!oldFence.ok) return oldFence;
    if (!newFence.ok) return newFence;
    if (!optionalExactKeys(value, ['family', 'v', 'oldFence', 'newFence', 'finalSnapshotId', 'finalBaseSeq', 'oldHostFenceExpiresAt', 'secretReauthRequired', 'serverSignature']) || newFence.value.epoch <= oldFence.value.epoch || !isSafeId(value.finalSnapshotId) || !isSafeSeq(value.finalBaseSeq) || !isFiniteTime(value.oldHostFenceExpiresAt) || typeof value.secretReauthRequired !== 'boolean' || !isSignature(value.serverSignature)) return fail('bad-handoff-grant');
  } else if (value.family === 'handoff-commit') {
    const oldFence = decodeFence(value.oldFence);
    const newFence = decodeFence(value.newFence);
    if (!oldFence.ok) return oldFence;
    if (!newFence.ok) return newFence;
    if (!optionalExactKeys(value, ['family', 'v', 'oldFence', 'newFence', 'committedAt', 'signature']) || newFence.value.epoch <= oldFence.value.epoch || !signed(value, 'committedAt').ok) return fail('bad-handoff-commit');
  } else if (value.family === 'handoff-abort') {
    const oldFence = decodeFence(value.oldFence);
    if (!oldFence.ok) return oldFence;
    if (!optionalExactKeys(value, ['family', 'v', 'oldFence', 'reason', 'abortedAt', 'signature']) || typeof value.reason !== 'string' || value.reason.length === 0 || !signed(value, 'abortedAt').ok) return fail('bad-handoff-abort');
  } else if (value.family === 'handoff-fenced') {
    const oldFence = decodeFence(value.oldFence);
    if (!oldFence.ok) return oldFence;
    if (!optionalExactKeys(value, ['family', 'v', 'oldFence', 'newEpoch', 'fencedAt', 'signature']) || !isPositiveSafeInt(value.newEpoch) || value.newEpoch <= oldFence.value.epoch || !signed(value, 'fencedAt').ok) return fail('bad-handoff-fenced');
  } else {
    return fail('unknown-handoff');
  }
  return ok(value as unknown as ShadowWireMessage);
}

export function decodeShadowMessage(value: unknown, context: ShadowDecodeContext = {}): DecodeResult<ShadowWireMessage> {
  if (!isRecord(value) || typeof value.family !== 'string') return fail('missing-family');
  if (hasForbiddenPayloadKeys(value)) return fail('plaintext-or-path-field');
  const normalizedContext = normalizeShadowDecodeContext(context);
  if (!normalizedContext.ok) return normalizedContext;
  if (value.family === 'connect-hello') {
    const hello = decodeShadowConnectHello(value);
    return hello.ok ? ok({ ...hello.value, family: 'connect-hello' }) : hello;
  }
  if (value.family === 'connect-decision') return decodeConnectDecision(value);
  if (value.family === 'state-event') {
    const evt = decodeStateEvent(value);
    return evt.ok ? ok({ ...evt.value, family: 'state-event' }) : evt;
  }
  if (value.family === 'event-ack' || value.family === 'cursor-ack' || value.family === 'gap-repair-request' || value.family === 'gap-repair-response') return decodeSignedSeqMessage(value, value.family);
  if (value.family === 'command-envelope') return decodeCommandEnvelope(value, normalizedContext.value);
  if (value.family === 'command-ack') return decodeAck(value);
  if (value.family === 'command-state') return decodeCommandState(value);
  if (value.family === 'snapshot-manifest') {
    const manifest = decodeSnapshotManifest(value);
    return manifest.ok ? ok({ ...manifest.value, family: 'snapshot-manifest' }) : manifest;
  }
  if (value.family === 'snapshot-chunk-request' || value.family === 'snapshot-chunk-response' || value.family === 'asset-range-request' || value.family === 'asset-range-response') return decodeChunkTransfer(value, value.family);
  if (value.family === 'asset-manifest') return decodeAssetManifest(value);
  if (value.family === 'asset-capability') {
    const cap = decodeBlobCapabilityWithContext(value, undefined, normalizedContext.value);
    return cap.ok ? ok({ ...cap.value, family: 'asset-capability' }) : cap;
  }
  if (value.family === 'preview-session') return decodePreviewSession(value, normalizedContext.value);
  if (value.family === 'web-tunnel-http-request') return decodeWebTunnelRequest(value);
  if (value.family === 'web-tunnel-http-response') return decodeWebTunnelResponse(value);
  if (value.family === 'web-tunnel-ws') return decodeWebTunnelWs(value);
  if (value.family === 'visual-frame') return decodeVisualFrame(value);
  if (value.family === 'visual-control-grant') return decodeVisualControlGrant(value, normalizedContext.value);
  if (value.family === 'visual-input') {
    return decodeVisualInputStatic(value);
  }
  if (value.family === 'enrollment-request' || value.family === 'enrollment-grant' || value.family === 'device-revocation' || value.family === 'key-rotation') return decodeSecurityControlMessage(value, normalizedContext.value);
  if (value.family.startsWith('handoff-')) return decodeHandoffMessage(value);
  return fail('unknown-family');
}

export function validateAuthorityFence(context: AuthorityContext, req: { fence: Fence; controllerDeviceId?: string; now: number }): { ok: true } | { ok: false; reason: 'wrong-account' | 'wrong-scope' | 'wrong-host' | 'wrong-lease' | 'stale-epoch' | 'future-epoch' | 'expired' | 'revoked' } {
  if (req.fence.accountId !== context.fence.accountId) return { ok: false, reason: 'wrong-account' };
  if (req.fence.scopeId !== context.fence.scopeId) return { ok: false, reason: 'wrong-scope' };
  if (req.fence.hostDeviceId !== context.fence.hostDeviceId) return { ok: false, reason: 'wrong-host' };
  if (req.fence.leaseId !== context.fence.leaseId) return { ok: false, reason: 'wrong-lease' };
  if (req.fence.epoch < context.fence.epoch) return { ok: false, reason: 'stale-epoch' };
  if (req.fence.epoch > context.fence.epoch) return { ok: false, reason: 'future-epoch' };
  if (req.now >= context.leaseExpiresAt) return { ok: false, reason: 'expired' };
  if (req.controllerDeviceId && context.revokedControllerDeviceIds?.has(req.controllerDeviceId)) return { ok: false, reason: 'revoked' };
  return { ok: true };
}

export function sequenceShadowEvent(cursor: ShadowCursor, evt: ShadowStateEvent): { outcome: 'accepted'; cursor: ShadowCursor } | { outcome: 'duplicate' | 'gap' | 'conflict' | 'fenced'; cursor: ShadowCursor } {
  if (!sameFence(cursor.fence, evt.fence)) return { outcome: 'fenced', cursor };
  if (evt.seq <= cursor.lastSeq) {
    if (evt.seq === cursor.lastSeq && evt.eventId === cursor.lastEventId && evt.payloadDigest === cursor.lastDigest) return { outcome: 'duplicate', cursor };
    const prior = cursor.history?.find((entry) => entry.seq === evt.seq);
    if (prior) return prior.eventId === evt.eventId && prior.payloadDigest === evt.payloadDigest ? { outcome: 'duplicate', cursor } : { outcome: 'conflict', cursor };
    return { outcome: 'gap', cursor };
  }
  if (evt.seq !== cursor.lastSeq + 1 || evt.prevSeq !== cursor.lastSeq) return { outcome: 'gap', cursor };
  const history = [...(cursor.history ?? []), { seq: evt.seq, eventId: evt.eventId, payloadDigest: evt.payloadDigest }].slice(-64);
  return { outcome: 'accepted', cursor: { fence: cursor.fence, lastSeq: evt.seq, lastEventId: evt.eventId, lastDigest: evt.payloadDigest, history } };
}

export function planCursorTransaction(input: { controllerDeviceId: string; cursor: ShadowCursor; event: ShadowStateEvent; inboxId: string }): { outcome: 'apply-and-advance'; steps: readonly ['persist-inbox', 'decrypt-validate', 'apply-entity', 'advance-cursor', 'delete-inbox']; nextCursor: ShadowCursor } | { outcome: 'repair-required' | 'fenced' | 'conflict' | 'duplicate'; steps: readonly string[]; nextCursor: ShadowCursor } {
  const sequenced = sequenceShadowEvent(input.cursor, input.event);
  if (sequenced.outcome === 'accepted') return { outcome: 'apply-and-advance', steps: ['persist-inbox', 'decrypt-validate', 'apply-entity', 'advance-cursor', 'delete-inbox'], nextCursor: sequenced.cursor };
  if (sequenced.outcome === 'gap') return { outcome: 'repair-required', steps: ['persist-inbox', 'request-gap-repair'], nextCursor: input.cursor };
  return { outcome: sequenced.outcome, steps: [], nextCursor: input.cursor };
}

export type CommandLifecycleInput =
  | { type: 'sent'; now: number }
  | { type: 'host-ack'; ack: HostCommandAck; now: number }
  | { type: 'state-event'; event: ShadowStateEvent; now: number }
  | { type: 'execute'; now: number }
  | { type: 'await-state-event'; now: number }
  | { type: 'cancel'; now: number }
  | { type: 'expire'; now: number };

export function advanceCommandLifecycle(state: CommandLifecycleState, input: CommandLifecycleInput): { outcome: 'advanced' | 'idempotent' | 'invalid' | 'fenced'; state: CommandLifecycleState } {
  if (TERMINAL_COMMAND_STATUSES.has(state.status)) {
    if (input.type === 'host-ack') {
      if (!sameFence(state.fence, input.ack.fence)) return { outcome: 'fenced', state };
      if (input.ack.commandId !== state.commandId) return { outcome: 'invalid', state };
      if (!state.ack) return { outcome: 'invalid', state };
      if (hostCommandAckSemanticallyEqual(state.ack, input.ack)) return { outcome: 'idempotent', state };
      return { outcome: 'advanced', state: { ...state, status: 'conflict', rejectReason: 'conflicting-terminal-ack' } };
    }
    return { outcome: 'idempotent', state };
  }
  if (input.now >= state.expiresAt && input.type !== 'state-event') return { outcome: 'advanced', state: { ...state, status: 'expired' } };
  if (input.type === 'expire') return { outcome: 'advanced', state: { ...state, status: 'expired' } };
  if (input.type === 'cancel') return { outcome: 'advanced', state: { ...state, status: 'cancelled' } };
  if (input.type === 'sent') {
    if (state.status === 'pending-local') return { outcome: 'advanced', state: { ...state, status: 'sent' } };
    return { outcome: 'idempotent', state };
  }
  if (input.type === 'execute') {
    if (state.status === 'accepted') return { outcome: 'advanced', state: { ...state, status: 'executing' } };
    return { outcome: 'invalid', state };
  }
  if (input.type === 'await-state-event') {
    if (state.status === 'executing') {
      const next = { ...state, status: 'awaiting-state-event' as const };
      return { outcome: 'advanced', state: next };
    }
    return { outcome: 'invalid', state };
  }
  if (input.type === 'host-ack') {
    if (!sameFence(state.fence, input.ack.fence)) return { outcome: 'fenced', state };
    if (input.ack.commandId !== state.commandId) return { outcome: 'invalid', state };
    if (state.ack && !hostCommandAckSemanticallyEqual(state.ack, input.ack)) return { outcome: 'advanced', state: { ...state, status: 'conflict', rejectReason: 'conflicting-ack' } };
    if (input.ack.status === 'accepted' || input.ack.status === 'duplicate') {
      if (state.status === 'pending-local') return { outcome: 'invalid', state };
      if (state.status === 'sent') {
        if (state.pendingEvent) {
          if (input.ack.resultSeq !== undefined && state.pendingEvent.seq !== input.ack.resultSeq) return { outcome: 'advanced', state: { ...state, status: 'conflict', ack: input.ack, rejectReason: 'conflicting-state-event' } };
          if (input.ack.resultSeq === undefined && input.ack.acceptedSeq !== undefined && state.pendingEvent.seq < input.ack.acceptedSeq) return { outcome: 'advanced', state: { ...state, status: 'conflict', ack: input.ack, rejectReason: 'state-event-before-accepted-boundary' } };
        }
        const next = { ...state, status: 'accepted' as const, ack: input.ack, resultSeq: input.ack.resultSeq };
        return { outcome: 'advanced', state: next };
      }
      if (state.status === 'accepted' || state.status === 'executing' || state.status === 'awaiting-state-event') return { outcome: 'idempotent', state: { ...state, ack: state.ack ?? input.ack, resultSeq: state.resultSeq ?? input.ack.resultSeq } };
      return { outcome: 'invalid', state };
    }
    if (state.status !== 'sent') return { outcome: 'invalid', state };
    const mapped: CommandLifecycleStatus = input.ack.status === 'stale-epoch' ? 'stale-epoch' : input.ack.status === 'unauthorized' ? 'unauthorized' : input.ack.status === 'expired' ? 'expired' : 'rejected';
    return { outcome: 'advanced', state: { ...state, status: mapped, ack: input.ack, rejectReason: input.ack.error?.message ?? input.ack.status } };
  }
  if (input.type === 'state-event') {
    if (!sameFence(state.fence, input.event.fence)) return { outcome: 'fenced', state };
    if (input.event.commandId !== state.commandId) return state.status === 'awaiting-state-event' ? { outcome: 'invalid', state } : { outcome: 'idempotent', state };
    if (state.resultSeq !== undefined && input.event.seq !== state.resultSeq) return { outcome: 'invalid', state };
    if (state.resultSeq === undefined && state.ack?.acceptedSeq !== undefined && input.event.seq < state.ack.acceptedSeq) return { outcome: 'invalid', state };
    if (state.pendingEvent && (state.pendingEvent.eventId !== input.event.eventId || state.pendingEvent.seq !== input.event.seq)) return { outcome: 'advanced', state: { ...state, status: 'conflict', rejectReason: 'conflicting-state-event' } };
    const pendingEvent = { eventId: input.event.eventId, seq: input.event.seq, commandId: input.event.commandId };
    if (!state.ack) return { outcome: 'advanced', state: { ...state, pendingEvent } };
    if (state.status === 'awaiting-state-event') return { outcome: 'advanced', state: { ...state, pendingEvent, status: 'applied', appliedEventId: input.event.eventId } };
    return { outcome: 'advanced', state: { ...state, pendingEvent } };
  }
  return { outcome: 'invalid', state };
}

export function decideReconnect(input: { hello: Omit<Pick<ShadowConnectHello, 'hostDeviceId' | 'epoch' | 'lastSeq' | 'snapshotId' | 'collectionDigests'>, never> & { protocolVersion: number }; retainedMinSeq: number; headSeq: number; latestSnapshotId: string; hostDeviceId: string; epoch: number; supportedProtocolVersions: readonly number[]; latestSnapshotBaseSeq?: number }): ResumeDecision {
  if (!input.supportedProtocolVersions.includes(input.hello.protocolVersion)) return { decision: 'incompatible', supportedProtocolVersions: input.supportedProtocolVersions };
  if (input.hello.hostDeviceId !== input.hostDeviceId) return { decision: 'fenced', reason: 'wrong-host' };
  if (input.hello.epoch < input.epoch) return { decision: 'fenced', reason: 'stale-epoch' };
  if (input.hello.epoch > input.epoch) return { decision: 'fenced', reason: 'future-epoch' };
  if (input.hello.lastSeq >= input.retainedMinSeq && input.hello.lastSeq <= input.headSeq) return { decision: 'delta', fromSeq: input.hello.lastSeq + 1, toSeq: input.headSeq };
  return { decision: 'manifest-repair', snapshotId: input.latestSnapshotId, baseSeqHint: input.latestSnapshotBaseSeq, replayFromSeq: Math.max(0, input.latestSnapshotBaseSeq ?? 0) + 1 };
}

export interface RetentionSegment { segmentId: string; firstSeq: number; lastSeq: number; closed: boolean; verified: boolean }
export interface RetentionController { controllerDeviceId: string; lastSeq: number; lastSeenAt: number; permanentlyInactive?: boolean }

export function planRetention(input: { now: number; snapshot: { snapshotId: string; baseSeq: number; verified: boolean; publishedAt: number }; segments: RetentionSegment[]; controllers: RetentionController[]; staleAfterMs: number; safetyTailEvents: number; snapshotSafetyMs: number }): { deleteSegmentIds: string[]; keepSegmentIds: string[]; keepReasons: Map<string, string[]> } {
  const deleteSegmentIds: string[] = [];
  const keepSegmentIds: string[] = [];
  const keepReasons = new Map<string, string[]>();
  const addKeep = (id: string, reason: string): void => {
    keepSegmentIds.push(id);
    keepReasons.set(id, [...(keepReasons.get(id) ?? []), reason]);
  };
  const activeMinSeq = Math.min(...input.controllers.filter((c) => !c.permanentlyInactive && input.now - c.lastSeenAt <= input.staleAfterMs).map((c) => c.lastSeq), Number.POSITIVE_INFINITY);
  const protectedTailStart = Math.max(0, input.snapshot.baseSeq - input.safetyTailEvents + 1);
  const snapshotSafe = input.snapshot.verified && input.now - input.snapshot.publishedAt >= input.snapshotSafetyMs;
  for (const seg of input.segments) {
    if (!seg.closed) { addKeep(seg.segmentId, 'open-segment'); continue; }
    if (!seg.verified || !snapshotSafe || seg.lastSeq > input.snapshot.baseSeq) { addKeep(seg.segmentId, 'unverified-or-uncovered'); continue; }
    if (Number.isFinite(activeMinSeq) && seg.lastSeq >= activeMinSeq) { addKeep(seg.segmentId, 'active-controller-cursor'); continue; }
    if (seg.lastSeq >= protectedTailStart) { addKeep(seg.segmentId, 'safety-tail'); continue; }
    deleteSegmentIds.push(seg.segmentId);
  }
  return { deleteSegmentIds, keepSegmentIds: [...new Set(keepSegmentIds)], keepReasons };
}

function decodeBlobCapabilityWithContext(value: unknown, expected: { controllerDeviceId: string; fence: Fence; contentId: string; variant: string; now: number } | undefined, context: NormalizedShadowDecodeContext): DecodeResult<BlobCapability> {
  if (!isRecord(value) || value.v !== SHADOW_PROTOCOL_VERSION) return fail('bad-capability');
  if (!optionalExactKeys(value, ['v', 'capabilityId', 'fence', 'controllerDeviceId', 'contentId', 'variant', 'permissions', 'expiresAt', 'signature'], ['family', 'assetId'])) return fail('bad-capability-shape');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (expected && !sameFence(fenceResult.value, expected.fence)) return fail('wrong-fence');
  if (!isSafeId(value.capabilityId) || !isSafeId(value.controllerDeviceId) || !isContentId(value.contentId) || typeof value.variant !== 'string' || !ASSET_VARIANTS.has(value.variant as ShadowAssetVariant)) return fail('bad-capability-id');
  if (expected && (value.controllerDeviceId !== expected.controllerDeviceId || value.contentId !== expected.contentId || value.variant !== expected.variant)) return fail('wrong-binding');
  if (!Array.isArray(value.permissions) || value.permissions.some((p) => p !== 'read' && p !== 'range-read' && p !== 'pin-offline')) return fail('bad-permissions');
  if (!isFiniteTime(value.expiresAt)) return fail('expired');
  const timing = validateShadowCapabilityTiming({ family: 'asset-capability', expiresAt: value.expiresAt, nowMs: context.nowMs });
  const expiresAt = value.expiresAt;
  if (!timing.ok || (expected && expected.now >= expiresAt)) return fail('expired');
  if (!isSignature(value.signature)) return fail('bad-signature');
  return ok(value as unknown as BlobCapability);
}

export function decodeBlobCapability(value: unknown, expected?: { controllerDeviceId: string; fence: Fence; contentId: string; variant: string; now: number }, context: ShadowDecodeContext = {}): DecodeResult<BlobCapability> {
  const normalizedContext = normalizeShadowDecodeContext(context.nowMs === undefined && expected !== undefined ? { nowMs: expected.now } : context);
  if (!normalizedContext.ok) return normalizedContext;
  return decodeBlobCapabilityWithContext(value, expected, normalizedContext.value);
}

function originIsAllowedLoopback(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:') && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') && Number(url.port) === port;
  } catch {
    return false;
  }
}

export function decodeWebTunnelSession(value: unknown, contextOrNowMs: ShadowDecodeContext | number = {}): DecodeResult<WebTunnelSession> {
  const normalizedContext = normalizeShadowDecodeContext(typeof contextOrNowMs === 'number' ? { nowMs: contextOrNowMs } : contextOrNowMs);
  if (!normalizedContext.ok) return normalizedContext;
  if (!isRecord(value) || value.v !== SHADOW_PROTOCOL_VERSION) return fail('bad-tunnel');
  const fenceResult = decodeFence(value.fence);
  if (!fenceResult.ok) return fenceResult;
  if (!isSafeId(value.tunnelId) || !isSafeId(value.projectId) || !isSafeId(value.controllerDeviceId)) return fail('bad-tunnel-id');
  if (value.sessionId !== undefined && !isSafeId(value.sessionId)) return fail('bad-session');
  if (typeof value.allowedLoopbackPort !== 'number' || !Number.isSafeInteger(value.allowedLoopbackPort) || value.allowedLoopbackPort < 1024 || value.allowedLoopbackPort > 65535) return fail('bad-port');
  const allowedLoopbackPort = value.allowedLoopbackPort;
  if (typeof value.allowedOrigin !== 'string' || !originIsAllowedLoopback(value.allowedOrigin, allowedLoopbackPort)) return fail('bad-origin');
  const route = canonicalizeTunnelPath(value.route);
  if (!route.ok) return fail('bad-route');
  const timing = validateShadowCapabilityTiming({ family: 'web-tunnel-session', expiresAt: value.expiresAt, nowMs: normalizedContext.value.nowMs });
  if (!timing.ok) return timing;
  return ok({ ...(value as unknown as WebTunnelSession), route: route.value });
}

export function decodeVisualInputEvent(value: unknown, context: { visualSessionId: string; mode: 'view-only' | 'control'; lastInputSeq: number; minFrameSeq: number; now: number; maxAgeMs: number }): DecodeResult<VisualInputEvent> {
  const decoded = decodeVisualInputStatic(value);
  if (!decoded.ok) return decoded;
  const input = decoded.value;
  if (context.mode !== 'control') return fail('control-not-approved');
  if (input.visualSessionId !== context.visualSessionId || !isSafeId(input.visualSessionId)) return fail('wrong-session');
  if (input.inputSeq <= context.lastInputSeq) return fail('replay');
  if (input.frameSeqSeen < context.minFrameSeq) return fail('stale-frame');
  if (!isFiniteTime(input.createdAt) || context.now - input.createdAt > context.maxAgeMs || input.createdAt > context.now + 1_000) return fail('expired');
  return ok(input);
}

export interface ByteRange { start: number; endExclusive: number }

export type CacheResumePlan =
  | { ok: false; reason: 'bad-content-id' | 'bad-total-bytes' | 'bad-requested-range' | 'bad-verified-range' }
  | { ok: true; contentId: string; requestedRange: ByteRange; missingRanges: ByteRange[] };

export function planCacheResume(input: { contentId: string; totalBytes: number; verifiedRanges: readonly ByteRange[]; requestedRange?: ByteRange }): CacheResumePlan {
  if (!isContentId(input.contentId)) return { ok: false, reason: 'bad-content-id' };
  if (!isPositiveSafeInt(input.totalBytes)) return { ok: false, reason: 'bad-total-bytes' };
  const requested = input.requestedRange ?? { start: 0, endExclusive: input.totalBytes };
  if (!validRange(requested, input.totalBytes)) return { ok: false, reason: 'bad-requested-range' };
  if (!Array.isArray(input.verifiedRanges) || input.verifiedRanges.some((range) => !validRange(range, input.totalBytes))) return { ok: false, reason: 'bad-verified-range' };
  const ranges = normalizeByteRanges(input.verifiedRanges);
  const missing: ByteRange[] = [];
  let cursor = requested.start;
  for (const range of ranges) {
    if (range.endExclusive <= cursor || range.start >= requested.endExclusive) continue;
    if (range.start > cursor) missing.push({ start: cursor, endExclusive: Math.min(range.start, requested.endExclusive) });
    cursor = Math.max(cursor, range.endExclusive);
    if (cursor >= requested.endExclusive) break;
  }
  if (cursor < requested.endExclusive) missing.push({ start: cursor, endExclusive: requested.endExclusive });
  return { ok: true, contentId: input.contentId, requestedRange: requested, missingRanges: missing };
}

function validRange(range: ByteRange, totalBytes: number): boolean {
  return isRecord(range) && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.endExclusive) && range.start >= 0 && range.endExclusive > range.start && range.endExclusive <= totalBytes;
}

function normalizeByteRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.endExclusive - b.endExclusive);
  const normalized: ByteRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous && range.start <= previous.endExclusive) {
      previous.endExclusive = Math.max(previous.endExclusive, range.endExclusive);
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
}

export interface ControllerGrantState {
  controllerDeviceId: string;
  grantId: string;
  fence: Fence;
  expiresAt: number;
  revokedAt?: number;
  shadowOnly?: boolean;
}

export function validateEnrollmentGrant(input: { grant: ControllerGrantState; controllerDeviceId: string; now: number; revokedDeviceIds?: ReadonlySet<string> }): { ok: true } | { ok: false; reason: 'wrong-controller' | 'expired' | 'revoked' } {
  if (input.grant.controllerDeviceId !== input.controllerDeviceId) return { ok: false, reason: 'wrong-controller' };
  if (input.revokedDeviceIds?.has(input.controllerDeviceId) || input.grant.revokedAt !== undefined) return { ok: false, reason: 'revoked' };
  if (input.now >= input.grant.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true };
}

export function validateRevocation(input: { grant: ControllerGrantState; revokedAt: number; keyRotationEffectiveSeq: number; currentSeq: number }): { ok: true } | { ok: false; reason: 'already-revoked' | 'bad-time' | 'bad-key-rotation-seq' } {
  if (input.grant.revokedAt !== undefined) return { ok: false, reason: 'already-revoked' };
  if (!isFiniteTime(input.revokedAt)) return { ok: false, reason: 'bad-time' };
  if (!isSafeSeq(input.keyRotationEffectiveSeq) || input.keyRotationEffectiveSeq < input.currentSeq) return { ok: false, reason: 'bad-key-rotation-seq' };
  return { ok: true };
}

export interface HandoffState {
  oldFence: Fence;
  newFence?: Fence;
  phase: 'idle' | 'prepare' | 'quiesced' | 'granted' | 'committed' | 'aborted';
  finalSnapshotId?: string;
  finalBaseSeq?: number;
  quiesced?: boolean;
}

export function validateHandoffTransition(state: HandoffState, input: { type: 'prepare'; toHostDeviceId: string; requestedByShadowOnly?: boolean } | { type: 'quiesce'; finalSnapshotId: string; finalBaseSeq: number } | { type: 'grant'; newFence: Fence; finalSnapshotId: string; finalBaseSeq: number } | { type: 'commit'; newFence: Fence } | { type: 'abort'; reason: string }): { ok: true; state: HandoffState } | { ok: false; reason: 'shadow-only-cannot-promote' | 'bad-phase' | 'same-host' | 'missing-quiescence' | 'missing-final-snapshot' | 'epoch-not-higher' | 'fence-mismatch' } {
  if (input.type === 'prepare') {
    if (input.requestedByShadowOnly) return { ok: false, reason: 'shadow-only-cannot-promote' };
    if (state.phase !== 'idle') return { ok: false, reason: 'bad-phase' };
    if (input.toHostDeviceId === state.oldFence.hostDeviceId) return { ok: false, reason: 'same-host' };
    return { ok: true, state: { ...state, phase: 'prepare' } };
  }
  if (input.type === 'quiesce') {
    if (state.phase !== 'prepare') return { ok: false, reason: 'bad-phase' };
    if (!isSafeId(input.finalSnapshotId) || !isSafeSeq(input.finalBaseSeq)) return { ok: false, reason: 'missing-final-snapshot' };
    return { ok: true, state: { ...state, phase: 'quiesced', quiesced: true, finalSnapshotId: input.finalSnapshotId, finalBaseSeq: input.finalBaseSeq } };
  }
  if (input.type === 'grant') {
    if (state.phase !== 'quiesced' || !state.quiesced) return { ok: false, reason: 'missing-quiescence' };
    if (input.newFence.epoch <= state.oldFence.epoch) return { ok: false, reason: 'epoch-not-higher' };
    if (input.finalSnapshotId !== state.finalSnapshotId || input.finalBaseSeq !== state.finalBaseSeq) return { ok: false, reason: 'missing-final-snapshot' };
    return { ok: true, state: { ...state, phase: 'granted', newFence: input.newFence } };
  }
  if (input.type === 'commit') {
    if (state.phase !== 'granted' || !state.newFence) return { ok: false, reason: 'bad-phase' };
    if (!sameFence(state.newFence, input.newFence)) return { ok: false, reason: 'fence-mismatch' };
    return { ok: true, state: { ...state, phase: 'committed' } };
  }
  if (state.phase === 'committed') return { ok: false, reason: 'bad-phase' };
  return { ok: true, state: { ...state, phase: 'aborted' } };
}

export function isFenceValidAfterHandoff(input: { fence: Fence; handoff: HandoffState }): boolean {
  if (input.handoff.phase !== 'committed' || !input.handoff.newFence) return sameFence(input.fence, input.handoff.oldFence);
  return sameFence(input.fence, input.handoff.newFence);
}
