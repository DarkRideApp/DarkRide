import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginDrawer, type PluginDrawerProps } from './PluginDrawer';
import { buildEntries, type PluginEntry } from './catalog';
import { registryPlugin, installedPlugin } from './testing';
import type { ScopeStatus } from './usePluginCatalog';

function entryOf(
  reg: Parameters<typeof registryPlugin>[0] | null,
  inst: Parameters<typeof installedPlugin>[0] | null,
): PluginEntry {
  return buildEntries(reg ? [registryPlugin(reg)] : [], inst ? [installedPlugin(inst)] : [])[0];
}

function renderDrawer(entry: PluginEntry | null, over: Partial<PluginDrawerProps> = {}) {
  const props: PluginDrawerProps = {
    entry,
    requestedName: entry?.name ?? 'ghost',
    entries: entry ? [entry] : [],
    busy: null,
    installBlocked: false,
    hasSettingsPage: false,
    onClose: vi.fn(),
    onInstall: vi.fn(),
    onUpdate: vi.fn(),
    onToggleEnabled: vi.fn(),
    onReviewPermissions: vi.fn(),
    onUninstall: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <PluginDrawer {...props} />
    </MemoryRouter>,
  );
  return props;
}

const consent: ScopeStatus = {
  state: 'unconsented',
  manifestScopes: ['ai.chat', 'ai.vision'],
  approvedScopes: null,
  added: [
    { key: 'ai.chat', metadata: { label: 'Chat with models', description: 'Send prompts' } },
    { key: 'ai.vision', metadata: { label: 'Read images', description: 'Send screenshots' } },
  ],
  removed: [],
};

