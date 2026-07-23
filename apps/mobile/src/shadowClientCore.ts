import {
  advanceCommandLifecycle,
  decodeBlobCapability,
  decodeShadowMessage,
  decodeVisualInputEvent,
  decideReconnect,
  planCacheResume,
  planCursorTransaction,
  sequenceShadowEvent,
  validateShadowCapabilityTiming,
  validateEnrollmentGrant,
  validateAuthorityFence,
  type BlobCapability,
  type BlobVariantRef,
  type ByteRange,
  type CommandLifecycleState,
  type ControllerGrantState,
  type Fence,
  type HostCommandAck,
  type ResumeDecision,
  type ShadowCollection,
  type ShadowCursor,
  type ShadowStateEvent,
  type ShadowTransport,
  type ShadowWireMessage,
  type VisualFrame,
  type VisualInputEvent,
  type VisualSession,
} from '@maestro/realtime';

export type ShadowConnectionState = 'offline' | 'connecting' | 'online' | 'repair-required' | 'revoked';
export type ShadowApplyStatus = 'applied' | 'duplicate' | 'gap' | 'fenced' | 'conflict' | 'invalid' | 'repair-required';
export type ShadowPreviewPermission = 'view-only' | 'control';

export interface ShadowEntity {
  id: string;
  collection: ShadowCollection;
  revision: number;
  updatedAt: number;
  deleted: boolean;
  payloadDigest: string;
  data: unknown;
}

export interface ShadowAssetDescriptor {
  capability: BlobCapability;
  variantRef: BlobVariantRef;
}

export interface ShadowAssetEntry {
  contentId: string;
  variant: string;
  totalBytes: number;
  digest: string;
  verifiedRanges: ByteRange[];
  lastAccessedAt: number;
}

export interface ShadowExpectedAuthority {
  fence: Fence;
  controllerDeviceId: string;
  leaseExpiresAt: number;
}

export interface ShadowAuthorityTransitionGrant {
  family: 'authority-transition-grant';
  v: 1;
  transitionId: string;
  // 'lease-renewal' (3A2a): SAME fence exactly, strictly-increasing lease expiry —
  // the host-signed way to extend a live lease without an epoch/leaseId change.
  kind: 'handoff' | 'lease-rotation' | 'lease-renewal';
  controllerDeviceId: string;
  previousFence: Fence;
  nextFence: Fence;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  keyId: string;
  signature: string;
}

export interface ShadowAuthorityTransitionAudit {
  transitionId: string;
  nonce: string;
  kind: ShadowAuthorityTransitionGrant['kind'];
  controllerDeviceId: string;
  previousFence: Fence;
  nextFence: Fence;
  issuedAt: number;
  expiresAt: number;
  keyId: string;
  signature: string;
  consumedAt: number;
}

export interface ShadowRepairRecord {
  id: string;
  reason: string;
  legacy?: boolean;
  class?: ShadowRepairEvidence['class'];
  table?: string;
  rowIdentityHash?: string;
  authorityScope?: ShadowRepairEvidence['authorityScope'];
  transitionIdentityHash?: string;
  assetId?: string;
  range?: ByteRange;
  createdAt: number;
}

export interface ShadowRepairEvidence {
  id: string;
  class: 'authority-chain' | 'malformed-row' | 'asset' | 'store-load';
  reason: string;
  createdAt: number;
  repairClass?: string;
  table?: string;
  rowClass?: string;
  rowIdentityHash?: string;
  authorityScope?: { accountId: string; scopeId: string; controllerDeviceId: string; hostDeviceId?: string; epoch?: number; leaseId?: string };
  transitionIdentityHash?: string;
  assetId?: string;
  range?: ByteRange;
}

export interface ShadowAuthorityTransitionVerifier {
  verifyAuthorityTransition(input: {
    grant: ShadowAuthorityTransitionGrant;
    current: ShadowExpectedAuthority;
    next: ShadowExpectedAuthority;
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ShadowVisualControlGrant {
  grantId: string;
  visualSessionId: string;
  controllerDeviceId: string;
  fence: Fence;
  mode: ShadowPreviewPermission;
  projectId: string | null;
  sessionId: string | null;
  surfaceId: string | null;
  expiresAt: number;
  signedAt: number;
  signature: string;
}

export interface ShadowPreviewState {
  visualSessionId: string;
  fence: Fence;
  controllerDeviceId: string;
  mode: VisualSession['mode'];
  inputMode: ShadowPreviewPermission;
  projectId?: string;
  sessionId?: string;
  surfaceId?: string;
  expiresAt: number;
  activeGrantId?: string;
  lastInputSeq: number;
  minFrameSeq: number;
  lastFrameSeq: number;
}

export interface ShadowState {
  controllerDeviceId: string;
  hostDeviceId: string;
  expectedAuthority: ShadowExpectedAuthority;
  cursor: ShadowCursor | null;
  connection: ShadowConnectionState;
  transport: ShadowTransport;
  readonlyOffline: boolean;
  entities: ShadowEntity[];
  commands: CommandLifecycleState[];
  assetEntries: ShadowAssetEntry[];
  grants: ControllerGrantState[];
  visualGrants: ShadowVisualControlGrant[];
  previews: ShadowPreviewState[];
  usedTransitionIds: string[];
  usedTransitionNonces: string[];
  authorityTransitions: ShadowAuthorityTransitionAudit[];
  repairRecords: ShadowRepairRecord[];
  repairReason?: string;
}

export interface ShadowStoreTransaction {
  getState(): ShadowState;
  setAuthorityCursor(cursor: ShadowCursor | null): void;
  setExpectedAuthority(expected: ShadowExpectedAuthority): void;
  setConnection(connection: ShadowConnectionState, repairReason?: string): void;
  setTransport(transport: ShadowTransport): void;
  putInbox(event: ShadowStateEvent): void;
  hasInbox(eventId: string): boolean;
  deleteInbox(eventId: string): void;
  putEntity(entity: ShadowEntity): void;
  putCommand(command: CommandLifecycleState): void;
  deleteCommand(commandId: string): void;
  putGrant(grant: ControllerGrantState): void;
  putVisualGrant(grant: ShadowVisualControlGrant): void;
  revokeController(controllerDeviceId: string, revokedAt: number): void;
  putPreview(preview: ShadowPreviewState): void;
  putAssetMetadata(entry: ShadowAssetEntry): void;
  putAssetChunk(contentId: string, range: ByteRange, bytes: Uint8Array, digest: string): void;
  consumeAuthorityTransition(grant: ShadowAuthorityTransitionGrant, expected: ShadowExpectedAuthority, staleEntityScope: { accountId: string; scopeId: string }): void;
  recordRepair(record: ShadowRepairRecord): void;
  deleteAsset(contentId: string): void;
}

export interface ShadowStore {
  load(): Promise<ShadowState>;
  recordRepairEvidence(evidence: ShadowRepairEvidence): Promise<void>;
  transaction<T>(fn: (tx: ShadowStoreTransaction) => Promise<T> | T): Promise<T>;
  readAssetRange(contentId: string, range: ByteRange | undefined, crypto: Pick<ShadowCryptoAdapter, 'digest'>): Promise<Uint8Array | null>;
  reset(): Promise<void>;
}

export interface ShadowCryptoAdapter {
  decryptEvent(event: ShadowStateEvent): Promise<{ event: ShadowStateEvent; payload: unknown } | null>;
  digest(bytes: Uint8Array): Promise<string>;
}

export interface ShadowControlMessageVerifier {
  verifyControlMessage(input: { family: ShadowWireMessage['family']; message: ShadowWireMessage; now: number }): Promise<{ ok: true } | { ok: false; reason: string }> | { ok: true } | { ok: false; reason: string } | boolean;
}

export interface ShadowDispatchAdapter {
  dispatchPreviewInput(input: VisualInputEvent): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ShadowClientOptions {
  controllerDeviceId: string;
  hostDeviceId: string;
  expectedAuthority: ShadowExpectedAuthority;
  trustedAuthorityRoot?: ShadowExpectedAuthority;
  store?: ShadowStore;
  crypto?: ShadowCryptoAdapter;
  controlMessageVerifier?: ShadowControlMessageVerifier;
  dispatch?: ShadowDispatchAdapter;
  authorityTransitionVerifier?: ShadowAuthorityTransitionVerifier;
  assetBudgetBytes?: number;
  now?: () => number;
}

export interface ShadowApplyResult {
  status: ShadowApplyStatus;
  cursor: ShadowCursor | null;
}

const DEFAULT_ASSET_BUDGET_BYTES = 32 * 1024 * 1024;

const defaultCrypto: ShadowCryptoAdapter = {
  decryptEvent: async () => null,
  digest: async () => {
    throw new Error('crypto-required');
  },
};

const defaultDispatch: ShadowDispatchAdapter = {
  dispatchPreviewInput: async () => ({ ok: true }),
};

const defaultAuthorityTransitionVerifier: ShadowAuthorityTransitionVerifier = {
  verifyAuthorityTransition: async () => ({ ok: false, reason: 'verifier-required' }),
};

const defaultControlMessageVerifier: ShadowControlMessageVerifier = {
  verifyControlMessage: async () => ({ ok: false, reason: 'verifier-required' }),
};

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function cloneExpectedAuthority(expected: ShadowExpectedAuthority): ShadowExpectedAuthority {
  return { ...expected, fence: { ...expected.fence } };
}

function emptyState(controllerDeviceId: string, hostDeviceId: string, expectedAuthority: ShadowExpectedAuthority): ShadowState {
  return {
    controllerDeviceId,
    hostDeviceId,
    expectedAuthority: cloneExpectedAuthority(expectedAuthority),
    cursor: null,
    connection: 'offline',
    transport: 'relay',
    readonlyOffline: true,
    entities: [],
    commands: [],
    assetEntries: [],
    grants: [],
    visualGrants: [],
    previews: [],
    usedTransitionIds: [],
    usedTransitionNonces: [],
    authorityTransitions: [],
    repairRecords: [],
  };
}

function sameFence(a: Fence, b: Fence): boolean {
  return a.accountId === b.accountId
    && a.scopeId === b.scopeId
    && a.hostDeviceId === b.hostDeviceId
    && a.epoch === b.epoch
    && a.leaseId === b.leaseId;
}

function sameExpectedAuthority(a: ShadowExpectedAuthority, b: ShadowExpectedAuthority): boolean {
  return sameFence(a.fence, b.fence)
    && a.controllerDeviceId === b.controllerDeviceId
    && a.leaseExpiresAt === b.leaseExpiresAt;
}

function liveAuthorityMatches(expected: ShadowExpectedAuthority, fence: Fence): boolean {
  return sameFence(expected.fence, fence);
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const textEncoder = new TextEncoder();
const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, low);
  const hash: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15] ?? 0, 7) ^ rotr(words[index - 15] ?? 0, 18) ^ ((words[index - 15] ?? 0) >>> 3);
      const s1 = rotr(words[index - 2] ?? 0, 17) ^ rotr(words[index - 2] ?? 0, 19) ^ ((words[index - 2] ?? 0) >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e ?? 0, 6) ^ rotr(e ?? 0, 11) ^ rotr(e ?? 0, 25);
      const ch = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temp1 = ((h ?? 0) + s1 + ch + SHA256_K[index] + (words[index] ?? 0)) >>> 0;
      const s0 = rotr(a ?? 0, 2) ^ rotr(a ?? 0, 13) ^ rotr(a ?? 0, 22);
      const maj = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = ((d ?? 0) + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }
  return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
}

function canonicalEncodePart(value: unknown): string {
  if (value === null) return 'null:0:';
  if (value === undefined) return 'undefined:0:';
  if (typeof value === 'string') return `string:${textEncoder.encode(value).length}:${value}`;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('invalid-canonical-number');
    return `integer:${String(value).length}:${value}`;
  }
  if (typeof value === 'boolean') return `boolean:${value ? 1 : 0}:`;
  if (value instanceof Uint8Array) return `bytes:${value.length}:${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (Array.isArray(value)) return `array:${value.length}:[${value.map(canonicalEncodePart).join('')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `object:${keys.length}:{${keys.map((key) => `${canonicalEncodePart(key)}${canonicalEncodePart(record[key])}`).join('')}}`;
  }
  throw new Error('invalid-canonical-value');
}

export function shadowIdentityDigest(domain: string, value: unknown): string {
  return sha256Hex(`shadow-identity:v2:${canonicalEncodePart(domain)}${canonicalEncodePart(value)}`);
}

export function derivedShadowPersistedId(prefix: string, value: unknown): string {
  const id = `${prefix}:v2:${shadowIdentityDigest(prefix, value)}`;
  if (!isSafeId(id)) throw new Error('invalid-derived-persisted-id');
  return id;
}

function boundedReason(value: string): string {
  return isSafeId(value) ? value : 'corrupt-store';
}

function syntheticStoreLoadEvidence(input: {
  id: string;
  reason: string;
  expectedAuthority: ShadowExpectedAuthority;
  controllerDeviceId: string;
  hostDeviceId: string;
  createdAt: number;
}): ShadowRepairEvidence {
  return {
    id: input.id,
    class: 'store-load',
    reason: boundedReason(input.reason),
    table: 'shadow_authority',
    rowClass: 'authority',
    rowIdentityHash: shadowIdentityDigest('row:shadow_authority:current', {
      table: 'shadow_authority',
      row: 'current',
      controllerDeviceId: input.controllerDeviceId,
      hostDeviceId: input.hostDeviceId,
      accountId: input.expectedAuthority.fence.accountId,
      scopeId: input.expectedAuthority.fence.scopeId,
    }),
    authorityScope: {
      accountId: input.expectedAuthority.fence.accountId,
      scopeId: input.expectedAuthority.fence.scopeId,
      controllerDeviceId: input.expectedAuthority.controllerDeviceId,
      hostDeviceId: input.expectedAuthority.fence.hostDeviceId,
      epoch: input.expectedAuthority.fence.epoch,
      leaseId: input.expectedAuthority.fence.leaseId,
    },
    createdAt: input.createdAt,
  };
}

function validateJsonDomainData(value: unknown, depth = 0, seen = { nodes: 0 }): boolean {
  if (depth > 16 || seen.nodes++ > 2_000) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return typeof value !== 'string' || value.length <= 16_384;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => validateJsonDomainData(item, depth + 1, seen));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > 1_000) return false;
  return keys.every((key) => key.length <= 256 && key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && validateJsonDomainData((value as Record<string, unknown>)[key], depth + 1, seen));
}

