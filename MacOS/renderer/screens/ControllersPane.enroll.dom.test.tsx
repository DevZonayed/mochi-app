/**
 * ControllersPane.enroll.dom.test.tsx — Phase 3C2 (corrected F1) RTL/DOM proof of the
 * desktop enrollment entry. Renders the REAL ControllersPane under happy-dom with a
 * mocked `api`, and asserts: the enroll click calls the REAL `shadowHostCreateSession`
 * with exact params; the signed bootstrap URI is NEVER visible as text/aria/title; the
 * QR is rendered LOCALLY (an <svg>, no network); the verification phrase + expiry show;
 * one session in flight; cancel/regenerate/expiry/error/unmount all behave; the QR
 * library performs no network I/O.
 */
// @vitest-environment happy-dom
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  shadowHostStatus: vi.fn(),
  shadowHostListPending: vi.fn(),
  shadowHostListControllers: vi.fn(),
  shadowHostApprove: vi.fn(),
  shadowHostDeny: vi.fn(),
  shadowHostRevoke: vi.fn(),
  shadowHostCreateSession: vi.fn(),
  shadowHostCancel: vi.fn(),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<object>('../lib/api');
  return { ...actual, api: apiMock };
});

import ControllersPane from './ControllersPane';

const SIGNED_URI = 'maestro-shadow://enroll?sid=SESSION-CANARY&sec=SECRET-CANARY&hk=KEY-CANARY';

function statusWire(over: Record<string, unknown> = {}) {
  return { signedIn: true, state: 'running', hostDeviceId: 'mac-1', fingerprint: 'FP', vaultAvailable: true, registered: true, epoch: 1, activeSessions: 0, controllers: 0, ...over };
}
function sessionWire(over: Record<string, unknown> = {}) {
  return { sessionId: 'sess-CANARY-1', qr: SIGNED_URI, expiresAt: Date.now() + 300_000, hostFingerprint: 'FP', hostAuthString: 'zebra-mint-7', ...over };
}

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
  apiMock.shadowHostStatus.mockResolvedValue(statusWire());
  apiMock.shadowHostListPending.mockResolvedValue({ requests: [] });
  apiMock.shadowHostListControllers.mockResolvedValue({ controllers: [] });
  apiMock.shadowHostCancel.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

async function renderReady() {
  render(<ControllersPane />);
  const btn = await screen.findByRole('button', { name: /enroll a device/i });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  return btn as HTMLButtonElement;
}

describe('desktop enrollment entry (F1)', () => {
  test('enroll click calls shadowHostCreateSession once with {} and opens a dialog', async () => {
    apiMock.shadowHostCreateSession.mockResolvedValue(sessionWire());
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(apiMock.shadowHostCreateSession).toHaveBeenCalledTimes(1);
    expect(apiMock.shadowHostCreateSession).toHaveBeenCalledWith({});
  });

  test('renders a LOCAL QR <svg>; the signed bootstrap URI NEVER appears as text/aria/title', async () => {
    apiMock.shadowHostCreateSession.mockResolvedValue(sessionWire());
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId('qr-svg')).toBeTruthy());
    // A real <svg> was produced locally by the qrcode library.
    expect(screen.getByTestId('qr-svg').querySelector('svg')).toBeTruthy();
    // The raw signed URI / secret is nowhere in the DOM (text, attributes, aria, title).
    const html = document.body.innerHTML;
    expect(html).not.toContain('maestro-shadow://');
    expect(html).not.toContain('SECRET-CANARY');
    expect(html).not.toContain('SESSION-CANARY');
    expect(html).not.toContain('sess-CANARY-1');
    expect(document.body.textContent ?? '').not.toContain('maestro-shadow');
    // The QR container's aria-label is a generic description, not the URI.
    expect(screen.getByTestId('qr-svg').getAttribute('aria-label')).toBe('Enrollment QR code');
    // Verification phrase + expiry are shown.
    expect(screen.getByText('zebra-mint-7')).toBeTruthy();
    expect(screen.getByText(/Expires/)).toBeTruthy();
  });

  test('only ONE session in flight — a click while busy does not create a second', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    apiMock.shadowHostCreateSession.mockReturnValue(new Promise((r) => { resolveCreate = r; }));
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect((btn).disabled).toBe(true)); // busy → disabled
    fireEvent.click(btn); // no-op on a disabled button
    expect(apiMock.shadowHostCreateSession).toHaveBeenCalledTimes(1);
    resolveCreate(sessionWire());
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  test('cancel calls shadowHostCancel(sessionId) and closes the dialog', async () => {
    apiMock.shadowHostCreateSession.mockResolvedValue(sessionWire());
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiMock.shadowHostCancel).toHaveBeenCalledWith('sess-CANARY-1');
  });

  test('regenerate creates a fresh session and cancels the prior one (at most one live)', async () => {
    apiMock.shadowHostCreateSession
      .mockResolvedValueOnce(sessionWire({ sessionId: 'sess-1' }))
      .mockResolvedValueOnce(sessionWire({ sessionId: 'sess-2' }));
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /regenerate the enrollment code/i }));
    await waitFor(() => expect(apiMock.shadowHostCreateSession).toHaveBeenCalledTimes(2));
    // The previous session id is cancelled when the new one lands.
    await waitFor(() => expect(apiMock.shadowHostCancel).toHaveBeenCalledWith('sess-1'));
  });

  test('a create error shows a generic message and no raw diagnostics', async () => {
    apiMock.shadowHostCreateSession.mockRejectedValue(new Error('ECONNREFUSED /Users/x/.secret at host'));
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const msg = screen.getByRole('alert').textContent ?? '';
    expect(msg).not.toContain('ECONNREFUSED');
    expect(msg).not.toContain('/Users/');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('an already-expired session shows "Code expired" (no stale QR) and offers a new code', async () => {
    apiMock.shadowHostCreateSession.mockResolvedValue(sessionWire({ expiresAt: Date.now() - 1_000 }));
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('Code expired')).toBeTruthy();
    expect(screen.queryByTestId('qr-svg')).toBeNull(); // no live QR for an expired code
    expect(screen.getByRole('button', { name: /generate a new enrollment code/i })).toBeTruthy();
  });

  test('unmount cancels the live session so no bootstrap outlives the pane', async () => {
    apiMock.shadowHostCreateSession.mockResolvedValue(sessionWire({ sessionId: 'sess-unmount' }));
    const btn = await renderReady();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    cleanup(); // effect cleanup runs synchronously on unmount
    expect(apiMock.shadowHostCancel).toHaveBeenCalledWith('sess-unmount');
  });

  test('the QR library performs NO network I/O (pure local render)', async () => {
    const orig = globalThis.fetch;
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')));
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    try {
      apiMock.shadowHostCreateSession.mockResolvedValue(sessionWire());
      const btn = await renderReady();
      fireEvent.click(btn);
      await waitFor(() => expect(screen.getByTestId('qr-svg')).toBeTruthy());
      expect(fetchSpy).not.toHaveBeenCalled(); // qrcode rendered locally, no network
    } finally { (globalThis as { fetch: typeof fetch }).fetch = orig; }
  });
});
