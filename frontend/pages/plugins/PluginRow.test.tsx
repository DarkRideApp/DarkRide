import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginRow, type PluginRowProps } from './PluginRow';
import { buildEntries, type PluginEntry } from './catalog';
import { registryPlugin, installedPlugin } from './testing';
import type { ScopeStatus } from './usePluginCatalog';

function entryOf(
  reg: Parameters<typeof registryPlugin>[0] | null,
  inst: Parameters<typeof installedPlugin>[0] | null,
): PluginEntry {
  return buildEntries(reg ? [registryPlugin(reg)] : [], inst ? [installedPlugin(inst)] : [])[0];
}

function renderRow(entry: PluginEntry, over: Partial<PluginRowProps> = {}) {
  const props: PluginRowProps = {
    entry,
    tab: 'installed',
    busy: null,
    installBlocked: false,
    unmetDependencies: [],
    onOpen: vi.fn(),
    onInstall: vi.fn(),
    onUpdate: vi.fn(),
    onToggleEnabled: vi.fn(),
    onReviewPermissions: vi.fn(),
    ...over,
  };
  render(<ul><PluginRow {...props} /></ul>);
  return props;
}

const unconsented: ScopeStatus = {
  state: 'unconsented',
  manifestScopes: ['ai.chat'],
  approvedScopes: null,
  added: [{ key: 'ai.chat' }],
  removed: [],
};

