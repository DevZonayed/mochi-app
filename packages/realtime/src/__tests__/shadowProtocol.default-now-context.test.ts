import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHADOW_ASSET_CAPABILITY_MAX_TTL_MS,
  SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS,
  SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS,
  SHADOW_MAX_FUTURE_CLOCK_SKEW_MS,
  SHADOW_PREVIEW_SESSION_MAX_TTL_MS,
  SHADOW_PROTOCOL_VERSION,
  SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS,
  SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS,
  decodeBlobCapability,
  decodeShadowMessage,
  decodeWebTunnelSession,
} from '../shadowProtocol';

const now = 1_700_000_000_000;
const fence = { accountId: 'acct_main', scopeId: 'scope_main', hostDeviceId: 'host_mac_1', epoch: 7, leaseId: 'lease_active' };

const preview = (expiresAt: number) => ({
  family: 'preview-session',
  v: SHADOW_PROTOCOL_VERSION,
  visualSessionId: 'vis_1',
  fence,
  controllerDeviceId: 'ctrl_phone_1',
  source: 'browser',
  mode: 'web-tunnel',
  inputMode: 'view-only',
  transport: 'encrypted-relay',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  expiresAt,
  signature: 'sig_preview',
});

const assetCapability = (expiresAt: number) => ({
  family: 'asset-capability',
  v: SHADOW_PROTOCOL_VERSION,
  capabilityId: 'cap_1',
  fence,
  controllerDeviceId: 'ctrl_phone_1',
  assetId: 'asset_1',
  contentId: 'cid_screen',
  variant: 'screen',
  permissions: ['read', 'range-read'],
  expiresAt,
  signature: 'sig_cap',
});

const commandEnvelope = (createdAt: number, expiresAt: number) => ({
  family: 'command-envelope',
  v: SHADOW_PROTOCOL_VERSION,
  commandId: 'cmd_1',
  idempotencyKey: 'idem_1',
  controllerDeviceId: 'ctrl_phone_1',
  fence,
  method: 'sendChat',
  paramsCiphertext: 'cipher_params',
  grantScopes: ['chat'],
  createdAt,
  expiresAt,
  signature: 'sig_cmd',
});

const enrollmentGrant = (signedAt: number, expiresAt: number) => ({
  family: 'enrollment-grant',
  v: SHADOW_PROTOCOL_VERSION,
  fence,
  controllerDeviceId: 'ctrl_phone_1',
  grantId: 'grant_1',
  expiresAt,
  keyId: 'key_scope_1',
  signedAt,
  signature: 'sig_enroll_grant',
});

const visualControlGrant = (signedAt: number, expiresAt: number, grantId?: string) => ({
  family: 'visual-control-grant',
  v: SHADOW_PROTOCOL_VERSION,
  ...(grantId === undefined ? {} : { grantId }),
  visualSessionId: 'vis_1',
  fence,
  controllerDeviceId: 'ctrl_phone_1',
  mode: 'control',
  expiresAt,
  signedAt,
  signature: 'sig_control',
});

const webTunnel = (expiresAt: number) => ({
  v: SHADOW_PROTOCOL_VERSION,
  tunnelId: 'tun_1',
  fence,
  projectId: 'proj_1',
  controllerDeviceId: 'ctrl_phone_1',
  allowedLoopbackPort: 5173,
  allowedOrigin: 'http://127.0.0.1:5173',
  route: '/preview',
  expiresAt,
});

