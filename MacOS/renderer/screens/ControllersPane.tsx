/* ControllersPane — Phase 3C1 desktop host controller management, embedded in the
   Settings IA (Settings → Controllers). Real authority over the live `shadowHost*`
   dispatch: list pending enrollment requests, approve an explicit SUBSET of the
   capabilities each controller requested, deny a request, list enrolled controllers,
   and revoke one.

   Every rendered fact comes from an authoritative wire field via the strict
   view-model in `../lib/shadowController` (which strips all crypto material +
   internal ids). No optimistic state: the UI advances only after an authoritative
   RPC result, then refetches. Device presence is never shown — the host controller
   list carries no such field. Uses the shared Settings visual language
   (GroupedList / Row / Icon / house tokens). */

import React from 'react';
import { api } from '../lib/api';
import { GroupedList, Row } from '../lib/ui';
import { Icon } from '../lib/icons';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import {
  statusView, mapPendingRequest, mapController, mapApproveReceipt,
  approvalCapabilities, capabilityLabel, isFloorCapability, genericMutationError, genericLoadError,
  type ControllerStatusView, type PendingRequestView, type ControllerView, type ApproveReceiptView,
  type EnrollmentSessionView,
} from '../lib/shadowController';
import { useEnrollmentSession, LocalQr } from '../lib/enrollmentSession';
import { ScreenShareCard } from '../lib/ScreenShareCard';
import { ScreenSourceCard } from '../lib/ScreenSourceCard';

type Phase = 'loading' | 'signed-out' | 'error' | 'ready';

interface ControllersState {
  phase: Phase;
  status: ControllerStatusView | null;
  pending: PendingRequestView[];
  controllers: ControllerView[];
  loadError: string | null;
}

/** Generation-safe, abort-safe controller view-model hook. A load applies its result
    only when its generation is still current AND the component is mounted; a stale
    account/host response (superseded by a newer load) is discarded. Exactly one
    in-flight mutation per exact target (sessionId / controllerDeviceId). */
function useControllers() {
  const [state, setState] = React.useState<ControllersState>({
    phase: 'loading', status: null, pending: [], controllers: [], loadError: null,
  });
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const genRef = React.useRef(0);
  const mounted = React.useRef(true);

  const load = React.useCallback(async () => {
    const gen = ++genRef.current;
    const apply = (next: Partial<ControllersState>) => {
      if (!mounted.current || gen !== genRef.current) return; // abort / stale guard
      setState(prev => ({ ...prev, ...next }));
    };
    try {
      const rawStatus = await api.shadowHostStatus();
      if (!mounted.current || gen !== genRef.current) return;
      if (!rawStatus.signedIn) {
        apply({ phase: 'signed-out', status: statusView(rawStatus), pending: [], controllers: [], loadError: null });
        return;
      }
      // When signed in, list pending + controllers (dispatch starts the runtime). If the
      // host is stopped/offline we still render the enrolled list read-only with a factual
      // banner; a fetch failure there degrades to an empty section, never a fabricated one.
      const [pendingRes, controllersRes] = await Promise.all([
        api.shadowHostListPending().catch(() => ({ requests: [] as never[] })),
        api.shadowHostListControllers().catch(() => ({ controllers: [] as never[] })),
      ]);
      apply({
        phase: 'ready',
        status: statusView(rawStatus),
        pending: (pendingRes.requests ?? []).map(mapPendingRequest),
        controllers: (controllersRes.controllers ?? []).map(mapController),
        loadError: null,
      });
    } catch {
      apply({ phase: 'error', loadError: genericLoadError() });
    }
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const runMutation = React.useCallback(async <T,>(target: string, op: () => Promise<T>): Promise<T | { error: string }> => {
    if (busy[target]) return { error: '' }; // one in-flight per exact target
    setBusy(b => ({ ...b, [target]: true }));
    try {
      const result = await op();
      // Refetch authoritative state; a mutation whose account/host generation was
      // superseded mid-flight must not resurrect stale rows — load() re-guards on gen.
      await load();
      return result;
    } catch (e) {
      return { error: genericMutationError(e) };
    } finally {
      if (mounted.current) setBusy(b => { const n = { ...b }; delete n[target]; return n; });
    }
  }, [busy, load]);

  return { state, busy, reload: load, runMutation };
}

// ── formatting / decorative helpers (never authoritative) ─────────────────────
function fmtTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}
function shortDevice(id: string): string {
  return id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id;
}
/** Decorative tint derived from the device id (color only — not a security signal). */
function deviceTint(id: string): string {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const tints = ['var(--blue)', 'var(--purple)', 'var(--teal)', 'var(--indigo)', 'var(--orange)'];
  return tints[h % tints.length];
}
function devBadge(tint: string, name: 'smartphone' | 'shield' | 'cpu' = 'smartphone') {
  return (
    <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}>
      <Icon name={name} size={17} />
    </span>
  );
}

