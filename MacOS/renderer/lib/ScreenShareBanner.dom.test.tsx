// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ScreenShareBanner, type ScreenShareViewerStatus } from './ScreenShareBanner';

const active: ScreenShareViewerStatus = {
  active: true, deviceLabel: 'iPhone (Jon)', sourceLabel: 'Built-in Retina Display · 1512×982', startedAtMs: 1000,
};

afterEach(() => cleanup());

describe('ScreenShareBanner', () => {
  it('renders nothing when there is no active viewer', () => {
    const { container } = render(<ScreenShareBanner status={null} onStop={() => {}} />);
    expect(container.firstChild).toBeNull();
    cleanup();
    const inactive = render(<ScreenShareBanner status={{ ...active, active: false }} onStop={() => {}} />);
    expect(inactive.container.firstChild).toBeNull();
  });

  it('names the exact viewing device + source and exposes a Stop control', () => {
    render(<ScreenShareBanner status={active} onStop={() => {}} now={61_000} />);
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('aria-label')).toContain('iPhone (Jon)');
    expect(banner.textContent).toContain('Built-in Retina Display · 1512×982');
    expect(banner.textContent).toContain('view only');
    expect(banner.textContent).toContain('1:00'); // elapsed 60s
    expect(screen.getByRole('button', { name: /stop sharing/i })).toBeTruthy();
  });

  it('invokes onStop when Stop is clicked (local, immediate)', () => {
    const onStop = vi.fn();
    render(<ScreenShareBanner status={active} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop sharing/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
