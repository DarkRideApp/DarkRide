import React, { useContext, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { usePluginRegistrySnapshot, AuthContext } from '@darkrideapp/plugin-sdk/react';
import { RestartConfirmModal } from './RestartConfirmModal';

interface SidebarItem {
  label: string;
  path: string;
}

const GENERAL: SidebarItem[] = [
  { label: 'Notifications', path: '/ui/settings/notifications' },
  { label: 'Integrations', path: '/ui/settings/integrations' },
  { label: 'AI', path: '/ui/settings/ai' },
  { label: 'APK Analysis', path: '/ui/settings/analysis' },
  { label: 'Cloud Storage', path: '/ui/settings/cloud-storage' },
  { label: 'Traffic', path: '/ui/settings/traffic' },
];

const PLUGINS_STATIC: SidebarItem[] = [
  { label: 'Installed', path: '/ui/settings/plugins' },
  // Marketplace moved to the top-level Tools nav on 2026-05-14 — it's a
  // first-run / frequent action, not a config screen. Per fresh review §2a.
];

const ADVANCED: SidebarItem[] = [
  { label: 'Proxies', path: '/ui/settings/proxies' },
  { label: 'Credentials', path: '/ui/settings/credentials' },
  { label: 'Jobs', path: '/ui/settings/jobs' },
  { label: 'MCP Server', path: '/ui/settings/mcp' },
  { label: 'Utilities', path: '/ui/settings/utils' },
  { label: 'SDK Catalog', path: '/ui/settings/sdk-catalog' },
];

const ABOUT: SidebarItem[] = [
  { label: 'Changelog', path: '/ui/settings/changelog' },
  { label: 'License', path: '/ui/settings/license' },
];

const RESTART_SCOPE = 'core.plugins:manage';

function Group({ label, items }: { label: string; items: SidebarItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="settings-sidebar-group">
      <div className="settings-sidebar-group-label">{label}</div>
      {items.map(item => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => `settings-sidebar-link${isActive ? ' active' : ''}`}
          end={item.path === '/ui/settings/plugins'}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export function SettingsSidebar() {
  const auth = useContext(AuthContext);
  const pluginSettings = usePluginRegistrySnapshot(r =>
    r.isDisabledLoaded() ? r.getSettings() : []
  );
  const legacyTabs = usePluginRegistrySnapshot(r =>
    r.getRawSlotContributions('core:settings:tabs') as Array<{ plugin: string; label?: string; path?: string }>,
  );
  const [showRestartModal, setShowRestartModal] = useState(false);

  useEffect(() => {
    if (legacyTabs.length > 0) {
      console.warn(
        '[plugin-sdk] core:settings:tabs slot is deprecated. ' +
        'Use pluginRegistry.registerSettings() instead. ' +
        `Affected plugins: ${[...new Set(legacyTabs.map(c => c.plugin))].join(', ')}`,
      );
    }
  }, [legacyTabs.length]);

  const pluginsItems: SidebarItem[] = [
    ...PLUGINS_STATIC,
    ...pluginSettings.map(s => ({
      label: s.label,
      path: `/ui/settings/plugins/${s.pluginName}/settings`,
    })),
    ...legacyTabs
      .filter((c): c is typeof c & { label: string; path: string } =>
        typeof c.label === 'string' && typeof c.path === 'string',
      )
      .map(c => ({
        label: c.label,
        path: c.path,
      })),
  ];

  const canRestart = auth?.hasScope?.(RESTART_SCOPE) ?? false;

  return (
    <aside className="settings-sidebar">
      <Group label="General" items={GENERAL} />
      <Group label="Plugins" items={pluginsItems} />
      <Group label="Advanced" items={ADVANCED} />
      <Group label="About" items={ABOUT} />
      {canRestart && (
        <div className="settings-sidebar-group">
          <div className="settings-sidebar-group-label">System</div>
          <button
            type="button"
            className="settings-sidebar-link settings-sidebar-action"
            onClick={() => setShowRestartModal(true)}
          >
            Restart Server
          </button>
        </div>
      )}
      {showRestartModal && (
        <RestartConfirmModal onClose={() => setShowRestartModal(false)} />
      )}
    </aside>
  );
}