function payloadFitsLiveStore(value: unknown): boolean {
  if (!validateJsonDomainData(value)) return false;
  return JSON.stringify(value).length <= 131_072;
}

function isFenceShape(value: unknown): value is Fence {
  return typeof value === 'object' && value !== null
    && isSafeId((value as Fence).accountId)
    && isSafeId((value as Fence).scopeId)
    && isSafeId((value as Fence).hostDeviceId)
    && Number.isSafeInteger((value as Fence).epoch)
    && (value as Fence).epoch >= 0
    && isSafeId((value as Fence).leaseId);
}

function decodeAuthorityTransitionGrant(value: unknown): ShadowAuthorityTransitionGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const keys = Object.keys(value).sort();
  const expected = ['controllerDeviceId', 'expiresAt', 'family', 'issuedAt', 'keyId', 'kind', 'nextFence', 'nonce', 'previousFence', 'signature', 'transitionId', 'v'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  const grant = value as ShadowAuthorityTransitionGrant;
  if (grant.family !== 'authority-transition-grant' || grant.v !== 1) return null;
  if (grant.kind !== 'handoff' && grant.kind !== 'lease-rotation' && grant.kind !== 'lease-renewal') return null;
  if (!isSafeId(grant.transitionId) || !isSafeId(grant.controllerDeviceId) || !isSafeId(grant.nonce) || !isSafeId(grant.keyId) || !isSafeId(grant.signature)) return null;
  if (!isFenceShape(grant.previousFence) || !isFenceShape(grant.nextFence) || !isSafeTime(grant.issuedAt) || !isSafeTime(grant.expiresAt) || grant.issuedAt >= grant.expiresAt) return null;
  return { ...grant, previousFence: { ...grant.previousFence }, nextFence: { ...grant.nextFence } };
}

function commandIndex(commands: CommandLifecycleState[], commandId: string): number {
  return commands.findIndex((command) => command.commandId === commandId);
}

function normalizeRanges(ranges: ByteRange[]): ByteRange[] {
  return ranges
    .slice()
    .sort((a, b) => a.start - b.start || a.endExclusive - b.endExclusive)
    .reduce<ByteRange[]>((acc, range) => {
      const previous = acc.at(-1);
      if (previous && range.start <= previous.endExclusive) {
        previous.endExclusive = Math.max(previous.endExclusive, range.endExclusive);
      } else {
        acc.push({ ...range });
      }
      return acc;
    }, []);
}

function strictNormalizeRanges(ranges: ByteRange[], totalBytes: number): ByteRange[] | null {
  if (!Array.isArray(ranges)) return null;
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.endExclusive - b.endExclusive);
  const out: ByteRange[] = [];
  for (const range of sorted) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.endExclusive) || range.start < 0 || range.start >= range.endExclusive || range.endExclusive > totalBytes) return null;
    const previous = out.at(-1);
    if (previous && range.start < previous.endExclusive) return null;
    if (previous && range.start === previous.endExclusive) previous.endExclusive = range.endExclusive;
    else out.push({ ...range });
  }
  return out;
}

function subtractRange(ranges: ByteRange[], bad: ByteRange): ByteRange[] {
  const next: ByteRange[] = [];
  for (const range of ranges) {
    if (bad.endExclusive <= range.start || bad.start >= range.endExclusive) {
      next.push({ ...range });
      continue;
    }
    if (bad.start > range.start) next.push({ start: range.start, endExclusive: bad.start });
    if (bad.endExclusive < range.endExclusive) next.push({ start: bad.endExclusive, endExclusive: range.endExclusive });
  }
  return next;
}

function isValidRequestedRange(range: ByteRange, totalBytes: number): boolean {
  return Number.isSafeInteger(range.start)
    && Number.isSafeInteger(range.endExclusive)
    && range.start >= 0
    && range.start < range.endExclusive
    && range.endExclusive <= totalBytes;
}

function rangesCover(ranges: ByteRange[], requested: ByteRange): boolean {
  return ranges.some((range) => rangeContains(range, requested));
}

function rangeLength(range: ByteRange): number {
  return range.endExclusive - range.start;
}

function rangeContains(outer: ByteRange, inner: ByteRange): boolean {
  return inner.start >= outer.start && inner.endExclusive <= outer.endExclusive;
}

function sameRanges(a: ByteRange[], b: ByteRange[]): boolean {
  return a.length === b.length && a.every((range, index) => range.start === b[index]?.start && range.endExclusive === b[index]?.endExclusive);
}

