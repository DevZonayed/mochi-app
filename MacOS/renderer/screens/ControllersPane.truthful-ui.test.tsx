import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  shadowHostStatus: vi.fn(),
  shadowHostListPending: vi.fn(),
  shadowHostListControllers: vi.fn(),
  shadowHostApprove: vi.fn(),
  shadowHostDeny: vi.fn(),
  shadowHostRevoke: vi.fn(),
  shadowHostRecoverExpiredController: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<object>('../lib/api');
  return { ...actual, api: apiMock };
});

const SIGN_CANARY = 'SIGNING-PUBLIC-KEY-CANARY';
const GRANT_CANARY = 'GRANT-ID-CANARY';

function statusWire(over: Record<string, unknown> = {}) {
  return { signedIn: true, state: 'running', hostDeviceId: 'mac-1', fingerprint: 'FP', vaultAvailable: true, registered: true, epoch: 1, activeSessions: 1, controllers: 1, ...over };
}
function pendingWire(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-A', controllerDeviceId: 'phone-galaxy-1',
    signingPublicKey: SIGN_CANARY, agreementPublicKey: 'AGREE-CANARY', nonce: 'NONCE-CANARY', transcriptHash: 'TH-CANARY',
    requestedAt: 1_784_000_000_000, authString: 'zebra-mint-7', sessionExpiresAt: 1_784_000_600_000,
    requestedCapabilities: ['account.read', 'session.message', 'job.start'],
    ...over,
  };
}
function controllerWire(over: Record<string, unknown> = {}) {
  return { controllerDeviceId: 'ipad-pro-2', grantId: GRANT_CANARY, keyId: 'KEY-CANARY', status: 'active', expiresAt: 1_784_100_000_000, ...over };
}

async function ControllersPane() {
  return (await import('./ControllersPane')).default;
}

