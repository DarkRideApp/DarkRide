import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusStrip } from '../StatusStrip';

describe('StatusStrip', () => {
  it('renders label, detail and progress bar width', () => {
    render(<StatusStrip label="AI Review running" detail="context 42% · 1.2M in / 5.3K out" progress={42} />);
    expect(screen.getByText('AI Review running')).toBeInTheDocument();
    expect(screen.getByText('context 42% · 1.2M in / 5.3K out')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  });

  it('omits progress bar when progress is null/undefined', () => {
    render(<StatusStrip label="Queued" />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders cancel button when onCancel provided', () => {
    const onCancel = vi.fn();
    render(<StatusStrip label="Decompiling" onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('applies variant class', () => {
    render(<StatusStrip label="Failed" variant="error" data-testid="strip" />);
    expect(screen.getByTestId('strip')).toHaveClass('status-strip-error');
  });

  it('defaults to the info variant', () => {
    render(<StatusStrip label="Working" data-testid="strip" />);
    expect(screen.getByTestId('strip')).toHaveClass('status-strip-info');
  });

  it('shows the bar at 0% when progress is 0', () => {
    render(<StatusStrip label="Starting" progress={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(bar.querySelector('.status-strip-bar-fill')).toHaveStyle({ width: '0%' });
  });

  it('clamps out-of-range progress for both aria and fill width', () => {
    render(<StatusStrip label="Over" progress={150} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(bar.querySelector('.status-strip-bar-fill')).toHaveStyle({ width: '100%' });
    expect(bar).toHaveAttribute('aria-label', 'Over');
  });
});
