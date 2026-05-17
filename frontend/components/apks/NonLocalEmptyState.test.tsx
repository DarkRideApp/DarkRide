import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NonLocalEmptyState } from './NonLocalEmptyState';

describe('NonLocalEmptyState', () => {
  it('cloud: shows "Restore from cloud" button enabled', () => {
    render(<NonLocalEmptyState state="cloud" source="playstore" onRestore={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toMatch(/Restore from cloud/i);
    expect(btn).not.toBeDisabled();
  });

  it('needs-reanalyze: shows "Re-analyze APK" button enabled', () => {
    render(<NonLocalEmptyState state="needs-reanalyze" source="playstore" onRestore={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toMatch(/Re-analyze APK/i);
    expect(btn).not.toBeDisabled();
  });

  it('lost + device + device connected: enables Reconnect button', () => {
    render(<NonLocalEmptyState state="lost" source="device" onRestore={vi.fn()} deviceConnected={true} deviceName="Pixel 6" />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toMatch(/Reconnect.*Pixel 6/i);
    expect(btn).not.toBeDisabled();
  });

  it('lost + device + device offline: disables button with tooltip', () => {
    render(<NonLocalEmptyState state="lost" source="device" onRestore={vi.fn()} deviceConnected={false} deviceName="Pixel 6" />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/not connected/i);
  });

  it('lost + playstore: disables button with "not supported" tooltip', () => {
    render(<NonLocalEmptyState state="lost" source="playstore" onRestore={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/not supported/i);
  });

  it('lost + upload: disables button with "upload manually" tooltip', () => {
    render(<NonLocalEmptyState state="lost" source="upload" onRestore={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/upload.*manually/i);
  });

  it('calls onRestore when enabled button is clicked', () => {
    const onRestore = vi.fn();
    render(<NonLocalEmptyState state="cloud" source="upload" onRestore={onRestore} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRestore).toHaveBeenCalled();
  });
});
