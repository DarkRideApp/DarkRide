import { describe, it, expect } from 'vitest';
import {
  buildEntries,
  forTab,
  applyInstalledFilter,
  matchesQuery,
  countByFilter,
  unmetDependencies,
  updatableEntries,
  statusLabel,
  needsConsent,
  primaryAction,
  canToggle,
  canUninstall,
  timeAgo,
  type RegistryPlugin,
  type InstalledPlugin,
  type ScopeStatus,
} from './catalog';

// Fixtures follow the real payload shapes: GET /v1/plugins/marketplace returns
// registry records (+ optional `verification`), GET /v1/plugins/installed
// returns the plugin_state row plus `loaded`, `metadata` (arrays, not counts),
// `updateAvailable` and `latestVersion`.

function reg(over: Partial<RegistryPlugin> & { name: string }): RegistryPlugin {
  return {
    displayName: over.name,
    description: `${over.name} description`,
    author: 'DarkRide',
    repo: `DarkRideApp/plugin-${over.name}`,
    latestVersion: '1.0.0',
    category: 'tools',
    license: 'MIT',
    npmPackage: `@darkride/plugin-${over.name}`,
    source: 'DarkRide Official',
    ...over,
  };
}

function inst(over: Partial<InstalledPlugin> & { name: string }): InstalledPlugin {
  return {
    version: '1.0.0',
    description: null,
    author: null,
    enabled: true,
    installedVia: 'managed',
    loaded: true,
    npmPackage: `@darkride/plugin-${over.name}`,
    signature: null,
    signedBy: null,
    lastError: null,
    metadata: null,
    updateAvailable: false,
    ...over,
  };
}

describe('buildEntries: joining registry and installed', () => {
  it('marks a registry plugin with no installed record as available', () => {
    const entries = buildEntries([reg({ name: 'maps' })], []);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('available');
    expect(entries[0].installed).toBeNull();
    expect(entries[0].registry?.name).toBe('maps');
  });

  it('joins by npmPackage when the runtime name differs from the registry name', () => {
    const entries = buildEntries(
      [reg({ name: 'maps-registry', npmPackage: '@darkride/plugin-maps' })],
      [inst({ name: 'maps', npmPackage: '@darkride/plugin-maps' })],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('maps');
    expect(entries[0].installed).not.toBeNull();
    expect(entries[0].registry).not.toBeNull();
  });

  it('joins by name when npmPackage is absent on either side', () => {
    const entries = buildEntries(
      [reg({ name: 'custom', npmPackage: '' })],
      [inst({ name: 'custom', npmPackage: null })],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].installed).not.toBeNull();
  });

  it('keeps an installed plugin the registry does not know about', () => {
    const entries = buildEntries([], [inst({ name: 'local-dev', installedVia: 'workspace', npmPackage: null })]);
    expect(entries).toHaveLength(1);
    expect(entries[0].registry).toBeNull();
    expect(entries[0].displayName).toBe('local-dev');
    expect(entries[0].installedVia).toBe('workspace');
  });

  it('prefers the registry display name and falls back to the runtime name', () => {
    const entries = buildEntries(
      [reg({ name: 'maps', displayName: 'Maps Plugin' })],
      [inst({ name: 'maps' }), inst({ name: 'extra', npmPackage: null })],
    );
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    expect(byName.maps.displayName).toBe('Maps Plugin');
    expect(byName.extra.displayName).toBe('extra');
  });

  it('does not duplicate a plugin two sources both list', () => {
    const entries = buildEntries(
      [reg({ name: 'maps', source: 'DarkRide Official' }), reg({ name: 'maps', source: 'Private Registry' })],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].registry?.source).toBe('DarkRide Official');
  });

  it('does not list a second registry record whose name belongs to an installed plugin', () => {
    // 'maps' is installed and matches record B by npm package. Record A shares the
    // runtime name, so listing it too would put two rows (and two React keys) on one plugin.
    const entries = buildEntries(
      [
        reg({ name: 'maps', npmPackage: '@other/maps-a' }),
        reg({ name: 'maps-official', npmPackage: '@darkride/plugin-maps' }),
      ],
      [inst({ name: 'maps', npmPackage: '@darkride/plugin-maps' })],
    );
    expect(entries.map(e => e.name)).toEqual(['maps']);
    expect(entries[0].registry?.name).toBe('maps-official');
  });

  it('counts tools, pages and settings from the loaded metadata arrays', () => {
    const entries = buildEntries(
      [],
      [inst({ name: 'a', metadata: { tools: [{}, {}], pages: [{}], settings: [] } as any })],
    );
    expect(entries[0].provides).toEqual({ tools: 2, pages: 1, settings: 0 });
  });

  it('reports no provides when the plugin is not loaded', () => {
    const entries = buildEntries([], [inst({ name: 'a', loaded: false, metadata: null })]);
    expect(entries[0].provides).toBeNull();
  });

  it('takes verification from the registry record, else a signedBy label from state', () => {
    const entries = buildEntries(
      [reg({ name: 'maps', verification: { status: 'verified', keyLabel: 'DarkRide' } })],
      [inst({ name: 'maps' }), inst({ name: 'signed', npmPackage: null, signedBy: 'Acme' })],
    );
    const byName = Object.fromEntries(entries.map(e => [e.name, e]));
    expect(byName.maps.verification).toEqual({ status: 'verified', keyLabel: 'DarkRide' });
    expect(byName.signed.verification).toEqual({ status: 'signed', signedBy: 'Acme' });
  });
});

