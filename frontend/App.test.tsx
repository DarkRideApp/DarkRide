// frontend/App.test.tsx
//
// Tests that plugin page routes respond reactively to setDisabledPlugins.
// Regression guard for: disabled plugin's /ui/<path> still rendered by router
// even after being disabled (because getPages() was called outside a
// usePluginRegistrySnapshot hook, so React never re-ran it on registry change).

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { usePluginPages } from './App';

// Reset only the pages / disabledPlugins state between tests so the singleton
// doesn't leak across test cases.
function resetRegistry() {
  (pluginRegistry as any).pages = [];
  (pluginRegistry as any).disabledPlugins = new Set();
  (pluginRegistry as any).disabledLoaded = false;
  (pluginRegistry as any).version = 0;
  (pluginRegistry as any).subscribers = new Set();
}

/**
 * A test harness component that uses usePluginPages (the same hook used by
 * AuthenticatedApp) to build routes reactively. This mirrors the real app
 * behaviour: when setDisabledPlugins is called, usePluginPages triggers a
 * re-render and React Router rebuilds its route config from the new list.
 */
function TestRouter() {
  const pages = usePluginPages();
  return (
    <Routes>
      {pages.map((page) => (
        <Route
          key={page.path}
          path={page.path.replace(/^\//, '')}
          element={<React.Suspense fallback={<div />}><page.component /></React.Suspense>}
        />
      ))}
      <Route path="*" element={<div>Not Found</div>} />
    </Routes>
  );
}

describe('usePluginPages — reactive disabled-plugin route filtering', () => {
  beforeEach(resetRegistry);
  afterEach(resetRegistry);

  it('renders a registered plugin page when the plugin is enabled', () => {
    const KitchenSink = () => <div>Kitchen Sink UI</div>;
    pluginRegistry.registerPages('kitchen-sink', [
      { path: 'kitchen-sink', component: KitchenSink },
    ]);
    // Mirror the real flow: AuthenticatedApp's useEffect calls
    // setDisabledPlugins after the first server response, which flips the
    // disabledLoaded gate. Without this, usePluginPages returns [] and the
    // route falls through to the catch-all.
    pluginRegistry.setDisabledPlugins([]);

    render(
      <MemoryRouter initialEntries={['/kitchen-sink']}>
        <TestRouter />
      </MemoryRouter>,
    );

    expect(screen.getByText('Kitchen Sink UI')).toBeInTheDocument();
    expect(screen.queryByText('Not Found')).not.toBeInTheDocument();
  });

  it('removes a plugin page route when the plugin is disabled (reactive)', () => {
    const KitchenSink = () => <div>Kitchen Sink UI</div>;
    pluginRegistry.registerPages('kitchen-sink', [
      { path: 'kitchen-sink', component: KitchenSink },
    ]);
    pluginRegistry.setDisabledPlugins([]); // mark loaded so pages render

    render(
      <MemoryRouter initialEntries={['/kitchen-sink']}>
        <TestRouter />
      </MemoryRouter>,
    );

    // Initially the page is visible
    expect(screen.getByText('Kitchen Sink UI')).toBeInTheDocument();

    // Disable the plugin — no parent re-render, no navigation.
    // usePluginPages subscribes the component to the registry so it re-renders
    // automatically and React Router removes the route.
    act(() => {
      pluginRegistry.setDisabledPlugins(['kitchen-sink']);
    });

    // The page must no longer render — falls through to the catch-all
    expect(screen.queryByText('Kitchen Sink UI')).not.toBeInTheDocument();
    expect(screen.getByText('Not Found')).toBeInTheDocument();
  });

  it('hides plugin page routes until setDisabledPlugins is called (initial-load gate)', () => {
    // Regression guard for the kitchen-sink flash: before the first server
    // response, the registry's disabledLoaded flag is false and plugin pages
    // must NOT render — even if the user is direct-navigating to a plugin URL.
    const KitchenSink = () => <div>Kitchen Sink UI</div>;
    pluginRegistry.registerPages('kitchen-sink', [
      { path: 'kitchen-sink', component: KitchenSink },
    ]);

    render(
      <MemoryRouter initialEntries={['/kitchen-sink']}>
        <TestRouter />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Kitchen Sink UI')).not.toBeInTheDocument();
    expect(screen.getByText('Not Found')).toBeInTheDocument();

    act(() => {
      pluginRegistry.setDisabledPlugins([]);
    });

    expect(screen.getByText('Kitchen Sink UI')).toBeInTheDocument();
  });

  it('re-enables a page route when the plugin is re-enabled', () => {
    const KitchenSink = () => <div>Kitchen Sink UI</div>;
    pluginRegistry.registerPages('kitchen-sink', [
      { path: 'kitchen-sink', component: KitchenSink },
    ]);

    // Start disabled
    pluginRegistry.setDisabledPlugins(['kitchen-sink']);

    render(
      <MemoryRouter initialEntries={['/kitchen-sink']}>
        <TestRouter />
      </MemoryRouter>,
    );

    expect(screen.getByText('Not Found')).toBeInTheDocument();

    act(() => {
      pluginRegistry.setDisabledPlugins([]);
    });

    expect(screen.getByText('Kitchen Sink UI')).toBeInTheDocument();
    expect(screen.queryByText('Not Found')).not.toBeInTheDocument();
  });
});