function missingSpans(covered: ByteRange[], verified: ByteRange[]): ByteRange[] {
  const missing: ByteRange[] = [];
  for (const wanted of verified) {
    let pos = wanted.start;
    for (const range of covered) {
      if (range.endExclusive <= wanted.start) continue;
      if (range.start >= wanted.endExclusive) break;
      if (range.start > pos) missing.push({ start: pos, endExclusive: Math.min(range.start, wanted.endExclusive) });
      pos = Math.max(pos, Math.min(range.endExclusive, wanted.endExclusive));
    }
    if (pos < wanted.endExclusive) missing.push({ start: pos, endExclusive: wanted.endExclusive });
  }
  return missing;
}

function firstMissingSpan(covered: ByteRange[], requested: ByteRange): ByteRange | null {
  let pos = requested.start;
  for (const range of covered) {
    if (range.endExclusive <= requested.start) continue;
    if (range.start >= requested.endExclusive) break;
    if (range.start > pos) return { start: pos, endExclusive: Math.min(range.start, requested.endExclusive) };
    pos = Math.max(pos, Math.min(range.endExclusive, requested.endExclusive));
  }
  return pos < requested.endExclusive ? { start: pos, endExclusive: requested.endExclusive } : null;
}

function subtractRanges(ranges: ByteRange[], badRanges: ByteRange[]): ByteRange[] {
  return badRanges.reduce((next, bad) => subtractRange(next, bad), ranges);
}