describe('default realtime decode context expiry enforcement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects MAX_SAFE_INTEGER preview and asset capability expiries through exported no-context APIs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(decodeShadowMessage(preview(Number.MAX_SAFE_INTEGER)).ok).toBe(false);
    expect(decodeBlobCapability(assetCapability(Number.MAX_SAFE_INTEGER)).ok).toBe(false);
    expect(decodeShadowMessage(assetCapability(Number.MAX_SAFE_INTEGER)).ok).toBe(false);
  });

  it.each([
    ['command-envelope', commandEnvelope(now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1, now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 2)],
    ['enrollment-grant', enrollmentGrant(now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1, now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 2)],
    ['visual-control-grant', visualControlGrant(now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1, now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 2, 'vgrant_1')],
  ])('rejects %s source time beyond current skew with omitted context', (_name, message) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(decodeShadowMessage(message).ok).toBe(false);
  });

  it.each([
    ['preview-session', preview(now)],
    ['asset-capability direct', assetCapability(now)],
    ['asset-capability generic', assetCapability(now)],
    ['command-envelope', commandEnvelope(now - 1, now)],
    ['enrollment-grant', enrollmentGrant(now - 1, now)],
    ['visual-control-grant', visualControlGrant(now - 1, now, 'vgrant_1')],
  ])('rejects expired %s with omitted context', (name, message) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const decoded = name === 'asset-capability direct'
      ? decodeBlobCapability(message)
      : decodeShadowMessage(message);
    expect(decoded.ok).toBe(false);
  });

  it.each([
    ['preview-session expiry future boundary', preview(now + SHADOW_PREVIEW_SESSION_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS), preview(now + SHADOW_PREVIEW_SESSION_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1)],
    ['asset-capability expiry future boundary', assetCapability(now + SHADOW_ASSET_CAPABILITY_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS), assetCapability(now + SHADOW_ASSET_CAPABILITY_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1)],
    ['command-envelope ttl boundary', commandEnvelope(now, now + SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS), commandEnvelope(now, now + SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS + 1)],
    ['enrollment-grant ttl boundary', enrollmentGrant(now, now + SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS), enrollmentGrant(now, now + SHADOW_ENROLLMENT_GRANT_MAX_TTL_MS + 1)],
    ['visual-control-grant ttl boundary', visualControlGrant(now, now + SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS, 'vgrant_1'), visualControlGrant(now, now + SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS + 1, 'vgrant_1')],
    ['command-envelope source skew boundary', commandEnvelope(now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS, now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1), commandEnvelope(now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1, now + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 2)],
  ])('accepts exact default-time %s and rejects +1', (_name, accepted, rejected) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(decodeShadowMessage(accepted).ok).toBe(true);
    expect(decodeShadowMessage(rejected).ok).toBe(false);
  });

  it('keeps old v1 visual grants without grantId accepted at valid default-time TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const decoded = decodeShadowMessage(visualControlGrant(now, now + SHADOW_VISUAL_CONTROL_GRANT_MAX_TTL_MS));

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect('grantId' in decoded.value).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['negative', -1],
  ])('rejects invalid explicit nowMs %s without falling back', (_name, nowMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(decodeShadowMessage(preview(now + 10_000), { nowMs }).ok).toBe(false);
    expect(decodeBlobCapability(assetCapability(now + 10_000), undefined, { nowMs }).ok).toBe(false);
    expect(decodeWebTunnelSession(webTunnel(now + 10_000), { nowMs }).ok).toBe(false);
  });

  it('enforces web tunnel session TTL and expiry with default and explicit context', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(decodeWebTunnelSession(webTunnel(now + SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS)).ok).toBe(true);
    expect(decodeWebTunnelSession(webTunnel(now + SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1)).ok).toBe(false);
    expect(decodeWebTunnelSession(webTunnel(Number.MAX_SAFE_INTEGER)).ok).toBe(false);
    expect(decodeWebTunnelSession(webTunnel(now)).ok).toBe(false);
    expect(decodeWebTunnelSession(webTunnel(now + SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS), now).ok).toBe(true);
    expect(decodeWebTunnelSession(webTunnel(now + SHADOW_WEB_TUNNEL_SESSION_MAX_TTL_MS + SHADOW_MAX_FUTURE_CLOCK_SKEW_MS + 1), { nowMs: now }).ok).toBe(false);
  });
});