describe('PluginDrawer', () => {
  it('is a dialog named for the plugin, and moves focus to its close button', () => {
    renderDrawer(entryOf({ name: 'maps', displayName: 'Maps Plugin' }, { name: 'maps' }));
    const dialog = screen.getByRole('dialog', { name: 'Maps Plugin details' });
    expect(within(dialog).getByRole('heading', { name: 'Maps Plugin' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close details' })).toHaveFocus();
  });

  it('closes from the button and from Escape', () => {
    const props = renderDrawer(entryOf({ name: 'maps' }, { name: 'maps' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('shows the details of a registry plugin', () => {
    renderDrawer(
      entryOf(
        { name: 'maps', description: 'Map overlay for parks', author: 'DarkRide', license: 'MIT', category: 'theme-parks', source: 'DarkRide Official', repo: 'DarkRideApp/plugin-maps' },
        null,
      ),
    );
    expect(screen.getByText('Map overlay for parks')).toBeInTheDocument();
    expect(screen.getByText('MIT')).toBeInTheDocument();
    expect(screen.getByText('theme-parks')).toBeInTheDocument();
    expect(screen.getByText('DarkRide Official')).toBeInTheDocument();
    const repo = screen.getByRole('link', { name: /Repository/ });
    expect(repo).toHaveAttribute('href', 'https://github.com/DarkRideApp/plugin-maps');
    expect(repo).toHaveAttribute('target', '_blank');
    expect(repo).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('says how an installed plugin got here', () => {
    renderDrawer(entryOf(null, { name: 'dev', npmPackage: null, installedVia: 'workspace' }));
    expect(screen.getByText('Local workspace')).toBeInTheDocument();
  });

  describe('actions', () => {
    it('installs an available plugin', () => {
      const props = renderDrawer(entryOf({ name: 'maps' }, null));
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      expect(props.onInstall).toHaveBeenCalledWith(props.entry);
    });

    it('blocks Install while another install runs', () => {
      renderDrawer(entryOf({ name: 'maps' }, null), { installBlocked: true });
      expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    });

    it('updates a plugin', () => {
      const props = renderDrawer(entryOf({ name: 'maps' }, { name: 'maps', updateAvailable: true, latestVersion: '2.0.0' }));
      fireEvent.click(screen.getByRole('button', { name: 'Update to v2.0.0' }));
      expect(props.onUpdate).toHaveBeenCalledWith(props.entry);
    });

    it('toggles enabled with a stable switch name', () => {
      const props = renderDrawer(entryOf({ name: 'maps' }, { name: 'maps', enabled: true }));
      const sw = screen.getByRole('switch', { name: 'Enabled' });
      expect(sw).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(sw);
      expect(props.onToggleEnabled).toHaveBeenCalledWith(props.entry);
    });

    it('has no switch for a plugin that is not installed', () => {
      renderDrawer(entryOf({ name: 'maps' }, null));
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('offers Uninstall for a marketplace install', () => {
      const props = renderDrawer(entryOf({ name: 'maps' }, { name: 'maps', installedVia: 'managed' }));
      fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
      expect(props.onUninstall).toHaveBeenCalledWith(props.entry);
    });

    it('offers to remove leftover state when the files are gone', () => {
      renderDrawer(entryOf(null, { name: 'gone', npmPackage: null, installedVia: 'missing' }));
      expect(screen.getByRole('button', { name: 'Remove leftover state' })).toBeInTheDocument();
    });

    it('offers no Uninstall for a local workspace plugin', () => {
      renderDrawer(entryOf(null, { name: 'dev', npmPackage: null, installedVia: 'workspace' }));
      expect(screen.queryByRole('button', { name: /Uninstall|Remove leftover/ })).toBeNull();
    });

    it('links to the plugin settings page when it has one', () => {
      renderDrawer(entryOf({ name: 'maps' }, { name: 'maps' }), { hasSettingsPage: true });
      expect(screen.getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '/ui/settings/plugins/maps/settings');
    });

    it('has no settings link when the plugin has no settings page', () => {
      renderDrawer(entryOf({ name: 'maps' }, { name: 'maps' }), { hasSettingsPage: false });
      expect(screen.queryByRole('link', { name: 'Open settings' })).toBeNull();
    });
  });

  describe('sections', () => {
    it('explains an unverified plugin', () => {
      renderDrawer(entryOf({ name: 'maps', verification: { status: 'unsigned' } }, null));
      expect(screen.getByText(/not signed by a trusted publisher/i)).toBeInTheDocument();
    });

    it('lists dependencies and marks the ones that are not installed', () => {
      const overlay = entryOf({ name: 'overlay', dependencies: ['maps', 'base'] }, null);
      const maps = entryOf({ name: 'maps' }, { name: 'maps' });
      renderDrawer(overlay, { entries: [overlay, maps] });
      expect(screen.getByText('base (not installed)')).toBeInTheDocument();
      expect(screen.getByText('maps')).toBeInTheDocument();
    });

    it('counts what a loaded plugin provides', () => {
      renderDrawer(
        entryOf(null, { name: 'p', npmPackage: null, metadata: { tools: [{}, {}, {}], pages: [{}], settings: [] } as any }),
      );
      const section = screen.getByRole('region', { name: 'Provides' });
      expect(within(section).getByText('Tools').nextSibling).toHaveTextContent('3');
      expect(within(section).getByText('Pages').nextSibling).toHaveTextContent('1');
      expect(within(section).getByText('Settings').nextSibling).toHaveTextContent('0');
    });

    it('says counts are unavailable until a plugin is loaded', () => {
      renderDrawer(entryOf(null, { name: 'p', npmPackage: null, loaded: false }));
      expect(screen.getByText(/appear once the plugin is loaded/i)).toBeInTheDocument();
    });

    it('shows the full host error', () => {
      renderDrawer(entryOf(null, { name: 'p', npmPackage: null, enabled: false, lastError: 'Migration 0004 failed\nat step two' }));
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Migration 0004 failed');
      expect(alert).toHaveTextContent('at step two');
    });

    it('lists the permissions awaiting approval, with one Review permissions button', () => {
      const props = renderDrawer(entryOf({ name: 'ai' }, { name: 'ai' }), { scopeStatus: consent });
      const section = screen.getByRole('region', { name: 'AI permissions' });
      expect(within(section).getByText('Chat with models')).toBeInTheDocument();
      expect(within(section).getByText('Read images')).toBeInTheDocument();
      // The lead action at the top is the only review button; the section does not repeat it.
      const buttons = screen.getAllByRole('button', { name: 'Review permissions' });
      expect(buttons).toHaveLength(1);
      expect(section.contains(buttons[0])).toBe(false);
      fireEvent.click(buttons[0]);
      expect(props.onReviewPermissions).toHaveBeenCalledWith(props.entry);
    });

    it('still offers Update when Review permissions is the lead action', () => {
      const props = renderDrawer(entryOf({ name: 'ai' }, { name: 'ai', updateAvailable: true, latestVersion: '2.0.0' }), {
        scopeStatus: consent,
      });
      expect(screen.getByRole('button', { name: 'Review permissions' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Update to v2.0.0' }));
      expect(props.onUpdate).toHaveBeenCalledWith(props.entry);
    });

    it('does not offer a second Update when Update is already the lead action', () => {
      renderDrawer(entryOf({ name: 'maps' }, { name: 'maps', updateAvailable: true, latestVersion: '2.0.0' }));
      expect(screen.getAllByRole('button', { name: 'Update to v2.0.0' })).toHaveLength(1);
    });

    it('lists approved permissions without a review button', () => {
      renderDrawer(entryOf({ name: 'ai' }, { name: 'ai' }), {
        scopeStatus: { ...consent, state: 'approved', approvedScopes: ['ai.chat'] },
      });
      const section = screen.getByRole('region', { name: 'AI permissions' });
      expect(within(section).getByText('ai.chat')).toBeInTheDocument();
      expect(within(section).queryByRole('button', { name: 'Review permissions' })).toBeNull();
    });

    it('omits the permissions section when the plugin declares none', () => {
      renderDrawer(entryOf({ name: 'maps' }, { name: 'maps' }), { scopeStatus: { ...consent, state: 'no-scopes', manifestScopes: [] } });
      expect(screen.queryByRole('region', { name: 'AI permissions' })).toBeNull();
    });
  });

  it('says so when the requested plugin does not exist', () => {
    const props = renderDrawer(null, { requestedName: 'ghost' });
    expect(screen.getByRole('dialog', { name: 'Plugin not found' })).toBeInTheDocument();
    expect(screen.getByText(/No plugin named "ghost"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
