import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AvailabilityBadge } from './AvailabilityBadge';

describe('AvailabilityBadge', () => {
  it('renders "Local" for local state', () => {
    render(<AvailabilityBadge state="local" />);
    expect(screen.getByText('Local')).toBeTruthy();
  });

  it('renders "Cloud" for cloud state', () => {
    render(<AvailabilityBadge state="cloud" />);
    expect(screen.getByText('Cloud')).toBeTruthy();
  });

  it('renders "Needs re-analyze" for needs-reanalyze state', () => {
    render(<AvailabilityBadge state="needs-reanalyze" />);
    expect(screen.getByText('Needs re-analyze')).toBeTruthy();
  });

  it('renders "Lost" for lost state', () => {
    render(<AvailabilityBadge state="lost" />);
    expect(screen.getByText('Lost')).toBeTruthy();
  });

  it('supports a loading prop that shows "Restoring…"', () => {
    render(<AvailabilityBadge state="cloud" loading />);
    expect(screen.getByText(/Restoring…/)).toBeTruthy();
  });

  it('accepts a title/tooltip prop', () => {
    const { container } = render(<AvailabilityBadge state="cloud" title="tooltip text" />);
    expect(container.querySelector('[title="tooltip text"]')).toBeTruthy();
  });
});
