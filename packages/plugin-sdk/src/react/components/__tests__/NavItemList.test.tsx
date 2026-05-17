// packages/plugin-sdk/src/react/components/__tests__/NavItemList.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../hooks/useAuth', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useAuth')>('../../hooks/useAuth');
  return {
    ...actual,
    useAuthOptional: () => ({
      hasScope: (scope: string) => !scope.startsWith('core.impossible:'),
    }),
  };
});

import { NavItemList } from '../NavItemList';
import type { NavItemListItem } from '../../plugin-registry/types';
import { pluginRegistry } from '../../plugin-registry';

function resetRegistry() {
  (pluginRegistry as any).buttonContribs = [];
  (pluginRegistry as any).navItemContribs = [];
  (pluginRegistry as any).uiSlots = [];
  (pluginRegistry as any).disabledPlugins = new Set();
  (pluginRegistry as any).typedOrderCounter = 0;
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

describe('<NavItemList>', () => {
  beforeEach(resetRegistry);

  it('renders host items with correct labels', () => {
    const items: NavItemListItem[] = [
      { id: 'a', label: 'Alpha', to: '/alpha' },
      { id: 'b', label: 'Bravo', to: '/bravo' },
    ];
    renderWithRouter(<NavItemList items={items} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
  });

  it('links prepend /ui to the to field', () => {
    const items: NavItemListItem[] = [
      { id: 'a', label: 'Alpha', to: '/settings' },
    ];
    renderWithRouter(<NavItemList items={items} />);
    const link = screen.getByRole('link', { name: /alpha/i });
    expect(link).toHaveAttribute('href', '/ui/settings');
  });

  it('merges plugin contributions when id is set', () => {
    pluginRegistry.registerNavItemContribution('p', {
      slot: 'my:slot', id: 'p:one', label: 'FromPlugin', to: '/plugin-page',
    });
    renderWithRouter(
      <NavItemList
        id="my:slot"
        items={[{ id: 'h', label: 'FromHost', to: '/host-page' }]}
      />
    );
    expect(screen.getByText('FromHost')).toBeInTheDocument();
    expect(screen.getByText('FromPlugin')).toBeInTheDocument();
  });

  it('does NOT merge contributions when id is omitted', () => {
    pluginRegistry.registerNavItemContribution('p', {
      slot: 'my:slot', id: 'p:one', label: 'FromPlugin', to: '/plugin-page',
    });
    renderWithRouter(
      <NavItemList items={[{ id: 'h', label: 'FromHost', to: '/host-page' }]} />
    );
    expect(screen.getByText('FromHost')).toBeInTheDocument();
    expect(screen.queryByText('FromPlugin')).toBeNull();
  });

  it('sorts by priority asc', () => {
    pluginRegistry.registerNavItemContribution('p', {
      slot: 'my:slot', id: 'p:high', label: 'High', to: '/high', priority: 10,
    });
    pluginRegistry.registerNavItemContribution('p', {
      slot: 'my:slot', id: 'p:low', label: 'Low', to: '/low', priority: -1,
    });
    renderWithRouter(
      <NavItemList
        id="my:slot"
        items={[{ id: 'h', label: 'Host', to: '/host' }]}
      />
    );
    const links = screen.getAllByRole('link').map(l => l.textContent?.trim());
    // Low (-1) → Host (0) → High (10)
    expect(links).toEqual(['Low', 'Host', 'High']);
  });

  it('filters items whose requiredScope is not granted', () => {
    renderWithRouter(
      <NavItemList
        items={[
          { id: 'a', label: 'AllowedA', to: '/allowed' },
          { id: 'b', label: 'DeniedB', to: '/denied', requiredScope: 'core.impossible:*' },
        ]}
      />
    );
    expect(screen.getByText('AllowedA')).toBeInTheDocument();
    expect(screen.queryByText('DeniedB')).toBeNull();
  });

  it('renders badge inline when present', () => {
    renderWithRouter(
      <NavItemList
        items={[{ id: 'a', label: 'Updates', to: '/updates', badge: 5 }]}
      />
    );
    expect(screen.getByText('Updates')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('custom ItemComponent overrides default rendering', () => {
    const CustomItem = ({ item }: any) => <span data-testid="custom">{item.label}!!</span>;
    renderWithRouter(
      <NavItemList
        ItemComponent={CustomItem}
        items={[{ id: 'a', label: 'Hi', to: '/hi' }]}
      />
    );
    expect(screen.getByTestId('custom')).toHaveTextContent('Hi!!');
  });

  it('plugin contributions flow through custom ItemComponent', () => {
    pluginRegistry.registerNavItemContribution('p', {
      slot: 'my:slot', id: 'p:1', label: 'Plug', to: '/plug',
    });
    const CustomItem = ({ item }: any) => <span data-testid={`custom-${item.id}`}>{item.label}</span>;
    renderWithRouter(
      <NavItemList
        id="my:slot"
        ItemComponent={CustomItem}
        items={[{ id: 'h', label: 'Host', to: '/host' }]}
      />
    );
    expect(screen.getByTestId('custom-h')).toHaveTextContent('Host');
    expect(screen.getByTestId('custom-p:1')).toHaveTextContent('Plug');
  });

  it('re-renders and hides contributions when setDisabledPlugins is called without external re-render', async () => {
    pluginRegistry.registerNavItemContribution('my-plugin', {
      slot: 'reactive:slot', id: 'my-plugin:nav', label: 'PluginPage', to: '/plugin-page',
    });
    renderWithRouter(
      <NavItemList id="reactive:slot" items={[]} />
    );
    expect(screen.getByText('PluginPage')).toBeInTheDocument();

    // Disable the plugin — no parent re-render, no route change.
    // The component must re-render itself via the reactive registry.
    act(() => {
      pluginRegistry.setDisabledPlugins(['my-plugin']);
    });

    expect(screen.queryByText('PluginPage')).not.toBeInTheDocument();
  });
});