describe('status derivation', () => {
  const statusOf = (i: Partial<InstalledPlugin>) =>
    buildEntries([], [inst({ name: 'p', npmPackage: null, ...i })])[0].status;

  it('installed and enabled and loaded is installed', () => {
    expect(statusOf({})).toBe('installed');
  });
  it('disabled when not enabled', () => {
    expect(statusOf({ enabled: false })).toBe('disabled');
  });
  it('needs-restart when enabled but not loaded', () => {
    expect(statusOf({ enabled: true, loaded: false })).toBe('needs-restart');
  });
  it('update when a newer version exists', () => {
    expect(statusOf({ updateAvailable: true, latestVersion: '2.0.0' })).toBe('update');
  });
  it('error when the host recorded a lastError, even though it is also disabled', () => {
    expect(statusOf({ enabled: false, lastError: 'migration failed' })).toBe('error');
  });
  it('missing when the files are gone, ahead of error and disabled', () => {
    expect(statusOf({ installedVia: 'missing', enabled: false, lastError: 'x' })).toBe('missing');
  });
  it('keeps updateAvailable as its own flag so a disabled plugin can still be updated', () => {
    const e = buildEntries([], [inst({ name: 'p', npmPackage: null, enabled: false, updateAvailable: true, latestVersion: '2.0.0' })])[0];
    expect(e.status).toBe('disabled');
    expect(e.updateAvailable).toBe(true);
    expect(e.latestVersion).toBe('2.0.0');
  });
  it('takes latestVersion from the registry for an available plugin', () => {
    const e = buildEntries([reg({ name: 'maps', latestVersion: '3.1.0' })], [])[0];
    expect(e.latestVersion).toBe('3.1.0');
    expect(e.updateAvailable).toBe(false);
  });
});

describe('forTab', () => {
  const entries = buildEntries(
    [reg({ name: 'maps' }), reg({ name: 'frida-tools' })],
    [inst({ name: 'maps' }), inst({ name: 'local-dev', npmPackage: null, installedVia: 'workspace' })],
  );

  it('installed tab lists every installed plugin, including ones outside the registry', () => {
    expect(forTab(entries, 'installed').map(e => e.name).sort()).toEqual(['local-dev', 'maps']);
  });

  it('discover tab lists the whole registry, installed plugins included', () => {
    expect(forTab(entries, 'discover').map(e => e.name).sort()).toEqual(['frida-tools', 'maps']);
  });

  it('sorts plugins that need attention first, then by display name', () => {
    const es = buildEntries(
      [],
      [
        inst({ name: 'zeta', npmPackage: null }),
        inst({ name: 'alpha', npmPackage: null }),
        inst({ name: 'broken', npmPackage: null, lastError: 'boom', enabled: false }),
        inst({ name: 'upd', npmPackage: null, updateAvailable: true, latestVersion: '2.0.0' }),
      ],
    );
    expect(forTab(es, 'installed').map(e => e.name)).toEqual(['broken', 'upd', 'alpha', 'zeta']);
  });
});