describe('PluginRow', () => {
  it('shows the display name, version, description and author', () => {
    renderRow(entryOf({ name: 'maps', displayName: 'Maps Plugin', description: 'Map overlay', author: 'DarkRide' }, { name: 'maps', version: '1.2.0' }));
    expect(screen.getByRole('button', { name: 'Maps Plugin' })).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();
    expect(screen.getByText('Map overlay')).toBeInTheDocument();
    expect(screen.getByText(/DarkRide/)).toBeInTheDocument();
  });

  it('renders a plugin with no version, description or author without empty gaps', () => {
    renderRow(entryOf(null, { name: 'bare', npmPackage: null, version: null, description: null, author: null }));
    expect(screen.getByRole('button', { name: 'bare' })).toBeInTheDocument();
    expect(screen.queryByText(/^v\d/)).toBeNull();
    expect(screen.queryByText(/^by /)).toBeNull();
    expect(document.querySelector('.plugins-row-desc')).toBeNull();
  });

  describe('actions', () => {
    it('an available plugin offers Install and no enable switch', () => {
      const props = renderRow(entryOf({ name: 'maps' }, null), { tab: 'discover' });
      expect(screen.queryByRole('switch')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      expect(props.onInstall).toHaveBeenCalledWith(props.entry);
      expect(props.onOpen).not.toHaveBeenCalled();
    });

    it('disables Install while another install is running', () => {
      renderRow(entryOf({ name: 'maps' }, null), { tab: 'discover', installBlocked: true });
      expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    });

    it('shows Installing while this plugin installs', () => {
      renderRow(entryOf({ name: 'maps' }, null), { tab: 'discover', busy: 'installing', installBlocked: true });
      const btn = screen.getByRole('button', { name: /Installing/ });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-busy', 'true');
    });

    it('an update shows the version jump and an Update button that does not open the drawer', () => {
      const props = renderRow(
        entryOf({ name: 'maps', latestVersion: '2.0.0' }, { name: 'maps', version: '1.0.0', updateAvailable: true, latestVersion: '2.0.0' }),
      );
      expect(screen.getByText('v1.0.0 → v2.0.0')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Update to v2.0.0' }));
      expect(props.onUpdate).toHaveBeenCalledWith(props.entry);
      expect(props.onOpen).not.toHaveBeenCalled();
    });

    it('shows Updating while an update runs and blocks a second click', () => {
      renderRow(
        entryOf({ name: 'maps' }, { name: 'maps', updateAvailable: true, latestVersion: '2.0.0' }),
        { busy: 'updating' },
      );
      expect(screen.getByRole('button', { name: /Updating/ })).toBeDisabled();
    });

    it('a disabled plugin with an update still offers Update', () => {
      renderRow(entryOf({ name: 'maps' }, { name: 'maps', enabled: false, updateAvailable: true, latestVersion: '2.0.0' }));
      expect(screen.getByRole('button', { name: 'Update to v2.0.0' })).toBeInTheDocument();
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });

    it('a plugin whose files are missing offers Reinstall when the registry has it', () => {
      const props = renderRow(entryOf({ name: 'maps' }, { name: 'maps', installedVia: 'missing' }));
      fireEvent.click(screen.getByRole('button', { name: 'Reinstall' }));
      expect(props.onInstall).toHaveBeenCalledWith(props.entry);
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('a missing plugin outside the registry offers no Reinstall', () => {
      renderRow(entryOf(null, { name: 'local', npmPackage: null, installedVia: 'missing' }));
      expect(screen.queryByRole('button', { name: 'Reinstall' })).toBeNull();
    });

    it('a pending-consent plugin offers Review permissions', () => {
      const props = renderRow(entryOf({ name: 'ai' }, { name: 'ai' }), { scopeStatus: unconsented });
      fireEvent.click(screen.getByRole('button', { name: 'Review permissions' }));
      expect(props.onReviewPermissions).toHaveBeenCalledWith(props.entry);
    });

    it('a plugin with widened scopes offers Review permissions', () => {
      renderRow(entryOf({ name: 'ai' }, { name: 'ai' }), {
        scopeStatus: { ...unconsented, state: 'drift-wider', approvedScopes: [] },
      });
      expect(screen.getByRole('button', { name: 'Review permissions' })).toBeInTheDocument();
    });

    it.each(['approved', 'no-scopes', 'drift-narrower'] as const)('offers no review for scope state %s', state => {
      renderRow(entryOf({ name: 'ai' }, { name: 'ai' }), { scopeStatus: { ...unconsented, state } });
      expect(screen.queryByRole('button', { name: 'Review permissions' })).toBeNull();
    });

    it('a running update does not disable or spin an unrelated Review permissions button', () => {
      renderRow(entryOf({ name: 'ai' }, { name: 'ai', updateAvailable: true, latestVersion: '2.0.0' }), {
        scopeStatus: unconsented,
        busy: 'updating',
      });
      const btn = screen.getByRole('button', { name: 'Review permissions' });
      expect(btn).toBeEnabled();
      expect(btn).not.toHaveAttribute('aria-busy');
    });

    it('shows one primary action: Review permissions wins over Update', () => {
      renderRow(entryOf({ name: 'ai' }, { name: 'ai', updateAvailable: true, latestVersion: '2.0.0' }), { scopeStatus: unconsented });
      expect(screen.getByRole('button', { name: 'Review permissions' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull();
    });
  });

  describe('enable switch', () => {
    it('reflects the enabled state and toggles it', () => {
      const props = renderRow(entryOf({ name: 'maps' }, { name: 'maps', enabled: true }));
      const sw = screen.getByRole('switch', { name: 'Enable maps' });
      expect(sw).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(sw);
      expect(props.onToggleEnabled).toHaveBeenCalledWith(props.entry);
      expect(props.onOpen).not.toHaveBeenCalled();
    });

    it('is unchecked for a disabled plugin', () => {
      renderRow(entryOf({ name: 'maps' }, { name: 'maps', enabled: false }));
      expect(screen.getByRole('switch', { name: 'Enable maps' })).toHaveAttribute('aria-checked', 'false');
    });
  });

  describe('status pill', () => {
    it('an ordinary installed plugin shows no pill on the Installed tab', () => {
      renderRow(entryOf({ name: 'maps' }, { name: 'maps' }), { tab: 'installed' });
      expect(screen.queryByTestId('plugin-status')).toBeNull();
    });

    it('marks an installed plugin as Installed on the Discover tab', () => {
      renderRow(entryOf({ name: 'maps' }, { name: 'maps' }), { tab: 'discover' });
      expect(screen.getByTestId('plugin-status')).toHaveTextContent('Installed');
    });

    it.each([
      ['Disabled', { enabled: false }],
      ['Update available', { updateAvailable: true, latestVersion: '2.0.0' }],
      ['Auto-disabled', { enabled: false, lastError: 'migration failed' }],
      ['Files missing', { installedVia: 'missing' }],
      ['Restart to activate', { enabled: true, loaded: false }],
    ])('shows %s', (label, inst) => {
      renderRow(entryOf(null, { name: 'p', npmPackage: null, ...inst }));
      expect(screen.getByTestId('plugin-status')).toHaveTextContent(label as string);
    });
  });

  describe('detail line', () => {
    it('summarises a host error on the row', () => {
      renderRow(entryOf(null, { name: 'p', npmPackage: null, enabled: false, lastError: 'Migration 0004 failed\nstack trace line' }));
      expect(screen.getByText(/Migration 0004 failed/)).toBeInTheDocument();
      expect(screen.queryByText(/stack trace line/)).toBeNull();
    });

    it('lists unmet dependencies', () => {
      renderRow(entryOf({ name: 'overlay', dependencies: ['base'] }, null), { tab: 'discover', unmetDependencies: ['base'] });
      expect(screen.getByText('Requires base (not installed)')).toBeInTheDocument();
    });

    it('tags plugins that live on disk rather than the marketplace', () => {
      renderRow(entryOf(null, { name: 'dev', npmPackage: null, installedVia: 'workspace' }));
      expect(screen.getByText('Local')).toBeInTheDocument();
    });

    it('does not tag marketplace installs as local', () => {
      renderRow(entryOf({ name: 'maps' }, { name: 'maps', installedVia: 'managed' }));
      expect(screen.queryByText('Local')).toBeNull();
    });
  });

  describe('verification', () => {
    it('labels a verified plugin with the signer', () => {
      renderRow(entryOf({ name: 'maps', verification: { status: 'verified', keyLabel: 'DarkRide' } }, null), { tab: 'discover' });
      expect(screen.getByLabelText('Verified by DarkRide')).toBeInTheDocument();
    });
    it('labels an unsigned plugin as unverified', () => {
      renderRow(entryOf({ name: 'maps', verification: { status: 'unsigned' } }, null), { tab: 'discover' });
      expect(screen.getByLabelText('Unverified')).toBeInTheDocument();
    });
    it('labels an unknown signer', () => {
      renderRow(entryOf({ name: 'maps', verification: { status: 'untrusted' } }, null), { tab: 'discover' });
      expect(screen.getByLabelText('Unknown signer')).toBeInTheDocument();
    });
    it('shows no badge when there is no verification data', () => {
      renderRow(entryOf({ name: 'maps' }, null), { tab: 'discover' });
      expect(screen.queryByLabelText(/Verified|Unverified|Unknown signer/)).toBeNull();
    });
  });

  describe('opening the drawer', () => {
    it('opens from the name button', () => {
      const props = renderRow(entryOf({ name: 'maps', displayName: 'Maps Plugin' }, { name: 'maps' }));
      fireEvent.click(screen.getByRole('button', { name: 'Maps Plugin' }));
      expect(props.onOpen).toHaveBeenCalledWith(props.entry);
    });

    it('opens when the row body is clicked', () => {
      const props = renderRow(entryOf({ name: 'maps', description: 'Map overlay' }, { name: 'maps' }));
      fireEvent.click(screen.getByText('Map overlay'));
      expect(props.onOpen).toHaveBeenCalledTimes(1);
    });

    it('marks the open row as current', () => {
      renderRow(entryOf({ name: 'maps' }, { name: 'maps' }), { selected: true });
      expect(screen.getByTestId('plugin-row')).toHaveAttribute('aria-current', 'true');
    });
  });
});
