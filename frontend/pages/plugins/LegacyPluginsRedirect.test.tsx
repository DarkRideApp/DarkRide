import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { LegacyPluginsRedirect } from './LegacyPluginsRedirect';

function Probe() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="loc">{pathname + search + hash}</div>;
}

function renderAt(entry: string, tab: 'installed' | 'discover', oldPath: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path={oldPath} element={<LegacyPluginsRedirect tab={tab} />} />
        <Route path="/ui/plugins" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LegacyPluginsRedirect', () => {
  it('sends the old Marketplace URL to the Discover tab', () => {
    renderAt('/ui/marketplace', 'discover', '/ui/marketplace');
    expect(screen.getByTestId('loc').textContent).toBe('/ui/plugins?tab=discover');
  });

  it('sends the old Settings > Plugins URL to the Installed tab', () => {
    renderAt('/ui/settings/plugins', 'installed', '/ui/settings/plugins');
    expect(screen.getByTestId('loc').textContent).toBe('/ui/plugins?tab=installed');
  });

  it('carries the query string and hash across', () => {
    renderAt('/ui/marketplace?q=maps&category=theme-parks#top', 'discover', '/ui/marketplace');
    const loc = screen.getByTestId('loc').textContent!;
    expect(loc.startsWith('/ui/plugins?tab=discover')).toBe(true);
    expect(loc).toContain('q=maps');
    expect(loc).toContain('category=theme-parks');
    expect(loc.endsWith('#top')).toBe(true);
  });

  it('lets the route decide the tab over a stray ?tab= on the old URL', () => {
    renderAt('/ui/marketplace?tab=installed', 'discover', '/ui/marketplace');
    const loc = screen.getByTestId('loc').textContent!;
    expect(loc).toContain('tab=discover');
    expect(loc).not.toContain('tab=installed');
  });
});
