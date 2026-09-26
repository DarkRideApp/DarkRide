import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { LegacyNetworkRedirect } from './LegacyRedirect';

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/ui/network" element={<Probe />} />
        <Route path="/ui/request-builder" element={<LegacyNetworkRedirect pane="repeater" />} />
        <Route path="/ui/traffic" element={<LegacyNetworkRedirect pane="traffic" />} />
        <Route path="/ui/api-catalogue" element={<LegacyNetworkRedirect pane="catalogue" />} />
      </Routes>
    </MemoryRouter>,
  );
  return new URL(screen.getByTestId('probe').textContent!, 'http://x');
}

describe('LegacyNetworkRedirect', () => {
  it('redirects a bare legacy route into the matching pane', () => {
    const url = renderAt('/ui/api-catalogue');
    expect(url.pathname).toBe('/ui/network');
    expect([...url.searchParams]).toEqual([['pane', 'catalogue']]);
  });

  it('keeps ?replay=1 so Traffic Replay reaches the Repeater with its stashed request', () => {
    const url = renderAt('/ui/request-builder?replay=1');
    expect(url.searchParams.get('pane')).toBe('repeater');
    expect(url.searchParams.get('replay')).toBe('1');
  });

  it('keeps the ApiExplorer url/method prefill params', () => {
    const target = 'https://api.example.com/v1/x?a=1&b=2';
    const url = renderAt(`/ui/request-builder?url=${encodeURIComponent(target)}&method=POST`);
    expect(url.searchParams.get('pane')).toBe('repeater');
    expect(url.searchParams.get('url')).toBe(target);
    expect(url.searchParams.get('method')).toBe('POST');
  });

  it('keeps ?tab=saved on the old Traffic route', () => {
    const url = renderAt('/ui/traffic?tab=saved');
    expect(url.searchParams.get('pane')).toBe('traffic');
    expect(url.searchParams.get('tab')).toBe('saved');
  });

  it('the route pane wins over a stray ?pane= on the legacy URL', () => {
    const url = renderAt('/ui/traffic?pane=repeater');
    expect(url.searchParams.getAll('pane')).toEqual(['traffic']);
  });

  it('keeps the hash', () => {
    render(
      <MemoryRouter initialEntries={['/ui/traffic#row-4']}>
        <Routes>
          <Route path="/ui/network" element={<HashProbe />} />
          <Route path="/ui/traffic" element={<LegacyNetworkRedirect pane="traffic" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('hash').textContent).toBe('#row-4');
  });
});

function HashProbe() {
  return <div data-testid="hash">{useLocation().hash}</div>;
}