describe('filters and search', () => {
  const entries = buildEntries(
    [reg({ name: 'maps', displayName: 'Maps Plugin', category: 'theme-parks', description: 'Map overlay' })],
    [
      inst({ name: 'maps' }),
      inst({ name: 'off', npmPackage: null, enabled: false }),
      inst({ name: 'bad', npmPackage: null, lastError: 'x', enabled: false }),
      inst({ name: 'gone', npmPackage: null, installedVia: 'missing' }),
      inst({ name: 'upd', npmPackage: null, updateAvailable: true, latestVersion: '2.0.0' }),
    ],
  );
  const installed = forTab(entries, 'installed');

  it('updates filter uses the flag, not the pill status', () => {
    expect(applyInstalledFilter(installed, 'updates').map(e => e.name)).toEqual(['upd']);
  });
  it('disabled filter lists user-disabled plugins but not errored ones', () => {
    expect(applyInstalledFilter(installed, 'disabled').map(e => e.name)).toEqual(['off']);
  });
  it('errors filter covers error and missing', () => {
    expect(applyInstalledFilter(installed, 'errors').map(e => e.name).sort()).toEqual(['bad', 'gone']);
  });
  it('all filter returns everything', () => {
    expect(applyInstalledFilter(installed, 'all')).toHaveLength(5);
  });
  it('countByFilter matches the filters', () => {
    expect(countByFilter(installed)).toEqual({ all: 5, updates: 1, disabled: 1, errors: 2 });
  });
  it('search matches display name, description, category and author, case-insensitively', () => {
    const maps = entries.find(e => e.name === 'maps')!;
    expect(matchesQuery(maps, 'MAPS PLUGIN')).toBe(true);
    expect(matchesQuery(maps, 'overlay')).toBe(true);
    expect(matchesQuery(maps, 'theme-parks')).toBe(true);
    expect(matchesQuery(maps, 'darkride')).toBe(true);
    expect(matchesQuery(maps, 'nonsense')).toBe(false);
  });
  it('an empty query matches everything', () => {
    expect(matchesQuery(entries[0], '')).toBe(true);
    expect(matchesQuery(entries[0], '   ')).toBe(true);
  });
});

describe('updates and dependencies', () => {
  it('updatableEntries returns installed plugins with updateAvailable, in list order', () => {
    const entries = buildEntries(
      [],
      [
        inst({ name: 'b', npmPackage: null, updateAvailable: true, latestVersion: '2.0.0' }),
        inst({ name: 'a', npmPackage: null, updateAvailable: true, latestVersion: '2.0.0' }),
        inst({ name: 'c', npmPackage: null }),
      ],
    );
    expect(updatableEntries(entries).map(e => e.name)).toEqual(['a', 'b']);
  });

  it('unmetDependencies lists dependencies that are not installed', () => {
    const entries = buildEntries(
      [reg({ name: 'overlay', dependencies: ['maps', 'base'] })],
      [inst({ name: 'maps' })],
    );
    const overlay = entries.find(e => e.name === 'overlay')!;
    expect(unmetDependencies(overlay, entries)).toEqual(['base']);
  });

  it('treats a dependency whose files are missing as unmet', () => {
    const entries = buildEntries(
      [reg({ name: 'overlay', dependencies: ['maps'] })],
      [inst({ name: 'maps', installedVia: 'missing' })],
    );
    const overlay = entries.find(e => e.name === 'overlay')!;
    expect(unmetDependencies(overlay, entries)).toEqual(['maps']);
  });

  it('returns an empty list when there are no dependencies', () => {
    const entries = buildEntries([reg({ name: 'maps' })], []);
    expect(unmetDependencies(entries[0], entries)).toEqual([]);
  });
});

describe('statusLabel', () => {
  const one = (i: Partial<InstalledPlugin> | null) =>
    buildEntries(i ? [] : [reg({ name: 'p' })], i ? [inst({ name: 'p', npmPackage: null, ...i })] : [])[0];

  it('is empty for an available plugin', () => {
    expect(statusLabel(one(null), 'discover')).toBeNull();
  });
  it('is empty for an ordinary installed plugin on the Installed tab', () => {
    expect(statusLabel(one({}), 'installed')).toBeNull();
  });
  it('says Installed on the Discover tab, so it reads differently from an available plugin', () => {
    expect(statusLabel(one({}), 'discover')).toBe('Installed');
  });
  it.each([
    ['Disabled', { enabled: false }],
    ['Update available', { updateAvailable: true, latestVersion: '2.0.0' }],
    ['Auto-disabled', { enabled: false, lastError: 'x' }],
    ['Files missing', { installedVia: 'missing' }],
    ['Restart to activate', { loaded: false }],
  ])('%s', (label, over) => {
    expect(statusLabel(one(over), 'installed')).toBe(label);
    expect(statusLabel(one(over), 'discover')).toBe(label);
  });
});