const primaryBtn: React.CSSProperties = { minHeight: 44, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' };
const ghostBtn: React.CSSProperties = { minHeight: 44, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' };
const dangerBtn: React.CSSProperties = { minHeight: 44, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--red)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' };

function statusChipColor(status: string): string {
  if (status === 'active') return 'var(--green)';
  if (status === 'revoked') return 'var(--red)';
  if (status === 'expired') return 'var(--ink-tertiary)';
  return 'var(--ink-secondary)';
}

// ── Approve dialog: pick a SUBSET of the request's requested capabilities ──────
function ApproveDialog({ request, busy, onCancel, onApprove }: {
  request: PendingRequestView;
  busy: boolean;
  onCancel: () => void;
  onApprove: (caps: ShadowCapability[]) => void;
}) {
  // Default selection = everything the controller requested (operator narrows).
  const [selected, setSelected] = React.useState<Set<ShadowCapability>>(() => new Set(request.requestedCapabilities));
  const toggle = (cap: ShadowCapability) => {
    if (isFloorCapability(cap)) return; // read floor is locked-on
    setSelected(prev => { const n = new Set(prev); if (n.has(cap)) n.delete(cap); else n.add(cap); return n; });
  };
  const payload = approvalCapabilities(request.requestedCapabilities, selected);
  const titleId = 'approve-dialog-title';
  return (
    <div role="presentation" onMouseDown={busy ? undefined : onCancel} style={overlay}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={e => e.stopPropagation()} style={sheet}>
        <h2 id={titleId} style={sheetTitle}>Approve controller</h2>
        <p style={sheetSub}>
          Grant <b style={{ color: 'var(--ink)' }}>{shortDevice(request.controllerDeviceId)}</b> the permissions you select below.
          Verify the phrase <b style={{ color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>{request.authString}</b> matches the one on the device.
        </p>
        <div role="group" aria-label="Permissions to grant" style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '4px 0 16px' }}>
          {request.requestedCapabilities.length === 0 && (
            <span style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', padding: '8px 2px' }}>This device requested no permissions beyond the read floor.</span>
          )}
          {request.requestedCapabilities.map(cap => {
            const floor = isFloorCapability(cap);
            const checked = floor || selected.has(cap);
            const cid = `cap-${cap}`;
            return (
              <label key={cap} htmlFor={cid} style={{ display: 'flex', alignItems: 'center', gap: 11, minHeight: 44, padding: '0 4px', cursor: floor ? 'default' : 'pointer' }}>
                <input id={cid} type="checkbox" checked={checked} disabled={floor || busy} onChange={() => toggle(cap)}
                  style={{ width: 18, height: 18, accentColor: 'var(--blue)', flexShrink: 0 }} />
                <span style={{ flex: 1, font: '400 var(--fs-body)/1.2 var(--font-text)', color: 'var(--ink)' }}>{capabilityLabel(cap)}</span>
                {floor && <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Always included</span>}
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={busy} style={{ ...ghostBtn, flex: 1 }}>Cancel</button>
          <button onClick={() => onApprove(payload)} disabled={busy} aria-label={`Approve ${shortDevice(request.controllerDeviceId)} with ${payload.length} permission${payload.length === 1 ? '' : 's'}`}
            style={{ ...primaryBtn, flex: 1, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Approving…' : `Approve · ${payload.length} permission${payload.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Generic destructive confirm (deny request / revoke controller) ─────────────
function ConfirmDialog({ title, body, confirmLabel, busy, onCancel, onConfirm }: {
  title: string; body: React.ReactNode; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const titleId = 'confirm-dialog-title';
  return (
    <div role="presentation" onMouseDown={busy ? undefined : onCancel} style={overlay}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={e => e.stopPropagation()} style={{ ...sheet, textAlign: 'center' }}>
        <span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', marginBottom: 14 }}><Icon name="alert" size={26} /></span>
        <h2 id={titleId} style={{ ...sheetTitle, textAlign: 'center' }}>{title}</h2>
        <p style={{ ...sheetSub, textAlign: 'center' }}>{body}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={busy} style={{ ...ghostBtn, flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...dangerBtn, flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.4)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' };
const sheet: React.CSSProperties = { width: 440, maxWidth: '100%', background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24 };
const sheetTitle: React.CSSProperties = { margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' };
const sheetSub: React.CSSProperties = { margin: '0 0 16px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' };

// ── Enrollment code (F1): sheet with the local QR (hook + QR live in lib) ──────

function EnrollDialog({ session, busy, expired, onRegenerate, onCancel }: {
  session: EnrollmentSessionView; busy: boolean; expired: boolean; onRegenerate: () => void; onCancel: () => void;
}) {
  const titleId = 'enroll-dialog-title';
  return (
    <div role="presentation" onMouseDown={busy ? undefined : onCancel} style={overlay}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={e => e.stopPropagation()} style={{ ...sheet, textAlign: 'center' }}>
        <h2 id={titleId} style={{ ...sheetTitle, textAlign: 'center' }}>Enroll a device</h2>
        <p style={{ ...sheetSub, textAlign: 'center' }}>On your phone, open <b style={{ color: 'var(--ink)' }}>Maestro → Secure controller</b> and scan this code.</p>
        <div style={{ display: 'grid', placeItems: 'center', margin: '4px 0 14px' }}>
          {expired ? (
            <div role="img" aria-label="Enrollment code expired" style={{ width: 232, height: 232, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', borderRadius: 14 }}>
              <span style={{ color: 'var(--ink-secondary)', font: '400 var(--fs-footnote)/1.3 var(--font-text)' }}>Code expired</span>
            </div>
          ) : <LocalQr data={session.qr} />}
        </div>
        <p style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', margin: '0 0 6px' }}>
          Verify the phrase on the phone matches{' '}
          <b style={{ color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>{session.verificationPhrase}</b>
        </p>
        <p style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', margin: '0 0 16px' }}>
          {expired ? 'This code has expired — generate a new one.' : `Expires ${fmtTime(session.expiresAt)}`}
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={busy} style={{ ...ghostBtn, flex: 1 }}>{busy ? 'Working…' : 'Cancel'}</button>
          <button onClick={onRegenerate} disabled={busy} aria-label={expired ? 'Generate a new enrollment code' : 'Regenerate the enrollment code'}
            style={{ ...primaryBtn, flex: 1, opacity: busy ? 0.6 : 1 }}>{expired ? 'New code' : 'Regenerate'}</button>
        </div>
      </div>
    </div>
  );
}

// ── the pane ───────────────────────────────────────────────────────────────
export default function ControllersPane() {
  const { state, busy, reload, runMutation } = useControllers();
  const { phase, status, pending, controllers } = state;
  const [approving, setApproving] = React.useState<PendingRequestView | null>(null);
  const [denying, setDenying] = React.useState<PendingRequestView | null>(null);
  const [revoking, setRevoking] = React.useState<ControllerView | null>(null);
  const [receipt, setReceipt] = React.useState<ApproveReceiptView | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const online = status?.online ?? false;
  const recoveryAvailable = status?.recoveryAvailable === true;
  const enroll = useEnrollmentSession(setActionError);

  const doApprove = async (req: PendingRequestView, caps: ShadowCapability[]) => {
    setActionError(null);
    const res = await runMutation(req.sessionId, () => api.shadowHostApprove({ sessionId: req.sessionId, capabilities: caps }));
    if ('error' in res) { if (res.error) setActionError(res.error); return; }
    setApproving(null);
    setReceipt(mapApproveReceipt(res));
  };
  const doDeny = async (req: PendingRequestView) => {
    setActionError(null);
    const res = await runMutation(req.sessionId, () => api.shadowHostDeny(req.sessionId));
    if ('error' in res && res.error) { setActionError(res.error); return; }
    setDenying(null);
  };
  const doRevoke = async (ctrl: ControllerView) => {
    setActionError(null);
    const res = await runMutation(ctrl.controllerDeviceId, () => (
      recoveryAvailable ? api.shadowHostRecoverExpiredController(ctrl.controllerDeviceId) : api.shadowHostRevoke(ctrl.controllerDeviceId)
    ));
    if ('error' in res && res.error) { setActionError(res.error); return; }
    setRevoking(null);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Controllers</h2>
          <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Approve which devices may control this Mac, and revoke access at any time.</p>
        </div>
        <button
          onClick={() => void enroll.create()}
          disabled={!online || recoveryAvailable || enroll.busy}
          aria-label="Enroll a device — show the enrollment code"
          style={{ ...primaryBtn, minHeight: 36, opacity: (!online || recoveryAvailable || enroll.busy) ? 0.5 : 1 }}
        >{enroll.busy && !enroll.session ? 'Generating…' : 'Enroll a device'}</button>
        <button onClick={() => void reload()} aria-label="Refresh controllers" className="ghost-btn" style={{ ...ghostBtn, minHeight: 36 }}>Refresh</button>
      </div>
      <div style={{ height: 18 }} />

      {phase === 'loading' && (
        <GroupedList>
          <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Loading…</span></Row>
        </GroupedList>
      )}

      {phase === 'signed-out' && (
        <GroupedList footer="Controllers are managed per account. Sign in on this Mac to approve devices.">
          <Row last>
            {devBadge('var(--ink-tertiary)', 'shield')}
            <span style={{ flex: 1, font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>You’re signed out. Sign in to manage controllers.</span>
          </Row>
        </GroupedList>
      )}

      {phase === 'error' && (
        <GroupedList>
          <Row last>
            {devBadge('var(--orange)', 'shield')}
            <span style={{ flex: 1, font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{state.loadError ?? genericLoadError()}</span>
            <button onClick={() => void reload()} className="ghost-btn" style={{ ...ghostBtn, minHeight: 36 }}>Try again</button>
          </Row>
        </GroupedList>
      )}

      {phase === 'ready' && status && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <ScreenShareCard />
          <ScreenSourceCard />
          {!online && (
            <GroupedList>
              <Row last>
                {devBadge('var(--orange)', 'cpu')}
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>
                    {recoveryAvailable ? 'Controller recovery required' : 'Host isn’t running'}
                  </span>
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
                    {recoveryAvailable
                      ? 'Revoke the failed active controller from this Mac to reacquire the host lease. New enrollment is paused until recovery completes.'
                      : 'Approvals and revocation are paused until the host is online.'}
                  </span>
                </span>
              </Row>
            </GroupedList>
          )}

          {actionError && (
            <GroupedList>
              <Row last>
                <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red)' }} role="alert">{actionError}</span>
              </Row>
            </GroupedList>
          )}

          {receipt && (
            <GroupedList header="Approved">
              <Row last>
                {devBadge('var(--green)', 'shield')}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{shortDevice(receipt.controllerDeviceId)}</span>
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
                    {receipt.capabilities.map(capabilityLabel).join(' · ') || 'Read access'} · expires {fmtTime(receipt.expiresAt)}
                  </span>
                </span>
                <button onClick={() => setReceipt(null)} aria-label="Dismiss receipt" className="ghost-btn" style={{ ...ghostBtn, minHeight: 36 }}>Done</button>
              </Row>
            </GroupedList>
          )}

          {/* Pending requests */}
          <GroupedList header="Pending requests" footer="Requests come from a device that scanned this Mac. Verify the phrase before approving.">
            {pending.length === 0 ? (
              <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>No pending requests.</span></Row>
            ) : pending.map((req, i) => (
              <Row key={req.sessionId} last={i === pending.length - 1}>
                {devBadge(deviceTint(req.controllerDeviceId), 'smartphone')}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortDevice(req.controllerDeviceId)}</span>
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
                    Wants: {req.requestedCapabilities.map(capabilityLabel).join(', ') || 'read access'}
                  </span>
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>
                    Requested {fmtTime(req.requestedAt)} · expires {fmtTime(req.sessionExpiresAt)} · phrase <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-secondary)' }}>{req.authString}</span>
                  </span>
                </span>
                <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => { setActionError(null); setDenying(req); }} disabled={!online || !!busy[req.sessionId]} aria-label={`Deny ${shortDevice(req.controllerDeviceId)}`} className="ghost-btn" style={{ ...ghostBtn, opacity: (!online || busy[req.sessionId]) ? 0.5 : 1 }}>Deny</button>
                  <button onClick={() => { setActionError(null); setApproving(req); }} disabled={!online || !!busy[req.sessionId]} aria-label={`Review and approve ${shortDevice(req.controllerDeviceId)}`} style={{ ...primaryBtn, opacity: (!online || busy[req.sessionId]) ? 0.5 : 1 }}>Approve…</button>
                </span>
              </Row>
            ))}
          </GroupedList>

          {/* Enrolled controllers */}
          <GroupedList header="Enrolled controllers" footer="Revoking immediately ends a device’s access and rotates the host’s keys.">
            {controllers.length === 0 ? (
              <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>No enrolled controllers.</span></Row>
            ) : controllers.map((ctrl, i) => {
              const revocable = ctrl.status === 'active' && (online || recoveryAvailable);
              return (
                <Row key={ctrl.controllerDeviceId} last={i === controllers.length - 1}>
                  {devBadge(deviceTint(ctrl.controllerDeviceId), 'smartphone')}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: statusChipColor(ctrl.status), flexShrink: 0 }} aria-hidden="true" />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortDevice(ctrl.controllerDeviceId)}</span>
                    </span>
                    <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
                      {ctrl.status} · expires {fmtTime(ctrl.expiresAt)}
                    </span>
                  </span>
                  {ctrl.status === 'active' && (
                    <button onClick={() => { setActionError(null); setRevoking(ctrl); }} disabled={!revocable || !!busy[ctrl.controllerDeviceId]} aria-label={`Revoke ${shortDevice(ctrl.controllerDeviceId)}`} className="ghost-btn"
                      style={{ ...ghostBtn, color: 'var(--red)', opacity: (!revocable || busy[ctrl.controllerDeviceId]) ? 0.5 : 1 }}>Revoke</button>
                  )}
                </Row>
              );
            })}
          </GroupedList>
        </div>
      )}

      {enroll.session && (
        <EnrollDialog
          session={enroll.session}
          busy={enroll.busy}
          expired={enroll.expired}
          onRegenerate={() => void enroll.regenerate()}
          onCancel={() => void enroll.cancel()}
        />
      )}
      {approving && (
        <ApproveDialog request={approving} busy={!!busy[approving.sessionId]}
          onCancel={() => setApproving(null)}
          onApprove={caps => void doApprove(approving, caps)} />
      )}
      {denying && (
        <ConfirmDialog title="Deny this request?" confirmLabel="Deny request" busy={!!busy[denying.sessionId]}
          body={<>The device <b style={{ color: 'var(--ink)' }}>{shortDevice(denying.controllerDeviceId)}</b> won’t be enrolled. It can request access again.</>}
          onCancel={() => setDenying(null)} onConfirm={() => void doDeny(denying)} />
      )}
      {revoking && (
        <ConfirmDialog title="Revoke this controller?" confirmLabel="Revoke access" busy={!!busy[revoking.controllerDeviceId]}
          body={recoveryAvailable
            ? <>This uses the local host identity to revoke <b style={{ color: 'var(--ink)' }}>{shortDevice(revoking.controllerDeviceId)}</b>, rotate the host keys, and reacquire the host lease. The controller data plane stays stopped during recovery.</>
            : <>This immediately removes all access for <b style={{ color: 'var(--ink)' }}>{shortDevice(revoking.controllerDeviceId)}</b> and rotates the host’s keys. The device must enroll again to reconnect.</>}
          onCancel={() => setRevoking(null)} onConfirm={() => void doRevoke(revoking)} />
      )}
    </div>
  );
}
