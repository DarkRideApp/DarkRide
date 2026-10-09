/**
 * Pure model behind the Plugins workspace: joins the marketplace registry with
 * the installed-plugin list into one `PluginEntry` per plugin, derives a single
 * status for each, and provides the tab, filter and search selectors. No React,
 * no I/O, so the rules the UI depends on are unit-testable.
 */

export interface PluginVerification {
  status: 'verified' | 'unsigned' | 'untrusted';
  signedBy?: string;
  keyLabel?: string;
}

/** What GET /v1/plugins/marketplace returns for each plugin (plus `verification`). */
export interface RegistryPlugin {
  name: string;
  displayName: string;
  description: string;
  author: string;
  repo: string;
  latestVersion: string;
  category: string;
  license: string;
  npmPackage: string;
  source: string;
  installUrl?: string;
  verification?: PluginVerification;
  /** Other plugin names this plugin requires. */
  dependencies?: string[];
}

/**
 * What GET /v1/plugins/installed returns for each plugin: the plugin_state row
 * plus `loaded`, `metadata`, `updateAvailable` and `latestVersion`.
 */
export interface InstalledPlugin {
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  enabled: boolean;
  /** 'npm' | 'managed' | 'workspace' | 'manual', or 'missing' when the files have vanished. */
  installedVia: string;
  loaded: boolean;
  npmPackage?: string | null;
  signature?: string | null;
  signedBy?: string | null;
  /** Set by the host when a fatal error (e.g. a failed migration) auto-disabled the plugin. */
  lastError?: string | null;
  /** Present only while the plugin is loaded. */
  metadata?: { tools: unknown[]; pages: unknown[]; settings: unknown[] } | null;
  updateAvailable?: boolean;
  latestVersion?: string;
}

/** Shape of GET /v1/plugins/:name/scope-status. The fields sit at the top level of the body. */
export interface ScopeStatus {
  state: 'unconsented' | 'approved' | 'drift-wider' | 'drift-narrower' | 'no-scopes';
  manifestScopes: string[];
  approvedScopes: string[] | null;
  added: Array<{ key: string; metadata?: { label: string; description: string; category?: string } }>;
  removed: string[];
}

export type EntryVerification =
  | PluginVerification
  /** No verifier verdict (plugin is outside the registry), but state records who signed it. */
  | { status: 'signed'; signedBy: string };

export type PluginStatus =
  | 'available'
  | 'installed'
  | 'disabled'
  | 'update'
  | 'error'
  | 'missing'
  | 'needs-restart';

export type PluginTab = 'installed' | 'discover';
export type InstalledFilter = 'all' | 'updates' | 'disabled' | 'errors';

export interface PluginEntry {
  /** Runtime name when installed, registry name otherwise. Unique across entries. */
  name: string;
  displayName: string;
  description: string;
  author: string;
  /** Installed version, or null when not installed. */
  version: string | null;
  latestVersion: string | null;
  /** True when a newer version exists. Independent of `status`, so a disabled plugin can still be updated. */
  updateAvailable: boolean;
  category: string | null;
  license: string | null;
  repoUrl: string | null;
  source: string | null;
  installUrl: string | null;
  npmPackage: string | null;
  verification: EntryVerification | null;
  dependencies: string[];
  installedVia: string | null;
  enabled: boolean;
  loaded: boolean;
  lastError: string | null;
  /** Extension counts, known only while the plugin is loaded. */
  provides: { tools: number; pages: number; settings: number } | null;
  status: PluginStatus;
  registry: RegistryPlugin | null;
  installed: InstalledPlugin | null;
}

function repoUrlOf(repo: string | undefined): string | null {
  if (!repo) return null;
  return repo.startsWith('http') ? repo : `https://github.com/${repo}`;
}

function statusOf(inst: InstalledPlugin | null): PluginStatus {
  if (!inst) return 'available';
  if (inst.installedVia === 'missing') return 'missing';
  if (inst.lastError) return 'error';
  if (!inst.enabled) return 'disabled';
  if (inst.updateAvailable === true) return 'update';
  if (!inst.loaded) return 'needs-restart';
  return 'installed';
}

function toEntry(reg: RegistryPlugin | null, inst: InstalledPlugin | null): PluginEntry {
  const name = (inst?.name ?? reg?.name) as string;
  const md = inst?.loaded ? inst.metadata : null;
  return {
    name,
    displayName: reg?.displayName || name,
    description: reg?.description || inst?.description || '',
    author: reg?.author || inst?.author || '',
    version: inst?.version ?? null,
    latestVersion: inst?.latestVersion ?? reg?.latestVersion ?? null,
    updateAvailable: inst?.updateAvailable === true,
    category: reg?.category || null,
    license: reg?.license || null,
    repoUrl: repoUrlOf(reg?.repo),
    source: reg?.source ?? null,
    installUrl: reg?.installUrl ?? null,
    npmPackage: inst?.npmPackage || reg?.npmPackage || null,
    verification: reg?.verification ?? (inst?.signedBy ? { status: 'signed', signedBy: inst.signedBy } : null),
    dependencies: reg?.dependencies ?? [],
    installedVia: inst?.installedVia ?? null,
    enabled: inst?.enabled ?? false,
    loaded: inst?.loaded ?? false,
    lastError: inst?.lastError ?? null,
    provides: md ? { tools: md.tools.length, pages: md.pages.length, settings: md.settings.length } : null,
    status: statusOf(inst),
    registry: reg,
    installed: inst,
  };
}

