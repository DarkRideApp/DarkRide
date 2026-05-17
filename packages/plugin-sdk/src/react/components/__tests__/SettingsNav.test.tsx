import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../hooks/useAuth', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useAuth')>('../../hooks/useAuth');
  return {
    ...actual,
    useAuthOptional: () => ({
      hasScope: () => true,
    }),
  };
});

import { SettingsNav } from '../SettingsNav';
import { pluginRegistry } from '../../plugin-registry';

function resetRegistry() {
  (pluginRegistry as any).navItemContribs = [];
  (pluginRegistry as any).uiSlots = [];
  (pluginRegistry as any).disabledPlugins = new Set();
  (pluginRegistry as any).typedOrderCounter = 0;
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

describe('<SettingsNav>', () => {
  beforeEach(resetRegistry);

  it('renders the built-in settings tabs', () => {
    renderWithRouter(<SettingsNav />);
    // Use getAllByText since the H1 also says "Settings"
    expect(screen.getAllByText('Settings').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    expect(screen.getByText('MCP Server')).toBeInTheDocument();
  });

  it('renders a plugin-contributed settings tab', () => {
    pluginRegistry.registerNavItemContribution('demo-plugin', {
      slot: 'core:settings:tabs',
      id: 'demo-plugin:tab',
      label: 'Demo Plugin',
      to: '/settings/demo-plugin',
      icon: 'database',
    });
    renderWithRouter(<SettingsNav />);
    expect(screen.getByText('Demo Plugin')).toBeInTheDocument();
  });

  it('renders actions prop in the page header', () => {
    renderWithRouter(<SettingsNav actions={<button>Action</button>} />);
    expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  });
});