describe('needsConsent', () => {
  const status = (over: Partial<ScopeStatus>): ScopeStatus => ({
    state: 'no-scopes',
    manifestScopes: [],
    approvedScopes: null,
    added: [],
    removed: [],
    ...over,
  });
  it('is true for widened scopes', () => {
    expect(needsConsent(status({ state: 'drift-wider', manifestScopes: ['a'] }))).toBe(true);
  });
  it('is true for unconsented scopes that exist', () => {
    expect(needsConsent(status({ state: 'unconsented', manifestScopes: ['a'] }))).toBe(true);
  });
  it('is false when nothing is declared', () => {
    expect(needsConsent(status({ state: 'unconsented', manifestScopes: [] }))).toBe(false);
  });
  it.each(['approved', 'no-scopes', 'drift-narrower'] as const)('is false for %s', state => {
    expect(needsConsent(status({ state, manifestScopes: ['a'] }))).toBe(false);
  });
  it('is false with no status', () => {
    expect(needsConsent(undefined)).toBe(false);
  });
});

describe('primaryAction, canToggle, canUninstall', () => {
  const consent: ScopeStatus = { state: 'unconsented', manifestScopes: ['a'], approvedScopes: null, added: [], removed: [] };
  const entry = (r: boolean, i: Partial<InstalledPlugin> | null) =>
    buildEntries(r ? [reg({ name: 'p' })] : [], i ? [inst({ name: 'p', ...i })] : [])[0];

  it('install for an available plugin', () => {
    expect(primaryAction(entry(true, null), undefined)).toBe('install');
  });
  it('reinstall for missing files when the registry has the plugin', () => {
    expect(primaryAction(entry(true, { installedVia: 'missing' }), undefined)).toBe('reinstall');
  });
  it('nothing for missing files outside the registry', () => {
    expect(primaryAction(entry(false, { installedVia: 'missing' }), undefined)).toBeNull();
  });
  it('review beats update', () => {
    expect(primaryAction(entry(true, { updateAvailable: true, latestVersion: '2.0.0' }), consent)).toBe('review');
  });
  it('update when a newer version exists', () => {
    expect(primaryAction(entry(true, { updateAvailable: true, latestVersion: '2.0.0' }), undefined)).toBe('update');
  });
  it('nothing for a healthy plugin', () => {
    expect(primaryAction(entry(true, {}), undefined)).toBeNull();
  });

  it('only installed plugins with files can be toggled', () => {
    expect(canToggle(entry(true, null))).toBe(false);
    expect(canToggle(entry(true, { installedVia: 'missing' }))).toBe(false);
    expect(canToggle(entry(true, {}))).toBe(true);
  });

  it('marketplace and npm installs can be uninstalled, as can leftover state', () => {
    expect(canUninstall(entry(true, { installedVia: 'managed' }))).toBe(true);
    expect(canUninstall(entry(true, { installedVia: 'npm' }))).toBe(true);
    expect(canUninstall(entry(true, { installedVia: 'missing' }))).toBe(true);
  });
  it('workspace and manual plugins live on disk and cannot be uninstalled here', () => {
    expect(canUninstall(entry(false, { installedVia: 'workspace' }))).toBe(false);
    expect(canUninstall(entry(false, { installedVia: 'manual' }))).toBe(false);
    expect(canUninstall(entry(true, null))).toBe(false);
  });
});

describe('timeAgo', () => {
  const now = 1_700_000_000_000;
  it('says just now under a minute', () => {
    expect(timeAgo(now - 5_000, now)).toBe('just now');
    expect(timeAgo(now - 59_000, now)).toBe('just now');
  });
  it('counts minutes, hours and days', () => {
    expect(timeAgo(now - 60_000, now)).toBe('1m ago');
    expect(timeAgo(now - 59 * 60_000, now)).toBe('59m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 49 * 3_600_000, now)).toBe('2d ago');
  });
  it('treats a timestamp in the future as just now', () => {
    expect(timeAgo(now + 10_000, now)).toBe('just now');
  });
});
