import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsSidebar } from '../SettingsSidebar';
import { pluginRegistry, __resetPluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { AuthContext } from '@darkrideapp/plugin-sdk/react';

function NoopPage() { return <div>noop</div>; }

function makeAuthContext(scopes: string[]) {
  return { hasScope: (s: string) => scopes.includes(s) } as any;
}

function renderSidebar(scopes: string[] = ['core.plugins:manage']) {
  return render(
    <MemoryRouter initialEntries={['/ui/settings/notifications']}>
      <AuthContext.Provider value={makeAuthContext(scopes)}>
        <SettingsSidebar />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('SettingsSidebar', () => {
  beforeEach(() => __resetPluginRegistry());

  it('renders all static group items', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /Notifications/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Integrations/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Installed/ })).toBeInTheDocument();
    // Marketplace promoted to top-level nav on 2026-05-14 (AppLayout Tools group);
    // not in the Settings sidebar any more.
    expect(screen.queryByRole('link', { name: /Marketplace/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Proxies/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Changelog/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restart Server/ })).toBeInTheDocument();
  });

  it('renders plugin-registered settings entries under Plugins group', () => {
    pluginRegistry.registerSettings('demo-plugin', { label: 'Demo Plugin', component: NoopPage });
    // Simulate the disabled-plugin list having loaded (empty = no disabled plugins).
    // Without this, isDisabledLoaded() returns false and the sidebar hides all
    // plugin-contributed entries to avoid a flash of stale data.
    pluginRegistry.setDisabledPlugins([]);
    renderSidebar();
    expect(screen.getByRole('link', { name: /Demo Plugin/ })).toBeInTheDocument();
  });

  it('hides System group restart button when user lacks scope', () => {
    renderSidebar([]);
    expect(screen.queryByRole('button', { name: /Restart Server/ })).toBeNull();
  });

  it('hides disabled plugin settings entries', () => {
    pluginRegistry.registerSettings('foo', { label: 'Foo Settings', component: NoopPage });
    pluginRegistry.setDisabledPlugins(['foo']);
    renderSidebar();
    expect(screen.queryByRole('link', { name: /Foo Settings/ })).toBeNull();
  });

  it('renders core:settings:tabs slot contributions as Plugins group entries (back-compat)', () => {
    pluginRegistry.registerUiSlots('host', [{
      id: 'core:settings:tabs',
      kind: 'nav-item',
      description: 'Legacy settings tabs slot',
    }]);
    pluginRegistry.registerUiContributions('legacy-plugin', [{
      slot: 'core:settings:tabs',
      label: 'Legacy Tab',
      path: '/ui/settings/legacy',
    }] as any);

    renderSidebar();

    expect(screen.getByRole('link', { name: /Legacy Tab/ })).toBeInTheDocument();
  });

  it('hides legacy core:settings:tabs entries when the plugin is disabled', () => {
    pluginRegistry.registerUiSlots('host', [{
      id: 'core:settings:tabs',
      kind: 'nav-item',
      description: 'Legacy settings tabs slot',
    }]);
    pluginRegistry.registerUiContributions('legacy-plugin', [{
      slot: 'core:settings:tabs',
      label: 'Legacy Tab',
      path: '/ui/settings/legacy',
    }] as any);
    pluginRegistry.setDisabledPlugins(['legacy-plugin']);

    renderSidebar();

    expect(screen.queryByRole('link', { name: /Legacy Tab/ })).toBeNull();
  });
});