/**
 * Join registry and installed plugins. An installed plugin matches a registry
 * record by npmPackage (what the backend uses for update detection), else by
 * name. A plugin listed by two sources appears once, the first source winning,
 * since the host refuses two plugins with one runtime name anyway.
 */
export function buildEntries(registry: RegistryPlugin[], installed: InstalledPlugin[]): PluginEntry[] {
  const byName = new Map<string, RegistryPlugin>();
  for (const r of registry) if (!byName.has(r.name)) byName.set(r.name, r);
  const unique = [...byName.values()];

  const byNpm = new Map<string, RegistryPlugin>();
  for (const r of unique) if (r.npmPackage && !byNpm.has(r.npmPackage)) byNpm.set(r.npmPackage, r);

  const claimed = new Set<RegistryPlugin>();
  const entries: PluginEntry[] = [];
  for (const inst of installed) {
    const match = (inst.npmPackage ? byNpm.get(inst.npmPackage) : undefined) ?? byName.get(inst.name) ?? null;
    if (match) claimed.add(match);
    entries.push(toEntry(match, inst));
  }
  // A record nobody matched is only a separate plugin if no installed plugin already
  // owns its name; otherwise it would sit next to that plugin with the same key.
  const installedNames = new Set(installed.map(i => i.name));
  for (const r of unique) if (!claimed.has(r) && !installedNames.has(r.name)) entries.push(toEntry(r, null));
  return entries;
}

function attentionRank(e: PluginEntry): number {
  if (e.status === 'error' || e.status === 'missing') return 0;
  if (e.updateAvailable) return 1;
  return 2;
}

const byDisplayName = (a: PluginEntry, b: PluginEntry) =>
  a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });

/**
 * Entries for a tab, in display order. Installed lists plugins that need
 * attention first; Discover is alphabetical.
 */
export function forTab(entries: PluginEntry[], tab: PluginTab): PluginEntry[] {
  if (tab === 'installed') {
    return entries
      .filter(e => e.installed)
      .sort((a, b) => attentionRank(a) - attentionRank(b) || byDisplayName(a, b));
  }
  return entries.filter(e => e.registry).sort(byDisplayName);
}

export function applyInstalledFilter(entries: PluginEntry[], filter: InstalledFilter): PluginEntry[] {
  switch (filter) {
    case 'updates':
      return entries.filter(e => e.updateAvailable);
    case 'disabled':
      return entries.filter(e => e.status === 'disabled');
    case 'errors':
      return entries.filter(e => e.status === 'error' || e.status === 'missing');
    default:
      return entries;
  }
}

export function countByFilter(entries: PluginEntry[]): Record<InstalledFilter, number> {
  return {
    all: entries.length,
    updates: applyInstalledFilter(entries, 'updates').length,
    disabled: applyInstalledFilter(entries, 'disabled').length,
    errors: applyInstalledFilter(entries, 'errors').length,
  };
}

export function matchesQuery(entry: PluginEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.displayName, entry.name, entry.description, entry.category, entry.author].some(
    field => !!field && field.toLowerCase().includes(q),
  );
}

/** Installed plugins with a newer version available, in display order. */
export function updatableEntries(entries: PluginEntry[]): PluginEntry[] {
  return forTab(entries, 'installed').filter(e => e.updateAvailable);
}

/** Dependencies the entry names that are not installed (a plugin whose files are missing does not count). */
export function unmetDependencies(entry: PluginEntry, entries: PluginEntry[]): string[] {
  const present = new Set(
    entries.filter(e => e.installed && e.installedVia !== 'missing').map(e => e.name),
  );
  return entry.dependencies.filter(d => !present.has(d));
}

const STATUS_LABELS: Partial<Record<PluginStatus, string>> = {
  disabled: 'Disabled',
  update: 'Update available',
  error: 'Auto-disabled',
  missing: 'Files missing',
  'needs-restart': 'Restart to activate',
};

/**
 * Text for the status pill, or null when the plugin's state needs no call-out.
 * An ordinary installed plugin is only labelled on Discover, where the label is
 * what tells it apart from one you could still install.
 */
export function statusLabel(entry: PluginEntry, tab: PluginTab): string | null {
  if (entry.status === 'installed') return tab === 'discover' ? 'Installed' : null;
  return STATUS_LABELS[entry.status] ?? null;
}

/** True when the plugin has AI scopes the user must approve (new, or widened since approval). */
export function needsConsent(status: ScopeStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === 'drift-wider') return true;
  return status.state === 'unconsented' && status.manifestScopes.length > 0;
}

export type PrimaryAction = 'install' | 'reinstall' | 'review' | 'update';

/** The one button a row leads with. Anything else is reachable from the detail drawer. */
export function primaryAction(entry: PluginEntry, scope: ScopeStatus | undefined): PrimaryAction | null {
  if (!entry.installed) return 'install';
  if (entry.status === 'missing') return entry.registry ? 'reinstall' : null;
  if (needsConsent(scope)) return 'review';
  if (entry.updateAvailable) return 'update';
  return null;
}

export function canToggle(entry: PluginEntry): boolean {
  return !!entry.installed && entry.status !== 'missing';
}

/** Marketplace and npm installs can be removed; so can leftover state for vanished files. Workspace and manual plugins live on disk. */
export function canUninstall(entry: PluginEntry): boolean {
  const via = entry.installedVia;
  return via === 'npm' || via === 'managed' || via === 'missing';
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
