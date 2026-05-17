import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ExtensionSlot } from '../ExtensionSlot';
import { pluginRegistry } from '../../plugin-registry';
import { setSlotInspectorEnabled } from '../../lib/dev-tools';

describe('<ExtensionSlot>', () => {
  beforeEach(() => {
    // Reset singleton state for test isolation.
    (pluginRegistry as any).uiSlots = [];
    (pluginRegistry as any).uiContributions = [];
    (pluginRegistry as any).contributionComponents = new Map();
    (pluginRegistry as any).disabledPlugins = new Set();
    (pluginRegistry as any).contributionOrderCounter = 0;
  });

  it('renders the emptyFallback when no contributions target the slot', () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'slot' },
    ]);
    render(<ExtensionSlot id="host:s" emptyFallback={<span>none</span>} />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('renders registered contributions in order', () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'slot' },
    ]);
    const A = () => <span>A</span>;
    const B = () => <span>B</span>;
    pluginRegistry.registerContributionComponents('p1', { A });
    pluginRegistry.registerContributionComponents('p2', { B });
    pluginRegistry.registerUiContributions('p1', [{ slot: 'host:s', id: 'p1:a', component: 'A' }]);
    pluginRegistry.registerUiContributions('p2', [{ slot: 'host:s', id: 'p2:b', component: 'B' }]);
    render(<ExtensionSlot id="host:s" />);
    const rendered = screen.getAllByText(/A|B/);
    expect(rendered.map(n => n.textContent)).toEqual(['A', 'B']);
  });

  it('forwards scoped props to every contribution', () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'slot' },
    ]);
    const Comp = ({ label }: { label: string }) => <span>got:{label}</span>;
    pluginRegistry.registerContributionComponents('p', { Comp });
    pluginRegistry.registerUiContributions('p', [{ slot: 'host:s', id: 'p:x', component: 'Comp' }]);
    render(<ExtensionSlot id="host:s" props={{ label: 'hello' }} />);
    expect(screen.getByText('got:hello')).toBeInTheDocument();
  });

  it('dev-mode warns when id was never declared by any plugin', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ExtensionSlot id="not:declared" />);
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/not:declared/));
    });
    warnSpy.mockRestore();
  });
});

describe('<ExtensionSlot> inspector mode', () => {
  beforeEach(() => {
    // Reset singleton state (matches existing beforeEach)
    (pluginRegistry as any).uiSlots = [];
    (pluginRegistry as any).uiContributions = [];
    (pluginRegistry as any).contributionComponents = new Map();
    (pluginRegistry as any).disabledPlugins = new Set();
    (pluginRegistry as any).contributionOrderCounter = 0;
    localStorage.clear();
  });

  afterEach(() => {
    setSlotInspectorEnabled(false);
  });

  it('does NOT render outline when inspector is disabled', () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'slot' },
    ]);
    const { container } = render(<ExtensionSlot id="host:s" emptyFallback={<span>none</span>} />);
    expect(container.querySelector('[data-slot-inspector]')).toBeNull();
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('renders outline + badge when inspector is enabled', async () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'demo slot' },
    ]);
    setSlotInspectorEnabled(true);
    render(<ExtensionSlot id="host:s" />);
    const wrapper = await screen.findByTestId('slot-inspector-wrapper');
    expect(wrapper).toBeInTheDocument();
    const badge = await screen.findByTestId('slot-inspector-badge');
    expect(badge).toHaveTextContent('host:s');
  });

  it('badge shows contribution count', async () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'slot' },
    ]);
    const A = () => <span>A</span>;
    pluginRegistry.registerContributionComponents('p', { A });
    pluginRegistry.registerUiContributions('p', [
      { slot: 'host:s', id: 'p:a', component: 'A' },
    ]);
    setSlotInspectorEnabled(true);
    render(<ExtensionSlot id="host:s" />);
    const badge = await screen.findByTestId('slot-inspector-badge');
    // "host:s · 1" style — assert the count is present
    expect(badge).toHaveTextContent(/host:s.*1/);
  });

  it('renders a placeholder for empty slots when inspector is enabled', async () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:empty', kind: 'container', description: 'nothing here yet' },
    ]);
    setSlotInspectorEnabled(true);
    render(<ExtensionSlot id="host:empty" />);
    expect(await screen.findByText(/no contributions/i)).toBeInTheDocument();
  });

  it('badge description is used as the title attribute for hover', async () => {
    pluginRegistry.registerUiSlots('host', [
      { id: 'host:s', kind: 'container', description: 'hoverable description' },
    ]);
    setSlotInspectorEnabled(true);
    render(<ExtensionSlot id="host:s" />);
    const badge = await screen.findByTestId('slot-inspector-badge');
    expect(badge).toHaveAttribute('title', 'hoverable description');
  });
});
