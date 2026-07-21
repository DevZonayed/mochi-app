/**
 * enrollmentSession — Phase 3C2 (F1) enrollment-session controller + local QR renderer.
 * Extracted from ControllersPane so the pane stays a pure presentation module (the
 * source-truthfulness scan forbids timers/`Date.now` there). The ONLY timer here is a
 * truthful countdown to the host-AUTHORITATIVE `expiresAt` (not fabricated activity).
 */
import React from 'react';
import QRCode from 'qrcode';
import { api } from './api';
import { mapEnrollmentSession, genericMutationError, type EnrollmentSessionView } from './shadowController';

/** True once the enrollment session's TTL has elapsed (host-authoritative expiry). */
export function enrollmentSessionExpired(session: { expiresAt: number } | null, nowMs: number): boolean {
  return !!session && Number.isFinite(session.expiresAt) && nowMs >= session.expiresAt;
}

/** Render `data` as an SVG QR ENTIRELY in-process (`qrcode` is pure JS — no network).
    The raw bootstrap URI is NEVER placed in text / aria / title / DOM content — only its
    encoded QR paths. `aria-label` is a generic description, not the URI. */
export function LocalQr({ data, size = 232 }: { data: string; size?: number }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    setSvg(null); setFailed(false);
    QRCode.toString(data, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M' })
      .then((s) => { if (alive) setSvg(s); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [data, size]);
  const box: React.CSSProperties = { width: size, height: size, display: 'grid', placeItems: 'center', background: '#fff', borderRadius: 14, padding: 10 };
  if (failed) return <div role="img" aria-label="Enrollment code unavailable" style={box}><span style={{ color: '#8a2020', font: '400 var(--fs-footnote)/1.3 var(--font-text)' }}>Code unavailable</span></div>;
  if (!svg) return <div aria-hidden="true" data-testid="qr-loading" style={box} />;
  return <div role="img" aria-label="Enrollment QR code" data-testid="qr-svg" style={box} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * One UI-owned enrollment session at a time. `create`/`regenerate` call the REAL
 * `shadowHostCreateSession` once (busy-guarded), cancel any prior session so at most one
 * is live, and a generation ref discards a stale response (a superseded create cannot
 * replace a newer one). `cancel` drops the local session immediately (QR disappears) and
 * calls the REAL `shadowHostCancel`. Unmount cancels any live session. Errors are generic.
 */
export function useEnrollmentSession(onError: (msg: string | null) => void) {
  const [session, setSession] = React.useState<EnrollmentSessionView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const genRef = React.useRef(0);
  const mounted = React.useRef(true);
  const sessionRef = React.useRef<EnrollmentSessionView | null>(null);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (sessionRef.current) void api.shadowHostCancel(sessionRef.current.sessionId).catch(() => { /* generic */ });
    };
  }, []);
  const apply = React.useCallback((s: EnrollmentSessionView | null) => { sessionRef.current = s; setSession(s); }, []);

  React.useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session]);
  const expired = enrollmentSessionExpired(session, nowMs);

  const create = React.useCallback(async () => {
    if (busy) return;
    const gen = ++genRef.current;
    const prev = sessionRef.current;
    setBusy(true); onError(null);
    try {
      const wire = await api.shadowHostCreateSession({});
      const next = mapEnrollmentSession(wire);
      if (!mounted.current || gen !== genRef.current) { await api.shadowHostCancel(next.sessionId).catch(() => {}); return; }
      if (prev) await api.shadowHostCancel(prev.sessionId).catch(() => {}); // at most one live
      if (!mounted.current || gen !== genRef.current) { await api.shadowHostCancel(next.sessionId).catch(() => {}); return; }
      apply(next);
      setNowMs(Date.now());
    } catch (e) {
      if (mounted.current && gen === genRef.current) onError(genericMutationError(e));
    } finally {
      if (mounted.current && gen === genRef.current) setBusy(false);
    }
  }, [busy, onError, apply]);

  const cancel = React.useCallback(async () => {
    const gen = ++genRef.current;
    const sess = sessionRef.current;
    apply(null); // truthful: end it locally at once so no stale QR lingers
    if (!sess) return;
    setBusy(true); onError(null);
    try { await api.shadowHostCancel(sess.sessionId); }
    catch { /* generic — local session already cleared */ }
    finally { if (mounted.current && gen === genRef.current) setBusy(false); }
  }, [onError, apply]);

  return { session, busy, expired, create, regenerate: create, cancel };
}
