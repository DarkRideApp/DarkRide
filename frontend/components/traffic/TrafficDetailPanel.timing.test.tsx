import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrafficDetailPanel } from './TrafficDetailPanel';
import type { TrafficEntry } from './TrafficEntryRow';

const makeEntry = (overrides: Partial<TrafficEntry> = {}): TrafficEntry => ({
  id: 1,
  sessionId: null,
  deviceId: null,
  requestMethod: 'GET',
  requestUrl: 'https://example.com/api',
  requestHeaders: null,
  requestBody: null,
  responseStatus: 200,
  responseHeaders: null,
  responseBody: null,
  capturedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('TrafficDetailPanel — timing waterfall', () => {
  it('renders the segmented bar + total when a breakdown is present', () => {
    render(
      <TrafficDetailPanel
        entry={makeEntry({
          durationMs: 600,
          timings: { dns: null, connect: 50, tls: 100, ttfb: 300, download: 100 },
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('timing-waterfall')).toBeInTheDocument();
    expect(screen.getByTestId('timing-waterfall-bar')).toBeInTheDocument();
    expect(screen.getByTestId('timing-waterfall-total')).toHaveTextContent('600ms');
    // Segments present for the non-null values
    expect(screen.getByTestId('timing-seg-connect')).toBeInTheDocument();
    expect(screen.getByTestId('timing-seg-tls')).toBeInTheDocument();
    expect(screen.getByTestId('timing-seg-ttfb')).toBeInTheDocument();
    expect(screen.getByTestId('timing-seg-download')).toBeInTheDocument();
    // dns was null → no segment
    expect(screen.queryByTestId('timing-seg-dns')).not.toBeInTheDocument();
  });

  it('parses a JSON-string timings value (REST list shape)', () => {
    render(
      <TrafficDetailPanel
        entry={makeEntry({
          durationMs: 250,
          timings: JSON.stringify({ dns: null, connect: 20, tls: 30, ttfb: 150, download: 50 }),
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('timing-waterfall-bar')).toBeInTheDocument();
    expect(screen.getByTestId('timing-waterfall-total')).toHaveTextContent('250ms');
  });

  it('shows only the total when there is no per-segment breakdown', () => {
    render(
      <TrafficDetailPanel
        entry={makeEntry({ durationMs: 420, timings: null })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('timing-waterfall')).toBeInTheDocument();
    expect(screen.getByTestId('timing-waterfall-total')).toHaveTextContent('420ms');
    expect(screen.getByTestId('timing-waterfall-total-only')).toBeInTheDocument();
    expect(screen.queryByTestId('timing-waterfall-bar')).not.toBeInTheDocument();
  });

  it('renders no waterfall when there is no timing at all', () => {
    render(
      <TrafficDetailPanel
        entry={makeEntry({ durationMs: null, timings: null })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('timing-waterfall')).not.toBeInTheDocument();
  });
});
