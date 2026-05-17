import type { ReactNode } from 'react';
import { NavItemList } from './NavItemList';
import type { NavItemListItem } from '../plugin-registry/types';
import { pluginRegistry } from '../plugin-registry';

// Paths are app-relative — NavItemList adds /ui.
const SETTINGS_TABS: NavItemListItem[] = [
  { id: 'settings',    label: 'Settings',      to: '/settings',             end: true, requiredScope: 'core.settings:read' },
  { id: 'plugins',     label: 'Plugins',       to: '/settings/plugins' },
  { id: 'marketplace', label: 'Marketplace',   to: '/settings/marketplace', requiredScope: 'core.plugins:manage' },
  { id: 'proxies',     label: 'Proxies',       to: '/settings/proxies',     requiredScope: 'core.proxies:manage' },
  { id: 'credentials', label: 'Credentials',   to: '/settings/credentials', requiredScope: 'core.credentials:read' },
  { id: 'jobs',        label: 'Jobs',          to: '/settings/jobs',        requiredScope: 'core.jobs:manage' },
  { id: 'utils',       label: 'Utils',         to: '/settings/utils' },
  { id: 'mcp',         label: 'MCP Server',    to: '/settings/mcp',         requiredScope: 'core.settings:write' },
  { id: 'cloud',       label: 'Cloud Storage', to: '/settings/cloud' },
];

// Register the slot so the inspector finds it + plugins can contribute.
pluginRegistry.registerUiSlots('core', [
  {
    id: 'core:settings:tabs',
    kind: 'nav-item-list',
    description: 'Tabs in the Settings page header. Plugins that add settings pages contribute here.',
  },
]);

/**
 * @deprecated Since 1.3.0. The Settings area uses a vertical sidebar layout
 * (`SettingsLayout` in the host). Plugin-contributed settings should use
 * `pluginRegistry.registerSettings()`. This component is kept for back-compat
 * but is no longer rendered by the host.
 */
export function SettingsNav({ actions }: { actions?: ReactNode } = {}) {
  return (
    <>
      <div className="page-header">
        <div><h1>Settings</h1></div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      <NavItemList
        id="core:settings:tabs"
        items={SETTINGS_TABS}
        className="settings-tab-strip"
      />
    </>
  );
}