function fullyVerified(entry: ShadowAssetEntry, range: ByteRange): boolean {
  const plan = planCacheResume({
    contentId: entry.contentId,
    totalBytes: entry.totalBytes,
    verifiedRanges: entry.verifiedRanges,
    requestedRange: range,
  });
  return plan.ok && plan.missingRanges.length === 0;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cloneState(state: ShadowState): ShadowState {
  return {
    ...state,
    expectedAuthority: cloneExpectedAuthority(state.expectedAuthority),
    cursor: state.cursor ? { ...state.cursor, fence: { ...state.cursor.fence }, history: state.cursor.history?.map((item) => ({ ...item })) } : null,
    entities: state.entities.map((item) => ({ ...item })),
    commands: state.commands.map((item) => ({ ...item, fence: { ...item.fence }, ack: item.ack ? { ...item.ack, fence: { ...item.ack.fence } } : undefined })),
    assetEntries: state.assetEntries.map((item) => ({ ...item, verifiedRanges: item.verifiedRanges.map((range) => ({ ...range })) })),
    grants: state.grants.map((item) => ({ ...item, fence: { ...item.fence } })),
    visualGrants: state.visualGrants.map((item) => ({ ...item, fence: { ...item.fence } })),
    previews: state.previews.map((item) => ({ ...item, fence: { ...item.fence } })),
    usedTransitionIds: [...state.usedTransitionIds],
    usedTransitionNonces: [...state.usedTransitionNonces],
    authorityTransitions: state.authorityTransitions.map((item) => ({ ...item, previousFence: { ...item.previousFence }, nextFence: { ...item.nextFence } })),
    repairRecords: state.repairRecords.map((item) => ({ ...item, range: item.range ? { ...item.range } : undefined })),
  };
}

class MemoryShadowTransaction implements ShadowStoreTransaction {
  constructor(
    private state: ShadowState,
    private inbox: Map<string, ShadowStateEvent>,
    private chunks: Map<string, { range: ByteRange; bytes: Uint8Array; digest: string }[]>,
  ) {}

  getState(): ShadowState { return cloneState(this.state); }
  setAuthorityCursor(cursor: ShadowCursor | null): void { this.state.cursor = cursor; }
  setExpectedAuthority(expected: ShadowExpectedAuthority): void { this.state.expectedAuthority = cloneExpectedAuthority(expected); }
  setConnection(connection: ShadowConnectionState, repairReason?: string): void {
    this.state.connection = connection;
    this.state.readonlyOffline = connection !== 'online';
    this.state.repairReason = repairReason;
  }
  setTransport(transport: ShadowTransport): void { this.state.transport = transport; }
  putInbox(event: ShadowStateEvent): void { this.inbox.set(event.eventId, event); }
  hasInbox(eventId: string): boolean { return this.inbox.has(eventId); }
  deleteInbox(eventId: string): void { this.inbox.delete(eventId); }
  putEntity(entity: ShadowEntity): void {
    this.state.entities = [...this.state.entities.filter((item) => item.collection !== entity.collection || item.id !== entity.id), entity];
  }
  putCommand(command: CommandLifecycleState): void {
    this.state.commands = [...this.state.commands.filter((item) => item.commandId !== command.commandId), command];
  }
  deleteCommand(commandId: string): void { this.state.commands = this.state.commands.filter((item) => item.commandId !== commandId); }
  putGrant(grant: ControllerGrantState): void {
    this.state.grants = [...this.state.grants.filter((item) => item.grantId !== grant.grantId), grant];
  }
  putVisualGrant(grant: ShadowVisualControlGrant): void {
    this.state.visualGrants = [...this.state.visualGrants.filter((item) => item.grantId !== grant.grantId), grant];
  }
  revokeController(controllerDeviceId: string, revokedAt: number): void {
    this.state.grants = this.state.grants
      .map((grant) => grant.controllerDeviceId === controllerDeviceId ? { ...grant, revokedAt } : grant);
    this.state.visualGrants = this.state.visualGrants.filter((grant) => grant.controllerDeviceId !== controllerDeviceId);
    this.state.previews = this.state.previews.map((preview) => preview.controllerDeviceId === controllerDeviceId ? { ...preview, inputMode: 'view-only', activeGrantId: undefined } : preview);
  }
  putPreview(preview: ShadowPreviewState): void {
    this.state.previews = [...this.state.previews.filter((item) => item.visualSessionId !== preview.visualSessionId), preview];
  }
  putAssetMetadata(entry: ShadowAssetEntry): void {
    this.state.assetEntries = [...this.state.assetEntries.filter((item) => item.contentId !== entry.contentId), entry];
  }
  putAssetChunk(contentId: string, range: ByteRange, bytes: Uint8Array, digest: string): void {
    const next = this.chunks.get(contentId)?.filter((chunk) => chunk.range.start !== range.start || chunk.range.endExclusive !== range.endExclusive) ?? [];
    next.push({ range: { ...range }, bytes: cloneBytes(bytes), digest });
    this.chunks.set(contentId, next);
  }
  consumeAuthorityTransition(grant: ShadowAuthorityTransitionGrant, expected: ShadowExpectedAuthority, staleEntityScope: { accountId: string; scopeId: string }): void {
    this.state.expectedAuthority = cloneExpectedAuthority(expected);
    // A lease-renewal keeps the SAME fence (epoch/leaseId), so cursor, entities,
    // commands and grants stay valid and the plane stays online — only the lease
    // expiry advances. Epoch/leaseId-changing transitions (handoff/lease-rotation)
    // still quiesce to a repair-required re-sync.
    if (grant.kind !== 'lease-renewal') {
      this.state.cursor = null;
      this.state.connection = 'repair-required';
      this.state.readonlyOffline = true;
      this.state.repairReason = 'authority-transition';
      this.state.commands = this.state.commands.map((command) => ['applied', 'rejected', 'expired', 'cancelled'].includes(command.status) ? command : { ...command, status: 'stale-epoch' });
      this.state.grants = [];
      this.state.visualGrants = [];
      this.state.previews = [];
      this.state.entities = this.state.entities.filter(() => staleEntityScope.accountId === expected.fence.accountId && staleEntityScope.scopeId === expected.fence.scopeId);
    }
    this.state.usedTransitionIds = [...new Set([...this.state.usedTransitionIds, grant.transitionId])];
    this.state.usedTransitionNonces = [...new Set([...this.state.usedTransitionNonces, grant.nonce])];
    // Invalidate the chain verification cache — a new transition changes the chain.
    this.verifiedChainFingerprint = null;
    // Filter out any existing audit record for this transitionId before appending —
    // repair-required states (empty in-memory usedTransitionIds) may bypass the
    // replay check in transitionAuthority(), so the store can accumulate duplicates.
    this.state.authorityTransitions = [...this.state.authorityTransitions.filter(a => a.transitionId !== grant.transitionId), {
      transitionId: grant.transitionId,
      nonce: grant.nonce,
      kind: grant.kind,
      controllerDeviceId: grant.controllerDeviceId,
      previousFence: { ...grant.previousFence },
      nextFence: { ...grant.nextFence },
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      keyId: grant.keyId,
      signature: grant.signature,
      consumedAt: Date.now(),
    }];
    this.recordRepair({ id: derivedShadowPersistedId('transition', { transitionId: grant.transitionId, nonce: grant.nonce, previousFence: grant.previousFence, nextFence: grant.nextFence }), reason: 'authority-transition', createdAt: Date.now() });
  }
  recordRepair(record: ShadowRepairRecord): void {
    if (!isSafeId(record.id) || !isSafeId(record.reason)) throw new Error('invalid-repair-record');
    this.state.repairRecords = [...this.state.repairRecords.filter((item) => item.id !== record.id), { ...record, range: record.range ? { ...record.range } : undefined }];
  }
  deleteAsset(contentId: string): void {
    this.state.assetEntries = this.state.assetEntries.filter((item) => item.contentId !== contentId);
    this.chunks.delete(contentId);
  }
}

export class MemoryShadowStore implements ShadowStore {
  private state: ShadowState;
  private inbox = new Map<string, ShadowStateEvent>();
  private chunks = new Map<string, { range: ByteRange; bytes: Uint8Array; digest: string }[]>();
  failBeforeCommit = false;

  constructor(controllerDeviceId: string, hostDeviceId: string, expectedAuthority: ShadowExpectedAuthority) {
    this.state = emptyState(controllerDeviceId, hostDeviceId, expectedAuthority);
  }

  async load(): Promise<ShadowState> {
    return cloneState(this.state);
  }

  async recordRepairEvidence(evidence: ShadowRepairEvidence): Promise<void> {
    await this.transaction((tx) => tx.recordRepair({
      id: evidence.id,
      reason: evidence.reason,
      class: evidence.class,
      table: evidence.table,
      rowIdentityHash: evidence.rowIdentityHash,
      authorityScope: evidence.authorityScope,
      transitionIdentityHash: evidence.transitionIdentityHash,
      assetId: evidence.assetId,
      range: evidence.range,
      createdAt: evidence.createdAt,
    }));
  }

  async transaction<T>(fn: (tx: ShadowStoreTransaction) => Promise<T> | T): Promise<T> {
    const nextState = cloneState(this.state);
    const nextInbox = new Map(this.inbox);
    const nextChunks = new Map([...this.chunks].map(([key, chunks]) => [key, chunks.map((chunk) => ({ range: { ...chunk.range }, bytes: cloneBytes(chunk.bytes), digest: chunk.digest }))]));
    const tx = new MemoryShadowTransaction(nextState, nextInbox, nextChunks);
    const result = await fn(tx);
    if (this.failBeforeCommit) throw new Error('injected-crash-before-commit');
    this.state = nextState;
    this.inbox = nextInbox;
    this.chunks = nextChunks;
    return result;
  }

  async readAssetRange(contentId: string, range: ByteRange | undefined, crypto: Pick<ShadowCryptoAdapter, 'digest'>): Promise<Uint8Array | null> {
    if (!isSafeId(contentId)) return null;
    const entry = this.state.assetEntries.find((asset) => asset.contentId === contentId);
    if (!entry) return null;
    const requested = range ?? { start: 0, endExclusive: entry.totalBytes };
    const verifiedRanges = strictNormalizeRanges(entry.verifiedRanges, entry.totalBytes);
    if (!verifiedRanges || !isValidRequestedRange(requested, entry.totalBytes) || !rangesCover(verifiedRanges, requested)) {
      await this.transaction((tx) => {
        tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:metadata`, 'asset-metadata-corrupt', contentId, requested, 'shadow_assets'));
        tx.deleteAsset(contentId);
      });
      return null;
    }
    const chunks = (this.chunks.get(contentId) ?? []).slice().sort((a, b) => a.range.start - b.range.start || a.range.endExclusive - b.range.endExclusive);
    const chunkRanges = strictNormalizeRanges(chunks.map((chunk) => chunk.range), entry.totalBytes);
    if (!chunkRanges || !sameRanges(chunkRanges, verifiedRanges)) {
      const missing = chunkRanges ? missingSpans(chunkRanges, verifiedRanges) : [];
      await this.transaction((tx) => {
        const requestedHole = chunkRanges ? firstMissingSpan(chunkRanges, requested) : null;
        if (requestedHole) {
          tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:${requestedHole.start}-${requestedHole.endExclusive}`, 'asset-range-hole', contentId, requestedHole, 'shadow_asset_ranges'));
          tx.putAssetMetadata({ ...entry, verifiedRanges: subtractRange(verifiedRanges, requestedHole) });
        } else if (missing.length > 0) {
          for (const span of missing) tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:${span.start}-${span.endExclusive}`, 'asset-range-gap', contentId, span, 'shadow_asset_ranges'));
          tx.putAssetMetadata({ ...entry, verifiedRanges: subtractRanges(verifiedRanges, missing) });
        } else {
          tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:ambiguous`, 'asset-range-ambiguous', contentId, requested, 'shadow_assets'));
          tx.deleteAsset(contentId);
        }
      });
      return null;
    }
    for (const chunk of chunks) {
      if (rangeLength(chunk.range) !== chunk.bytes.byteLength || await crypto.digest(chunk.bytes) !== chunk.digest) {
        await this.transaction((tx) => {
          tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:${chunk.range.start}-${chunk.range.endExclusive}`, 'asset-chunk-corrupt', contentId, chunk.range, 'shadow_asset_ranges'));
          tx.putAssetMetadata({ ...entry, verifiedRanges: subtractRange(verifiedRanges, chunk.range) });
        });
        this.chunks.set(contentId, (this.chunks.get(contentId) ?? []).filter((item) => item.range.start !== chunk.range.start || item.range.endExclusive !== chunk.range.endExclusive));
        return null;
      }
    }
    const relevant = chunks.filter((candidate) => candidate.range.endExclusive > requested.start && candidate.range.start < requested.endExclusive);
    const out = new Uint8Array(rangeLength(requested));
    let offset = 0;
    let cursor = requested.start;
    for (const chunk of relevant) {
      if (!isValidRequestedRange(chunk.range, entry.totalBytes) || chunk.range.start > cursor) {
        const gap = { start: cursor, endExclusive: Math.min(chunk.range.start, requested.endExclusive) };
        await this.transaction((tx) => {
          tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:${gap.start}-${gap.endExclusive}`, 'asset-range-gap', contentId, gap, 'shadow_asset_ranges'));
          tx.putAssetMetadata({ ...entry, verifiedRanges: subtractRange(verifiedRanges, gap) });
        });
        return null;
      }
      const takeStart = Math.max(cursor, chunk.range.start);
      const takeEnd = Math.min(chunk.range.endExclusive, requested.endExclusive);
      if (takeEnd <= takeStart) continue;
      out.set(chunk.bytes.slice(takeStart - chunk.range.start, takeEnd - chunk.range.start), offset);
      const take = takeEnd - takeStart;
      cursor = takeEnd;
      offset += take;
    }
    if (cursor !== requested.endExclusive) {
      const gap = { start: cursor, endExclusive: requested.endExclusive };
      await this.transaction((tx) => {
        tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:${gap.start}-${gap.endExclusive}`, 'asset-range-hole', contentId, gap, 'shadow_asset_ranges'));
        tx.putAssetMetadata({ ...entry, verifiedRanges: subtractRange(verifiedRanges, gap) });
      });
      return null;
    }
    if (requested.start === 0 && requested.endExclusive === entry.totalBytes && await crypto.digest(out) !== entry.digest) {
      await this.transaction((tx) => {
        tx.recordRepair(this.assetRepairRecord(`asset:${contentId}:full`, 'asset-full-digest-mismatch', contentId, requested, 'shadow_assets'));
        tx.deleteAsset(contentId);
      });
      return null;
    }
    await this.transaction((tx) => {
      tx.putAssetMetadata({ ...entry, lastAccessedAt: Date.now() });
    });
    return out;
  }

  private assetRepairRecord(id: string, reason: string, contentId: string, range: ByteRange | undefined, table: string): ShadowRepairRecord {
    return {
      id: derivedShadowPersistedId('asset', { id, reason, contentId, range, table }),
      reason,
      class: 'asset',
      table,
      rowIdentityHash: shadowIdentityDigest('asset-row-identity', { table, contentId, range }),
      authorityScope: {
        accountId: this.state.expectedAuthority.fence.accountId,
        scopeId: this.state.expectedAuthority.fence.scopeId,
        controllerDeviceId: this.state.expectedAuthority.controllerDeviceId,
        hostDeviceId: this.state.expectedAuthority.fence.hostDeviceId,
        epoch: this.state.expectedAuthority.fence.epoch,
        leaseId: this.state.expectedAuthority.fence.leaseId,
      },
      assetId: contentId,
      range,
      createdAt: Date.now(),
    };
  }

  async reset(): Promise<void> {
    this.state = emptyState(this.state.controllerDeviceId, this.state.hostDeviceId, this.state.expectedAuthority);
    this.inbox.clear();
    this.chunks.clear();
  }
}

export function createMemoryShadowStore(controllerDeviceId: string, hostDeviceId: string, expectedAuthority: ShadowExpectedAuthority): MemoryShadowStore {
  return new MemoryShadowStore(controllerDeviceId, hostDeviceId, expectedAuthority);
}

export class ShadowMobileClient {
  private state: ShadowState;
  private loaded = false;
  private readonly store: ShadowStore;
  private readonly crypto: ShadowCryptoAdapter;
  private readonly dispatch: ShadowDispatchAdapter;
  private readonly authorityTransitionVerifier: ShadowAuthorityTransitionVerifier;
  private readonly controlMessageVerifier: ShadowControlMessageVerifier;
  private readonly budget: number;
  private readonly now: () => number;
  /** Cache the last verified chain fingerprint to skip re-verification on repeated load() calls. */
  private verifiedChainFingerprint: string | null = null;

  constructor(private readonly opts: ShadowClientOptions) {
    this.store = opts.store ?? createMemoryShadowStore(opts.controllerDeviceId, opts.hostDeviceId, opts.expectedAuthority);
    this.crypto = opts.crypto ?? defaultCrypto;
    this.dispatch = opts.dispatch ?? defaultDispatch;
    this.authorityTransitionVerifier = opts.authorityTransitionVerifier ?? defaultAuthorityTransitionVerifier;
    this.controlMessageVerifier = opts.controlMessageVerifier ?? defaultControlMessageVerifier;
    this.budget = opts.assetBudgetBytes ?? DEFAULT_ASSET_BUDGET_BYTES;
    this.now = opts.now ?? Date.now;
    this.state = emptyState(opts.controllerDeviceId, opts.hostDeviceId, opts.expectedAuthority);
  }

  read(): ShadowState {
    return cloneState(this.state);
  }

  async load(): Promise<ShadowState> {
    try {
      const loaded = await this.store.load();
      const binding = await this.acceptLoadedAuthority(loaded);
      if (!binding.ok) {
        await this.recordAuthorityRepair(binding.reason, loaded);
        this.state = { ...emptyState(this.opts.controllerDeviceId, this.opts.hostDeviceId, this.opts.expectedAuthority), connection: 'repair-required', readonlyOffline: true, repairReason: binding.reason };
      } else {
        this.state = loaded;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      const reason = errorMessage.startsWith('load-repair-write-failed:')
        ? errorMessage
        : isSafeId(errorMessage)
          ? errorMessage
          : 'corrupt-store';
      if (reason === 'corrupt-store') {
        try {
          await this.store.recordRepairEvidence({
            ...syntheticStoreLoadEvidence({
              id: derivedShadowPersistedId('store-load', { controllerDeviceId: this.opts.controllerDeviceId, hostDeviceId: this.opts.hostDeviceId, reason }),
              reason,
              expectedAuthority: this.opts.expectedAuthority,
              controllerDeviceId: this.opts.controllerDeviceId,
              hostDeviceId: this.opts.hostDeviceId,
              createdAt: this.now(),
            }),
          });
        } catch (repairError) {
          this.state = { ...emptyState(this.opts.controllerDeviceId, this.opts.hostDeviceId, this.opts.expectedAuthority), connection: 'repair-required', readonlyOffline: true, repairReason: `load-repair-write-failed:${reason}:${repairError instanceof Error ? boundedReason(repairError.message) : 'unknown'}` };
          this.loaded = true;
          return this.read();
        }
      }
      this.state = { ...emptyState(this.opts.controllerDeviceId, this.opts.hostDeviceId, this.opts.expectedAuthority), connection: 'repair-required', readonlyOffline: true, repairReason: reason };
    }
    this.loaded = true;
    return this.read();
  }

  async reset(): Promise<void> {
    await this.store.reset();
    this.state = emptyState(this.opts.controllerDeviceId, this.opts.hostDeviceId, this.opts.expectedAuthority);
    this.loaded = true;
    this.verifiedChainFingerprint = null;
  }

  async applyWire(value: unknown): Promise<ShadowApplyResult> {
    const decoded = decodeShadowMessage(value, { nowMs: this.now() });
    if (!decoded.ok) return { status: 'invalid', cursor: this.state.cursor };
    return this.applyMessage(decoded.value);
  }

  async applyMessage(message: ShadowWireMessage): Promise<ShadowApplyResult> {
    if (!this.loaded) await this.load();
    if (message.family !== 'state-event' && !(await this.verifyControlMessage(message))) return { status: 'invalid', cursor: this.state.cursor };
    if (message.family === 'state-event') return this.applyStateEvent(message);
    if (message.family === 'command-ack') return this.applyCommandAck(message);
    if (message.family === 'command-state') return this.applyCommandState(message);
    if (message.family === 'preview-session') return this.applyPreview(message);
    if (message.family === 'visual-control-grant') return this.applyVisualControlGrant(message);
    if (message.family === 'visual-frame') return this.applyVisualFrame(message);
    if (message.family === 'enrollment-grant') return this.applyEnrollmentGrant(message);
    if (message.family === 'device-revocation') return this.applyRevocation(message);
    return { status: 'invalid', cursor: this.state.cursor };
  }

  private async verifyControlMessage(message: ShadowWireMessage): Promise<boolean> {
    try {
      const result = await this.controlMessageVerifier.verifyControlMessage({ family: message.family, message, now: this.now() });
      return result === true || (typeof result === 'object' && result !== null && 'ok' in result && result.ok === true);
    } catch {
      return false;
    }
  }

  async applyStateEvent(event: ShadowStateEvent): Promise<ShadowApplyResult> {
    if (!this.loaded) await this.load();
    const authority = validateAuthorityFence(
      { fence: this.state.expectedAuthority.fence, leaseExpiresAt: this.state.expectedAuthority.leaseExpiresAt },
      { fence: event.fence, controllerDeviceId: this.opts.controllerDeviceId, now: this.now() },
    );
    if (!authority.ok || this.state.expectedAuthority.controllerDeviceId !== this.opts.controllerDeviceId) {
      const reason = authority.ok ? 'wrong-controller' : authority.reason;
      console.warn('[shadow-client] fence.fail reason=' + reason + ' state.lease=' + this.state.expectedAuthority.leaseExpiresAt + ' state.leaseId=' + this.state.expectedAuthority.fence.leaseId + ' event.leaseId=' + event.fence.leaseId + ' event.epoch=' + event.fence.epoch + ' state.epoch=' + this.state.expectedAuthority.fence.epoch + ' now=' + this.now() + ' conn=' + this.state.connection);
      await this.markRepair(`authority-${reason}`);
      return { status: 'fenced', cursor: this.state.cursor };
    }
    const currentCursor = this.state.cursor;
    if (!currentCursor) {
      if (event.seq !== 1 || event.prevSeq !== 0) {
        await this.markRepair('bootstrap-gap');
        return { status: 'gap', cursor: null };
      }
      return this.applyAcceptedStateEvent(event, {
        fence: event.fence,
        lastSeq: event.seq,
        lastEventId: event.eventId,
        lastDigest: event.payloadDigest,
        history: [{ seq: event.seq, eventId: event.eventId, payloadDigest: event.payloadDigest }],
      });
    }

    const sequenced = sequenceShadowEvent(currentCursor, event);
    if (sequenced.outcome !== 'accepted') {
      if (sequenced.outcome === 'gap') await this.markRepair('event-gap');
      return { status: sequenced.outcome, cursor: this.state.cursor };
    }

    const txPlan = planCursorTransaction({
      controllerDeviceId: this.opts.controllerDeviceId,
      cursor: currentCursor,
      event,
      inboxId: `inbox_${event.eventId}`,
    });
    if (txPlan.outcome !== 'apply-and-advance') {
      if (txPlan.outcome === 'repair-required') await this.markRepair('cursor-transaction-repair');
      return { status: txPlan.outcome === 'repair-required' ? 'repair-required' : txPlan.outcome, cursor: this.state.cursor };
    }
    return this.applyAcceptedStateEvent(event, txPlan.nextCursor);
  }

  async queueCommand(input: { commandId: string; fence: Fence; expiresAt: number; createdAt?: number }): Promise<CommandLifecycleState> {
    if (!this.loaded) await this.load();
    const existing = this.state.commands[commandIndex(this.state.commands, input.commandId)];
    if (existing) return existing;
    const createdAt = input.createdAt ?? this.now();
    const timing = validateShadowCapabilityTiming({ family: 'command-envelope', sourceAt: createdAt, expiresAt: input.expiresAt, nowMs: this.now() });
    if (!timing.ok) throw new Error('invalid-command-expiry');
    const command: CommandLifecycleState = {
      status: 'pending-local',
      commandId: input.commandId,
      fence: input.fence,
      createdAt,
      expiresAt: input.expiresAt,
    };
    if (!sameFence(command.fence, this.state.expectedAuthority.fence)) throw new Error('command-authority-mismatch');
    await this.store.transaction((tx) => tx.putCommand(command));
    await this.load();
    return command;
  }

  async markCommandSent(commandId: string): Promise<CommandLifecycleState | null> {
    if (!this.loaded) await this.load();
    const current = this.state.commands[commandIndex(this.state.commands, commandId)];
    if (!current) return null;
    const result = advanceCommandLifecycle(current, { type: 'sent', now: this.now() });
    if (result.outcome === 'invalid' || result.outcome === 'fenced') return null;
    await this.store.transaction((tx) => tx.putCommand(result.state));
    await this.load();
    return result.state;
  }

  async advanceCommand(commandId: string, type: 'execute' | 'await-state-event' | 'expire' | 'cancel'): Promise<CommandLifecycleState | null> {
    if (!this.loaded) await this.load();
    const current = this.state.commands[commandIndex(this.state.commands, commandId)];
    if (!current) return null;
    const result = advanceCommandLifecycle(current, { type, now: this.now() });
    if (result.outcome === 'invalid' || result.outcome === 'fenced') return null;
    await this.store.transaction((tx) => tx.putCommand(result.state));
    await this.load();
    return result.state;
  }

  async setTransport(transport: ShadowTransport): Promise<void> {
    if (!this.loaded) await this.load();
    await this.store.transaction((tx) => tx.setTransport(transport));
    await this.load();
  }

  async setOnline(online: boolean): Promise<void> {
    if (!this.loaded) await this.load();
    await this.store.transaction((tx) => tx.setConnection(online ? 'online' : 'offline'));
    await this.load();
  }

  /**
   * Extend the in-memory authority lease WITHOUT touching the store. Used by the
   * service to bridge the gap between the chain endpoint's lease (from host-signed
   * transitions) and the server-authenticated effective lease. The store is NOT
   * updated — acceptLoadedAuthority still verifies from the chain, and the next
   * load() resets in-memory state from the store. This only affects
   * validateAuthorityFence during the current drain cycle.
   */
  extendInMemoryLease(expiresAt: number): void {
    if (expiresAt > this.state.expectedAuthority.leaseExpiresAt) {
      this.state.expectedAuthority.leaseExpiresAt = expiresAt;
    }
  }

  getOfflineTruth(): { readonly: true; reason: 'offline' | 'repair-required' | 'revoked' } | { readonly: false } {
    if (this.state.connection === 'online') return { readonly: false };
    return {
      readonly: true,
      reason: this.state.connection === 'repair-required' || this.state.connection === 'revoked' ? this.state.connection : 'offline',
    };
  }

  reconnectPlan(input: { retainedMinSeq: number; headSeq: number; latestSnapshotId: string; latestSnapshotBaseSeq?: number }): ResumeDecision {
    return decideReconnect({
      hello: {
        protocolVersion: 1,
        hostDeviceId: this.opts.hostDeviceId,
        epoch: this.state.cursor?.fence.epoch ?? 0,
        lastSeq: this.state.cursor?.lastSeq ?? 0,
        collectionDigests: {},
      },
      retainedMinSeq: input.retainedMinSeq,
      headSeq: input.headSeq,
      latestSnapshotId: input.latestSnapshotId,
      latestSnapshotBaseSeq: input.latestSnapshotBaseSeq,
      hostDeviceId: this.opts.hostDeviceId,
      epoch: this.state.cursor?.fence.epoch ?? 0,
      supportedProtocolVersions: [1],
    });
  }

  async putAssetRange(input: { descriptor: ShadowAssetDescriptor; range: ByteRange; bytes: Uint8Array }): Promise<{ ok: true; entry: ShadowAssetEntry } | { ok: false; reason: string }> {
    if (!this.loaded) await this.load();
    const decoded = decodeBlobCapability(input.descriptor.capability, {
      controllerDeviceId: this.opts.controllerDeviceId,
      fence: this.state.expectedAuthority.fence,
      contentId: input.descriptor.variantRef.contentId,
      variant: input.descriptor.variantRef.variant,
      now: this.now(),
    }, { nowMs: this.now() });
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    if (!input.descriptor.capability.permissions.includes('read') && !input.descriptor.capability.permissions.includes('range-read')) return { ok: false, reason: 'missing-read-permission' };
    if (rangeLength(input.range) !== input.bytes.byteLength) return { ok: false, reason: 'range-byte-length-mismatch' };
    const prior = this.state.assetEntries.find((entry) => entry.contentId === input.descriptor.variantRef.contentId);
    const plan = planCacheResume({
      contentId: input.descriptor.variantRef.contentId,
      totalBytes: input.descriptor.variantRef.bytes,
      verifiedRanges: prior?.verifiedRanges ?? [],
      requestedRange: input.range,
    });
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const digest = await this.crypto.digest(input.bytes);
    if (input.range.start === 0 && input.range.endExclusive === input.descriptor.variantRef.bytes && digest !== input.descriptor.variantRef.sha256) {
      return { ok: false, reason: 'digest-mismatch' };
    }
    const entry: ShadowAssetEntry = {
      contentId: input.descriptor.variantRef.contentId,
      variant: input.descriptor.variantRef.variant,
      totalBytes: input.descriptor.variantRef.bytes,
      digest: input.descriptor.variantRef.sha256,
      verifiedRanges: normalizeRanges([...(prior?.verifiedRanges ?? []), input.range]),
      lastAccessedAt: this.now(),
    };
    if (fullyVerified(entry, { start: 0, endExclusive: entry.totalBytes })) {
      const assembled = new Uint8Array(entry.totalBytes);
      for (const verified of prior?.verifiedRanges ?? []) {
        const priorBytes = await this.store.readAssetRange(entry.contentId, verified, this.crypto);
        if (!priorBytes) return { ok: false, reason: 'verified-range-missing' };
        assembled.set(priorBytes, verified.start);
      }
      assembled.set(input.bytes, input.range.start);
      const fullDigest = await this.crypto.digest(assembled);
      if (fullDigest !== entry.digest) return { ok: false, reason: 'digest-mismatch' };
    }
    await this.store.transaction((tx) => {
      tx.putAssetChunk(entry.contentId, input.range, input.bytes, digest);
      tx.putAssetMetadata(entry);
      for (const contentId of this.assetsToEvict([...this.state.assetEntries.filter((asset) => asset.contentId !== entry.contentId), entry])) {
        tx.deleteAsset(contentId);
      }
    });
    await this.load();
    return { ok: true, entry };
  }

  async readAsset(contentId: string, range?: ByteRange): Promise<Uint8Array | null> {
    if (!this.loaded) await this.load();
    const entry = this.state.assetEntries.find((asset) => asset.contentId === contentId);
    if (!entry) return null;
    const requested = range ?? { start: 0, endExclusive: entry.totalBytes };
    if (!rangeContains({ start: 0, endExclusive: entry.totalBytes }, requested) || !fullyVerified(entry, requested)) return null;
    return this.store.readAssetRange(contentId, requested, this.crypto);
  }

  async transitionAuthority(input: unknown): Promise<boolean> {
    if (!this.loaded) await this.load();
    const grant = decodeAuthorityTransitionGrant(input);
    if (!grant) return false;
    if (this.state.usedTransitionIds.includes(grant.transitionId) || this.state.usedTransitionNonces.includes(grant.nonce)) return false;
    if (!sameFence(this.state.expectedAuthority.fence, grant.previousFence) || this.state.expectedAuthority.controllerDeviceId !== grant.controllerDeviceId) return false;
    const now = this.now();
    if (now < grant.issuedAt || now >= grant.expiresAt) return false;
    if (grant.nextFence.accountId !== grant.previousFence.accountId || grant.nextFence.scopeId !== grant.previousFence.scopeId) return false;
    if (grant.kind === 'lease-rotation') {
      if (grant.nextFence.hostDeviceId !== grant.previousFence.hostDeviceId || grant.nextFence.epoch !== grant.previousFence.epoch || grant.nextFence.leaseId === grant.previousFence.leaseId) return false;
    } else if (grant.kind === 'lease-renewal') {
      // Same fence EXACTLY (incl. hostDeviceId/epoch/leaseId) + strictly-increasing
      // expiry — reject rollback/equal so a stale/replayed renewal cannot regress.
      if (!sameFence(grant.nextFence, grant.previousFence)) return false;
      if (grant.expiresAt <= this.state.expectedAuthority.leaseExpiresAt) return false;
    } else if (grant.nextFence.epoch !== grant.previousFence.epoch + 1 || grant.nextFence.leaseId === grant.previousFence.leaseId) {
      return false;
    }
    const nextExpected: ShadowExpectedAuthority = { controllerDeviceId: grant.controllerDeviceId, fence: grant.nextFence, leaseExpiresAt: grant.expiresAt };
    const verified = await this.authorityTransitionVerifier.verifyAuthorityTransition({ grant, current: this.state.expectedAuthority, next: nextExpected, now });
    if (!verified.ok) return false;
    await this.store.transaction((tx) => tx.consumeAuthorityTransition(grant, nextExpected, { accountId: grant.previousFence.accountId, scopeId: grant.previousFence.scopeId }));
    this.state = await this.store.load();
    return true;
  }

  async requestPreviewControl(input: { visualSessionId: string; grantId: string }): Promise<ShadowPreviewState | null> {
    if (!this.loaded) await this.load();
    const preview = this.state.previews.find((item) => item.visualSessionId === input.visualSessionId);
    const grant = this.state.visualGrants.find((item) => item.grantId === input.grantId);
    if (!preview || !grant || !sameFence(preview.fence, grant.fence)) return null;
    if (preview.controllerDeviceId !== this.opts.controllerDeviceId || preview.controllerDeviceId !== grant.controllerDeviceId) return null;
    if (!this.previewGrantActive(preview, grant)) {
      await this.downgradePreview(preview, 'preview-control-expired');
      return null;
    }
    const next: ShadowPreviewState = { ...preview, inputMode: 'control', activeGrantId: grant.grantId };
    await this.store.transaction((tx) => tx.putPreview(next));
    await this.load();
    return next;
  }

  async dispatchPreviewInput(value: unknown): Promise<{ ok: true; input: VisualInputEvent } | { ok: false; reason: string }> {
    if (!this.loaded) await this.load();
    const visualSessionId = typeof value === 'object' && value ? String((value as { visualSessionId?: unknown }).visualSessionId ?? '') : '';
    const preview = this.state.previews.find((item) => item.visualSessionId === visualSessionId);
    if (!preview || preview.inputMode !== 'control' || !preview.activeGrantId) return { ok: false, reason: 'control-not-approved' };
    const grant = this.state.visualGrants.find((item) => item.grantId === preview.activeGrantId);
    if (!grant || !this.previewGrantActive(preview, grant)) {
      await this.downgradePreview(preview, 'preview-control-expired');
      return { ok: false, reason: 'grant-not-active' };
    }
    const decoded = decodeVisualInputEvent(value, {
      visualSessionId,
      mode: 'control',
      lastInputSeq: preview.lastInputSeq,
      minFrameSeq: preview.minFrameSeq,
      now: this.now(),
      maxAgeMs: 10_000,
    });
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    if (decoded.value.fence && !sameFence(decoded.value.fence, preview.fence)) return { ok: false, reason: 'wrong-fence' };
    const accepted = await this.dispatch.dispatchPreviewInput(decoded.value);
    if (!accepted.ok) return accepted;
    await this.store.transaction((tx) => tx.putPreview({ ...preview, lastInputSeq: decoded.value.inputSeq }));
    await this.load();
    return { ok: true, input: decoded.value };
  }

  private async applyAcceptedStateEvent(event: ShadowStateEvent, nextCursor: ShadowCursor): Promise<ShadowApplyResult> {
    const decrypted = await this.crypto.decryptEvent(event);
    if (!decrypted) {
      await this.markRepair('decrypt-failed');
      return { status: 'repair-required', cursor: this.state.cursor };
    }
    if (!payloadFitsLiveStore(decrypted.payload)) {
      await this.markRepair('malformed-entity-row');
      return { status: 'repair-required', cursor: this.state.cursor };
    }
    const entity: ShadowEntity = {
      id: event.entityId,
      collection: event.collection,
      revision: event.revision,
      updatedAt: event.createdAt,
      deleted: event.op === 'delete',
      payloadDigest: event.payloadDigest,
      data: decrypted.payload,
    };
    await this.store.transaction((tx) => {
      tx.putInbox(event);
      tx.putEntity(entity);
      const current = tx.getState();
      const command = event.commandId ? current.commands[commandIndex(current.commands, event.commandId)] : undefined;
      if (command) {
        const result = advanceCommandLifecycle(command, { type: 'state-event', event, now: this.now() });
        tx.putCommand(result.state);
      }
      tx.setAuthorityCursor(nextCursor);
      tx.deleteInbox(event.eventId);
    });
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async applyCommandAck(ack: HostCommandAck): Promise<ShadowApplyResult> {
    if (ack.family !== 'command-ack' || !liveAuthorityMatches(this.state.expectedAuthority, ack.fence)) return { status: 'fenced', cursor: this.state.cursor };
    const current = this.state.commands[commandIndex(this.state.commands, ack.commandId)];
    if (!current) return { status: 'invalid', cursor: this.state.cursor };
    if (!liveAuthorityMatches(this.state.expectedAuthority, current.fence)) return { status: 'fenced', cursor: this.state.cursor };
    const result = advanceCommandLifecycle(current, { type: 'host-ack', ack, now: this.now() });
    await this.store.transaction((tx) => tx.putCommand(result.state));
    await this.load();
    return { status: result.outcome === 'fenced' ? 'fenced' : result.outcome === 'invalid' ? 'invalid' : 'applied', cursor: this.state.cursor };
  }

  private async applyCommandState(event: Extract<ShadowWireMessage, { family: 'command-state' }>): Promise<ShadowApplyResult> {
    if (!liveAuthorityMatches(this.state.expectedAuthority, event.fence)) return { status: 'fenced', cursor: this.state.cursor };
    const current = this.state.commands[commandIndex(this.state.commands, event.commandId)];
    if (!current || !sameFence(current.fence, event.fence) || !liveAuthorityMatches(this.state.expectedAuthority, current.fence)) return { status: current ? 'fenced' : 'invalid', cursor: this.state.cursor };
    const transitionType = event.state === 'accepted'
      ? null
      : event.state === 'executing'
        ? 'execute'
        : event.state === 'awaiting-state-event'
          ? 'await-state-event'
          : undefined;
    if (transitionType === undefined) return { status: 'invalid', cursor: this.state.cursor };
    const result = transitionType === null
      ? (current.status === 'accepted' ? { outcome: 'idempotent' as const, state: current } : { outcome: 'invalid' as const, state: current })
      : advanceCommandLifecycle(current, { type: transitionType, now: this.now() });
    if (result.outcome === 'invalid' || result.outcome === 'fenced') return { status: result.outcome, cursor: this.state.cursor };
    await this.store.transaction((tx) => tx.putCommand(result.state));
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async applyPreview(session: VisualSession & { family: 'preview-session' }): Promise<ShadowApplyResult> {
    const timing = validateShadowCapabilityTiming({ family: 'preview-session', expiresAt: session.expiresAt, nowMs: this.now() });
    if (!timing.ok || session.controllerDeviceId !== this.opts.controllerDeviceId || !sameFence(session.fence, this.state.expectedAuthority.fence)) {
      return { status: 'invalid', cursor: this.state.cursor };
    }
    const preview: ShadowPreviewState = {
      visualSessionId: session.visualSessionId,
      fence: session.fence,
      controllerDeviceId: session.controllerDeviceId,
      mode: session.mode,
      inputMode: 'view-only',
      projectId: session.projectId ?? undefined,
      sessionId: session.sessionId ?? undefined,
      surfaceId: session.surfaceId ?? undefined,
      expiresAt: session.expiresAt,
      lastInputSeq: 0,
      minFrameSeq: 0,
      lastFrameSeq: 0,
    };
    await this.store.transaction((tx) => tx.putPreview(preview));
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async applyVisualControlGrant(grant: Extract<ShadowWireMessage, { family: 'visual-control-grant' }>): Promise<ShadowApplyResult> {
    const preview = this.state.previews.find((item) => item.visualSessionId === grant.visualSessionId);
    const timing = validateShadowCapabilityTiming({ family: 'visual-control-grant', sourceAt: grant.signedAt, expiresAt: grant.expiresAt, nowMs: this.now() });
    if (!timing.ok || !preview || grant.mode !== 'control' || grant.controllerDeviceId !== this.opts.controllerDeviceId || !sameFence(preview.fence, grant.fence) || !sameFence(grant.fence, this.state.expectedAuthority.fence) || preview.expiresAt <= this.now()) {
      return { status: 'invalid', cursor: this.state.cursor };
    }
    const grantId = grant.grantId ?? `v1:v2:${shadowIdentityDigest('visual-control-grant:v1', {
      visualSessionId: grant.visualSessionId,
      fence: grant.fence,
      controllerDeviceId: grant.controllerDeviceId,
      mode: grant.mode,
      expiresAt: grant.expiresAt,
      signedAt: grant.signedAt,
      signature: grant.signature,
    })}`;
    const scoped: ShadowVisualControlGrant = {
      controllerDeviceId: grant.controllerDeviceId,
      grantId,
      visualSessionId: grant.visualSessionId,
      fence: grant.fence,
      mode: grant.mode,
      projectId: preview.projectId ?? null,
      sessionId: preview.sessionId ?? null,
      surfaceId: preview.surfaceId ?? null,
      expiresAt: grant.expiresAt,
      signedAt: grant.signedAt,
      signature: grant.signature,
    };
    await this.store.transaction((tx) => tx.putVisualGrant(scoped));
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async applyVisualFrame(frame: VisualFrame): Promise<ShadowApplyResult> {
    const preview = this.state.previews.find((item) => item.visualSessionId === frame.visualSessionId);
    if (!preview || frame.frameSeq <= preview.lastFrameSeq || frame.hostStateSeq < (this.state.cursor?.lastSeq ?? 0)) return { status: 'invalid', cursor: this.state.cursor };
    await this.store.transaction((tx) => tx.putPreview({ ...preview, lastFrameSeq: frame.frameSeq, minFrameSeq: Math.max(preview.minFrameSeq, frame.frameSeq) }));
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async applyEnrollmentGrant(grant: Extract<ShadowWireMessage, { family: 'enrollment-grant' }>): Promise<ShadowApplyResult> {
    const timing = validateShadowCapabilityTiming({ family: 'enrollment-grant', sourceAt: grant.signedAt, expiresAt: grant.expiresAt, nowMs: this.now() });
    if (!timing.ok || grant.controllerDeviceId !== this.opts.controllerDeviceId || !sameFence(grant.fence, this.state.expectedAuthority.fence)) return { status: 'invalid', cursor: this.state.cursor };
    await this.store.transaction((tx) => tx.putGrant({ controllerDeviceId: grant.controllerDeviceId, grantId: grant.grantId, fence: grant.fence, expiresAt: grant.expiresAt }));
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async applyRevocation(revocation: Extract<ShadowWireMessage, { family: 'device-revocation' }>): Promise<ShadowApplyResult> {
    if (revocation.controllerDeviceId !== this.opts.controllerDeviceId || !sameFence(revocation.fence, this.state.expectedAuthority.fence)) return { status: 'invalid', cursor: this.state.cursor };
    if (revocation.revokedAt > this.now() + 60_000 || revocation.revokedAt + 24 * 60 * 60 * 1_000 < this.now()) return { status: 'invalid', cursor: this.state.cursor };
    const revocationReplayId = derivedShadowPersistedId('revoked', {
      accountId: revocation.fence.accountId,
      scopeId: revocation.fence.scopeId,
      hostDeviceId: revocation.fence.hostDeviceId,
      controllerDeviceId: revocation.controllerDeviceId,
      epoch: revocation.fence.epoch,
      leaseId: revocation.fence.leaseId,
      keyRotationId: revocation.keyRotationId,
      revokedAt: revocation.revokedAt,
      signature: revocation.signature,
    });
    if (this.state.repairRecords.some((record) => record.id === revocationReplayId)) {
      return { status: this.state.connection === 'revoked' ? 'duplicate' : 'invalid', cursor: this.state.cursor };
    }
    await this.store.transaction((tx) => {
      tx.revokeController(revocation.controllerDeviceId, revocation.revokedAt);
      tx.recordRepair({
        id: revocationReplayId,
        reason: 'controller-revoked',
        class: 'store-load',
        table: 'shadow_authority',
        rowIdentityHash: shadowIdentityDigest('row:shadow_authority:revocation', { table: 'shadow_authority', row: 'current', fence: revocation.fence, keyRotationId: revocation.keyRotationId }),
        authorityScope: {
          accountId: revocation.fence.accountId,
          scopeId: revocation.fence.scopeId,
          controllerDeviceId: revocation.controllerDeviceId,
          hostDeviceId: revocation.fence.hostDeviceId,
          epoch: revocation.fence.epoch,
          leaseId: revocation.fence.leaseId,
        },
        createdAt: revocation.revokedAt,
      });
      tx.setConnection('revoked');
    });
    await this.load();
    return { status: 'applied', cursor: this.state.cursor };
  }

  private async markRepair(reason: string): Promise<void> {
    await this.store.transaction((tx) => tx.setConnection('repair-required', reason));
    await this.load();
  }

  private async recordAuthorityRepair(reason: string, loaded: ShadowState): Promise<void> {
    const transition = loaded.authorityTransitions.at(-1);
    await this.store.recordRepairEvidence({
      id: derivedShadowPersistedId('authority-chain', {
        reason,
        controllerDeviceId: loaded.expectedAuthority.controllerDeviceId,
        accountId: loaded.expectedAuthority.fence.accountId,
        scopeId: loaded.expectedAuthority.fence.scopeId,
        transitionId: transition?.transitionId,
        nonce: transition?.nonce,
      }),
      class: 'authority-chain',
      reason,
      createdAt: this.now(),
      authorityScope: {
        accountId: loaded.expectedAuthority.fence.accountId,
        scopeId: loaded.expectedAuthority.fence.scopeId,
        controllerDeviceId: loaded.expectedAuthority.controllerDeviceId,
      },
      transitionIdentityHash: transition ? shadowIdentityDigest('transition-identity', { transitionId: transition.transitionId, nonce: transition.nonce, kind: transition.kind }) : undefined,
    });
  }

  /** Build a fingerprint string from the deduped chain IDs + loaded authority.
   *  If the fingerprint matches a previous verified result, the expensive Ed25519
   *  chain walk can be skipped entirely. */
  private chainFingerprint(chainIds: string[], loaded: ShadowExpectedAuthority): string {
    return chainIds.join(',') + '|' + loaded.controllerDeviceId + '|' + loaded.fence.leaseId + '|' + loaded.fence.epoch + '|' + loaded.leaseExpiresAt;
  }

  private async acceptLoadedAuthority(loaded: ShadowState): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (loaded.controllerDeviceId !== this.opts.controllerDeviceId || loaded.hostDeviceId !== this.opts.hostDeviceId) return { ok: false, reason: 'wrong-device-binding' };
    const sorted = loaded.authorityTransitions.slice().sort((a, b) => a.consumedAt - b.consumedAt || a.issuedAt - b.issuedAt);
    // Deduplicate by transitionId — when load() enters repair-required (empty
    // in-memory usedTransitionIds), subsequent transitionAuthority() calls may
    // re-consume already-stored transitions, creating duplicate audit records.
    // Keep only the first (oldest consumedAt) per transitionId.
    // Also filter to the current controllerDeviceId — the store may retain
    // transitions from a previous enrollment with a different device identity.
    const chainIdSet = new Set<string>();
    const chain = sorted
      .filter(a => a.controllerDeviceId === this.opts.controllerDeviceId)
      .filter(a => { if (chainIdSet.has(a.transitionId)) return false; chainIdSet.add(a.transitionId); return true; });
    if (chain.length === 0) return { ok: sameExpectedAuthority(loaded.expectedAuthority, this.opts.expectedAuthority), reason: sameExpectedAuthority(loaded.expectedAuthority, this.opts.expectedAuthority) ? undefined as never : 'transition-chain-incomplete' };

    // Fast path: if the chain hasn't changed since the last successful verification,
    // skip the expensive Ed25519 signature walk (~3s for 57 transitions).
    const fp = this.chainFingerprint(chain.map(a => a.transitionId), loaded.expectedAuthority);
    if (fp === this.verifiedChainFingerprint) {
      return { ok: true };
    }

    console.warn('[shadow-client] acceptAuth rawChain=' + loaded.authorityTransitions.length + ' dedupedChain=' + chain.length + ' conn=' + loaded.connection + ' loadedLease=' + loaded.expectedAuthority.leaseExpiresAt + ' optsLease=' + this.opts.expectedAuthority.leaseExpiresAt);
    const trustedRoot = this.opts.trustedAuthorityRoot ?? (sameExpectedAuthority(loaded.expectedAuthority, this.opts.expectedAuthority) ? undefined : this.opts.expectedAuthority);
    if (!trustedRoot) { console.warn('[shadow-client] acceptAuth.fail trusted-root-required'); return { ok: false, reason: 'trusted-root-required' }; }
    if (sameExpectedAuthority(loaded.expectedAuthority, trustedRoot)) { console.warn('[shadow-client] acceptAuth.fail transition-chain-incomplete loaded==root'); return { ok: false, reason: 'transition-chain-incomplete' }; }
    let current = cloneExpectedAuthority(trustedRoot);
    const seenIds = new Set<string>();
    const seenNonces = new Set<string>();
    for (let i = 0; i < chain.length; i++) {
      const audit = chain[i];
      if (seenIds.has(audit.transitionId) || seenNonces.has(audit.nonce)) { console.warn('[shadow-client] acceptAuth.fail replay i=' + i + ' id=' + audit.transitionId); return { ok: false, reason: 'transition-replay' }; }
      seenIds.add(audit.transitionId);
      seenNonces.add(audit.nonce);
      if (!sameFence(current.fence, audit.previousFence) || current.controllerDeviceId !== audit.controllerDeviceId) { console.warn('[shadow-client] acceptAuth.fail gap i=' + i + ' fenceMatch=' + sameFence(current.fence, audit.previousFence) + ' devMatch=' + (current.controllerDeviceId === audit.controllerDeviceId) + ' currentDev=' + current.controllerDeviceId + ' auditDev=' + audit.controllerDeviceId); return { ok: false, reason: 'transition-chain-gap' }; }
      const grant: ShadowAuthorityTransitionGrant = { family: 'authority-transition-grant', v: 1, ...audit };
      const next: ShadowExpectedAuthority = { controllerDeviceId: audit.controllerDeviceId, fence: { ...audit.nextFence }, leaseExpiresAt: audit.expiresAt };
      if (audit.kind === 'lease-rotation') {
        if (audit.nextFence.accountId !== audit.previousFence.accountId || audit.nextFence.scopeId !== audit.previousFence.scopeId || audit.nextFence.hostDeviceId !== audit.previousFence.hostDeviceId || audit.nextFence.epoch !== audit.previousFence.epoch || audit.nextFence.leaseId === audit.previousFence.leaseId) { console.warn('[shadow-client] acceptAuth.fail rotation-gap i=' + i); return { ok: false, reason: 'transition-chain-gap' }; }
      } else if (audit.kind === 'lease-renewal') {
        // Same fence exactly + strictly-increasing expiry over the prior authority.
        if (!sameFence(audit.nextFence, audit.previousFence) || audit.expiresAt <= current.leaseExpiresAt) { console.warn('[shadow-client] acceptAuth.fail renewal-gap i=' + i + ' expires=' + audit.expiresAt + ' currentLease=' + current.leaseExpiresAt + ' fenceMatch=' + sameFence(audit.nextFence, audit.previousFence)); return { ok: false, reason: 'transition-chain-gap' }; }
      } else if (audit.nextFence.accountId !== audit.previousFence.accountId || audit.nextFence.scopeId !== audit.previousFence.scopeId || audit.nextFence.epoch !== audit.previousFence.epoch + 1 || audit.nextFence.leaseId === audit.previousFence.leaseId) {
        console.warn('[shadow-client] acceptAuth.fail handoff-gap i=' + i);
        return { ok: false, reason: 'transition-chain-gap' };
      }
      const verified = await this.authorityTransitionVerifier.verifyAuthorityTransition({ grant, current, next, now: this.now() });
      if (!verified.ok) { console.warn('[shadow-client] acceptAuth.fail verify i=' + i + ' reason=' + verified.reason); return { ok: false, reason: `transition-${verified.reason}` }; }
      current = next;
    }
    console.warn('[shadow-client] acceptAuth chainOk currentLease=' + current.leaseExpiresAt);
    if (!sameExpectedAuthority(current, loaded.expectedAuthority)) {
      // Self-heal: the chain verified cleanly from the trusted root (all host
      // signatures checked), but the store's expectedAuthority diverged — likely from
      // a prior server-side lease persist that wrote a different expiry without a
      // corresponding signed transition. Repair the store to match the
      // cryptographically proven chain endpoint so future load() calls pass.
      try {
        await this.store.transaction((tx) => tx.setExpectedAuthority(current));
        // Also update the `loaded` object in place — the caller's `this.state = loaded`
        // would otherwise get the STALE pre-repair authority. The stale lease may have
        // expired, causing validateAuthorityFence to reject every event with 'expired'.
        loaded.expectedAuthority = { controllerDeviceId: current.controllerDeviceId, fence: { ...current.fence }, leaseExpiresAt: current.leaseExpiresAt };
      } catch {
        return { ok: false, reason: 'transition-chain-repair-failed' };
      }
    }
    if (!sameExpectedAuthority(loaded.expectedAuthority, this.opts.expectedAuthority) && this.opts.trustedAuthorityRoot) return { ok: false, reason: 'expected-current-mismatch' };
    // Cache the fingerprint so subsequent load() calls with the same chain skip verification.
    this.verifiedChainFingerprint = fp;
    return { ok: true };
  }

  private previewGrantActive(preview: ShadowPreviewState, grant: ShadowVisualControlGrant): boolean {
    return preview.expiresAt > this.now()
      && grant.expiresAt > this.now()
      && grant.mode === 'control'
      && grant.visualSessionId === preview.visualSessionId
      && grant.controllerDeviceId === this.opts.controllerDeviceId
      && sameFence(grant.fence, preview.fence)
      && (preview.projectId ?? null) === grant.projectId
      && (preview.sessionId ?? null) === grant.sessionId
      && (preview.surfaceId ?? null) === grant.surfaceId;
  }

  private async downgradePreview(preview: ShadowPreviewState, reason: string): Promise<void> {
    await this.store.transaction((tx) => {
      tx.putPreview({ ...preview, inputMode: 'view-only', activeGrantId: undefined });
      tx.setConnection(this.state.connection, reason);
    });
    await this.load();
  }

  private assetsToEvict(entries: ShadowAssetEntry[]): string[] {
    let total = entries.reduce((sum, entry) => sum + entry.totalBytes, 0);
    if (total <= this.budget) return [];
    const evict: string[] = [];
    for (const entry of entries.slice().sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.contentId.localeCompare(b.contentId))) {
      if (total <= this.budget) break;
      evict.push(entry.contentId);
      total -= entry.totalBytes;
    }
    return evict;
  }
}
