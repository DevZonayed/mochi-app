import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WhatsAppCard } from './CommsGateway';
import { api } from '../lib/api';
import type { WhatsAppState } from '../lib/api';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    IS_LOCAL: true,
    api: {
      reconnectWhatsApp: vi.fn(async () => ({ ok: true })),
      disconnectWhatsApp: vi.fn(async () => ({ ok: true })),
      unlinkWhatsApp: vi.fn(async () => ({ ok: true })),
      approveWhatsappSend: vi.fn(async () => ({})),
      setWhatsappAgentSend: vi.fn(async () => ({})),
      setWhatsappRecipient: vi.fn(async () => ({})),
      whatsappLink: vi.fn(async () => ({ method: 'qr', dataUrl: 'data:image/png;base64,abc' })),
      whatsappQr: vi.fn(async () => ({ dataUrl: null })),
      whatsappStatus: vi.fn(async () => ({ connected: false })),
    },
  };
});

const linked = (patch: Partial<WhatsAppState>): WhatsAppState => ({
  status: 'offline',
  connected: false,
  jid: '15551234567@s.whatsapp.net',
  name: 'Jonayed PA',
  linkedAt: 100,
  sendApproved: true,
  pendingSummaries: [],
  agentSendToOthers: false,
  notifyJid: null,
  ...patch,
});

function renderCard(wa: WhatsAppState | null) {
  const onChanged = vi.fn();
  render(<WhatsAppCard wa={wa} tracked={4} onChanged={onChanged} />);
  return { onChanged };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WhatsAppCard truthful linked connection states', () => {
  it('shows linked offline retrying without the first-link warning or Re-link label, and reconnects explicitly', () => {
    renderCard(linked({ status: 'retrying', nextRetryAt: Date.now() + 60_000 }));

    expect(screen.getAllByText(/Offline — retrying/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Jonayed PA/)).toBeTruthy();
    expect(screen.queryByText(/personal.*number via an unofficial connection/i)).toBeNull();
    expect(screen.queryByText(/Re-link number/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Reconnect now/i }));
    expect(api.reconnectWhatsApp).toHaveBeenCalledOnce();
  });

  it('renders paused with Resume and no auto-link warning', () => {
    renderCard(linked({ status: 'paused' }));
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resume/i })).toBeTruthy();
    expect(screen.queryByText(/Re-link number/)).toBeNull();
  });

  it('renders connection replaced as needs attention with manual reconnect', () => {
    renderCard(linked({ status: 'needs-attention', lastDisconnectCode: 440 }));
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText(/connection was replaced/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Reconnect$/i })).toBeTruthy();
  });

  it('renders genuinely unlinked with Link and warning', () => {
    renderCard({ status: 'unlinked', connected: false, jid: null, name: null, linkedAt: null, sendApproved: false, pendingSummaries: [] });
    expect(screen.getByRole('button', { name: /Link your number/i })).toBeTruthy();
    expect(screen.getByText(/personal/i)).toBeTruthy();
  });

  it('keeps the Live connected state unchanged', () => {
    renderCard(linked({ status: 'connected', connected: true }));
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open WhatsApp/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pause/i })).toBeTruthy();
  });
});
