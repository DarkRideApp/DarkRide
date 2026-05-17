// packages/plugin-sdk/src/react/components/__tests__/ButtonList.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useAuth', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useAuth')>('../../hooks/useAuth');
  return {
    ...actual,
    useAuthOptional: () => ({
      hasScope: (scope: string) => !scope.startsWith('core.impossible:'),
    }),
  };
});

import { ButtonList } from '../ButtonList';
import type { ButtonListItem } from '../../plugin-registry/types';
import { pluginRegistry } from '../../plugin-registry';

function resetRegistry() {
  (pluginRegistry as any).buttonContribs = [];
  (pluginRegistry as any).navItemContribs = [];
  (pluginRegistry as any).uiSlots = [];
  (pluginRegistry as any).disabledPlugins = new Set();
  (pluginRegistry as any).typedOrderCounter = 0;
}

describe('<ButtonList>', () => {
  beforeEach(resetRegistry);

  it('renders host buttons', () => {
    const onClick = vi.fn();
    const buttons: ButtonListItem[] = [
      { id: 'a', label: 'Alpha', onClick },
      { id: 'b', label: 'Bravo', onClick: vi.fn() },
    ];
    render(<ButtonList buttons={buttons} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
  });

  it('fires onClick when a host button is clicked', () => {
    const onClick = vi.fn();
    render(<ButtonList buttons={[{ id: 'a', label: 'Alpha', onClick }]} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onClick).toHaveBeenCalled();
  });

  it('merges plugin contributions when id is set', () => {
    const hostClick = vi.fn(); const pluginClick = vi.fn();
    pluginRegistry.registerButtonContribution('p', {
      slot: 'my:slot', id: 'p:one', label: 'FromPlugin', onClick: pluginClick,
    });
    render(
      <ButtonList
        id="my:slot"
        buttons={[{ id: 'h', label: 'FromHost', onClick: hostClick }]}
      />
    );
    expect(screen.getByText('FromHost')).toBeInTheDocument();
    expect(screen.getByText('FromPlugin')).toBeInTheDocument();
  });

  it('does NOT merge contributions when id is omitted', () => {
    pluginRegistry.registerButtonContribution('p', {
      slot: 'my:slot', id: 'p:one', label: 'FromPlugin', onClick: vi.fn(),
    });
    render(<ButtonList buttons={[{ id: 'h', label: 'FromHost', onClick: vi.fn() }]} />);
    expect(screen.getByText('FromHost')).toBeInTheDocument();
    expect(screen.queryByText('FromPlugin')).toBeNull();
  });

  it('sorts by priority asc (host default 0 + plugin explicit)', () => {
    pluginRegistry.registerButtonContribution('p', {
      slot: 'my:slot', id: 'p:high', label: 'High', onClick: vi.fn(), priority: 10,
    });
    pluginRegistry.registerButtonContribution('p', {
      slot: 'my:slot', id: 'p:low', label: 'Low', onClick: vi.fn(), priority: -1,
    });
    render(
      <ButtonList
        id="my:slot"
        buttons={[{ id: 'h', label: 'Host', onClick: vi.fn() }]}
      />
    );
    const labels = screen.getAllByRole('button').map(b => b.textContent);
    // Low (-1) → Host (0) → High (10)
    expect(labels).toEqual(['Low', 'Host', 'High']);
  });

  it('filters items whose requiredScope is not granted', () => {
    render(
      <ButtonList
        buttons={[
          { id: 'a', label: 'AllowedA', onClick: vi.fn() },
          { id: 'b', label: 'DeniedB', onClick: vi.fn(), requiredScope: 'core.impossible:*' },
        ]}
      />
    );
    expect(screen.getByText('AllowedA')).toBeInTheDocument();
    expect(screen.queryByText('DeniedB')).toBeNull();
  });

  it('renders disabled=true items as disabled', () => {
    render(
      <ButtonList buttons={[{ id: 'a', label: 'Disabled', onClick: vi.fn(), disabled: true }]} />
    );
    expect(screen.getByText('Disabled').closest('button')).toBeDisabled();
  });

  it('custom ItemComponent overrides default rendering', () => {
    const CustomItem = ({ item }: any) => <span data-testid="custom">{item.label}!!</span>;
    render(
      <ButtonList
        ItemComponent={CustomItem}
        buttons={[{ id: 'a', label: 'Hi', onClick: vi.fn() }]}
      />
    );
    expect(screen.getByTestId('custom')).toHaveTextContent('Hi!!');
  });

  it('plugin contributions flow through the custom ItemComponent too', () => {
    pluginRegistry.registerButtonContribution('p', {
      slot: 'my:slot', id: 'p:1', label: 'Plug', onClick: vi.fn(),
    });
    const CustomItem = ({ item }: any) => <span data-testid={`custom-${item.id}`}>{item.label}</span>;
    render(
      <ButtonList
        id="my:slot"
        ItemComponent={CustomItem}
        buttons={[{ id: 'h', label: 'Host', onClick: vi.fn() }]}
      />
    );
    expect(screen.getByTestId('custom-h')).toHaveTextContent('Host');
    expect(screen.getByTestId('custom-p:1')).toHaveTextContent('Plug');
  });
});
