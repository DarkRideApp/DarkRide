import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VideoHealthIndicator } from './VideoHealthIndicator';

describe('VideoHealthIndicator', () => {
  it('renders green for healthy + low tier', () => {
    const { container } = render(<VideoHealthIndicator state="healthy" tier={1} bitrate={4_000_000} />);
    expect(container.querySelector('.video-health-dot.healthy')).toBeTruthy();
  });
  it('renders yellow for degraded', () => {
    const { container } = render(<VideoHealthIndicator state="degraded" tier={3} bitrate={1_000_000} />);
    expect(container.querySelector('.video-health-dot.degraded')).toBeTruthy();
  });
  it('renders red for resetting', () => {
    const { container } = render(<VideoHealthIndicator state="resetting" tier={2} bitrate={2_000_000} />);
    expect(container.querySelector('.video-health-dot.resetting')).toBeTruthy();
  });
  it('shows tier and bitrate in title attribute', () => {
    const { container } = render(<VideoHealthIndicator state="healthy" tier={1} bitrate={4_000_000} />);
    const dot = container.querySelector('.video-health-dot');
    expect(dot?.getAttribute('title')).toMatch(/4000000/);
    expect(dot?.getAttribute('title')).toMatch(/tier 1/i);
  });
});