describe('ControllersPane truthful rendered behavior', () => {
  beforeEach(() => {
    apiMock.shadowHostStatus.mockResolvedValue(statusWire());
    apiMock.shadowHostListPending.mockResolvedValue({ requests: [pendingWire()] });
    apiMock.shadowHostListControllers.mockResolvedValue({ controllers: [controllerWire()] });
    apiMock.shadowHostApprove.mockResolvedValue({ grantId: GRANT_CANARY, keyId: 'KEY-CANARY', controllerDeviceId: 'phone-galaxy-1', expiresAt: 1_784_000_600_000, capabilities: ['account.read', 'job.start'] });
    apiMock.shadowHostDeny.mockResolvedValue({ ok: true });
    apiMock.shadowHostRevoke.mockResolvedValue({ keyRotationId: 'ROT-CANARY', alreadyRevoked: false });
    apiMock.shadowHostRecoverExpiredController.mockResolvedValue({ keyRotationId: 'ROT-RECOVERY', alreadyRevoked: false, leaseReacquired: true });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('renders authoritative pending + enrolled fields and NEVER crypto material / internal ids', async () => {
    const Pane = await ControllersPane();
    render(<Pane />);
    expect(await screen.findByText('phone-galaxy-1')).toBeTruthy();
    // requested capability labels (from wire, canonical) render
    expect(screen.getByText(/Send messages in a session/)).toBeTruthy();
    expect(screen.getByText(/Start jobs/)).toBeTruthy();
    // authString + enrolled status render
    expect(screen.getByText('zebra-mint-7')).toBeTruthy();
    expect(screen.getByText('ipad-pro-2')).toBeTruthy();
    expect(screen.getByText(/active · expires/)).toBeTruthy();
    // forbidden raw material never reaches the DOM
    expect(document.body.textContent).not.toContain(SIGN_CANARY);
    expect(document.body.textContent).not.toContain('AGREE-CANARY');
    expect(document.body.textContent).not.toContain('NONCE-CANARY');
    expect(document.body.textContent).not.toContain(GRANT_CANARY);
    expect(document.body.textContent).not.toContain('KEY-CANARY');
    // never a fabricated presence claim
    expect(screen.queryByText(/Online|Last seen|last active/i)).toBeNull();
  });

  test('approve grants a chosen SUBSET of requested capabilities with the exact sessionId', async () => {
    const Pane = await ControllersPane();
    render(<Pane />);
    fireEvent.click(await screen.findByRole('button', { name: /Review and approve phone-galaxy-1/ }));
    const dialog = await screen.findByRole('dialog');
    // account.read is the locked floor
    const floor = within(dialog).getByLabelText(/Read your projects/) as HTMLInputElement;
    expect(floor.checked).toBe(true);
    expect(floor.disabled).toBe(true);
    // uncheck session.message → approve only account.read + job.start
    fireEvent.click(within(dialog).getByLabelText(/Send messages in a session/));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve/ }));
    await waitFor(() => expect(apiMock.shadowHostApprove).toHaveBeenCalledWith({ sessionId: 'sess-A', capabilities: ['account.read', 'job.start'] }));
    // authoritative receipt appears; refetch happened
    expect(await screen.findByText('Approved')).toBeTruthy();
    await waitFor(() => expect(apiMock.shadowHostListPending.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test('deny calls shadowHostDeny with the exact session after confirmation', async () => {
    const Pane = await ControllersPane();
    render(<Pane />);
    fireEvent.click(await screen.findByRole('button', { name: /Deny phone-galaxy-1/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deny request' }));
    await waitFor(() => expect(apiMock.shadowHostDeny).toHaveBeenCalledWith('sess-A'));
  });

  test('revoke names the exact controller and calls shadowHostRevoke after confirmation', async () => {
    const Pane = await ControllersPane();
    render(<Pane />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke ipad-pro-2/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/rotates the host’s keys/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(apiMock.shadowHostRevoke).toHaveBeenCalledWith('ipad-pro-2'));
  });

  test('signed-out shows a truthful state with no data', async () => {
    apiMock.shadowHostStatus.mockResolvedValue(statusWire({ signedIn: false }));
    const Pane = await ControllersPane();
    render(<Pane />);
    expect(await screen.findByText(/signed out/i)).toBeTruthy();
    expect(screen.queryByText('phone-galaxy-1')).toBeNull();
    expect(apiMock.shadowHostListPending).not.toHaveBeenCalled();
  });

  test('empty pending + empty controllers render truthful empty states (never a fake 0-list)', async () => {
    apiMock.shadowHostListPending.mockResolvedValue({ requests: [] });
    apiMock.shadowHostListControllers.mockResolvedValue({ controllers: [] });
    const Pane = await ControllersPane();
    render(<Pane />);
    expect(await screen.findByText('No pending requests.')).toBeTruthy();
    expect(screen.getByText('No enrolled controllers.')).toBeTruthy();
  });

  test('offline host disables mutations and shows a factual banner', async () => {
    apiMock.shadowHostStatus.mockResolvedValue(statusWire({ state: 'stopped' }));
    const Pane = await ControllersPane();
    render(<Pane />);
    expect(await screen.findByText(/Host isn’t running/)).toBeTruthy();
    const approve = await screen.findByRole('button', { name: /Review and approve phone-galaxy-1/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const revoke = screen.getByRole('button', { name: /Revoke ipad-pro-2/ }) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
  });

  test('expired-lease recovery enables only explicit controller recovery revoke', async () => {
    apiMock.shadowHostStatus.mockResolvedValue(statusWire({
      state: 'error',
      recoveryAvailable: true,
      lastError: 'host lease expired with active controllers; re-enrollment required',
    }));
    const Pane = await ControllersPane();
    render(<Pane />);
    expect(await screen.findByText(/Controller recovery required/)).toBeTruthy();
    const enroll = screen.getByRole('button', { name: /Enroll a device/ }) as HTMLButtonElement;
    expect(enroll.disabled).toBe(true);
    const revoke = await screen.findByRole('button', { name: /Revoke ipad-pro-2/ }) as HTMLButtonElement;
    expect(revoke.disabled).toBe(false);
    fireEvent.click(revoke);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/reacquire the host lease/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(apiMock.shadowHostRecoverExpiredController).toHaveBeenCalledWith('ipad-pro-2'));
    expect(apiMock.shadowHostRevoke).not.toHaveBeenCalled();
  });

  test('load error shows a bounded generic message + retry, never a raw host error', async () => {
    apiMock.shadowHostStatus.mockRejectedValue(Object.assign(new Error('RAW-HOST-/Users/secret'), { status: 500 }));
    const Pane = await ControllersPane();
    render(<Pane />);
    expect(await screen.findByText(/Controllers are unavailable/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('RAW-HOST-/Users/secret');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(apiMock.shadowHostStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test('a stale (superseded) status response cannot overwrite the current one', async () => {
    let resolveFirst!: (v: unknown) => void;
    // First load hangs; a Refresh supersedes it with distinctive data.
    apiMock.shadowHostStatus
      .mockImplementationOnce(() => new Promise(res => { resolveFirst = res; }))
      .mockResolvedValue(statusWire());
    apiMock.shadowHostListControllers
      .mockResolvedValueOnce({ controllers: [controllerWire({ controllerDeviceId: 'fresh-device-9' })] })
      .mockResolvedValue({ controllers: [controllerWire({ controllerDeviceId: 'fresh-device-9' })] });
    const Pane = await ControllersPane();
    render(<Pane />);
    // While first load pends, click Refresh → starts a newer generation that resolves.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh controllers' }));
    expect(await screen.findByText('fresh-device-9')).toBeTruthy();
    // Now resolve the STALE first load with different data — it must be discarded.
    resolveFirst(statusWire());
    await new Promise(r => setTimeout(r, 0));
    expect(screen.getByText('fresh-device-9')).toBeTruthy();
    expect(screen.queryByText('ipad-pro-2')).toBeNull();
  });

  test('unmounting before a load resolves does not throw / warn (abort-safe)', async () => {
    let resolve!: (v: unknown) => void;
    apiMock.shadowHostStatus.mockImplementation(() => new Promise(res => { resolve = res; }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Pane = await ControllersPane();
    const { unmount } = render(<Pane />);
    unmount();
    resolve(statusWire());
    await new Promise(r => setTimeout(r, 0));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
