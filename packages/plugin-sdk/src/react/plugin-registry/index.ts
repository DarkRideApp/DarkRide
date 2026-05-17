import { useSyncExternalStore, useMemo } from 'react';
import type React from 'react';
import type { PluginNavItem, UiSlotDefinition, UiContribution } from '@darkrideapp/plugin-sdk';
import type { ProtocolDecoder } from './decoder-types';
import type {
  ContributionComponentMap,
  ButtonContribution,
  NavItemContribution,
  ButtonListItem,
  NavItemListItem,
  PluginPageEntry,
  PluginCommandEntry,
  ResolvedContribution,
} from './types';

/**
 * Plugin frontend registry — singleton.
 *
 * INVARIANT: every public method that returns plugin-owned items must go
 * through `filterEnabled()`. Direct access to the internal arrays bypasses
 * the disabled-plugin filter and will leak disabled plugins' contributions
 * to consumers. See test file: every getter has a "filters disabled plugins"
 * test asserting this.
 *
 * Adding a new getter? Add an entry to `getters apply disabled-plugin filter`
 * test suite proving your getter respects the disabled set.
 */
class PluginFrontendRegistryImpl {
  private navItems: Array<PluginNavItem & { plugin: string }> = [];
  private pages: Array<PluginPageEntry & { plugin: string }> = [];
  private commands: Array<PluginCommandEntry & { plugin: string }> = [];
  private decoders: Array<ProtocolDecoder & { plugin: string }> = [];
  private disabledPlugins = new Set<string>();
  private uiSlots: Array<UiSlotDefinition & { plugin: string }> = [];
  private uiContributions: Array<UiContribution & { plugin: string; order: number }> = [];
  private contributionComponents = new Map<string, ContributionComponentMap>();
  private contributionOrderCounter = 0;
  private buttonContribs: Array<ButtonContribution & { plugin: string; order: number }> = [];
  private navItemContribs: Array<NavItemContribution & { plugin: string; order: number }> = [];
  private typedOrderCounter = 0;
  private settings: Array<{ pluginName: string; label: string; component: React.ComponentType; order: number }> = [];

  // ─── Reactivity ─────────────────────────────────────────────────────────────
  // Components subscribe via useSyncExternalStore. Every mutation must call
  // notify() so subscribers can schedule a re-render.
  //
  // We expose a monotonically-incrementing version number as the snapshot.
  // This lets useSyncExternalStore detect changes without requiring that
  // derived arrays (from getNavItemContributions etc.) produce stable
  // references — those always return new arrays, which would otherwise fool
  // React into an infinite re-render loop.

  private subscribers = new Set<() => void>();
  private version = 0;
  private disabledLoaded = false;

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * Whether the disabled-plugin list has been loaded from the server. False
   * until the first `setDisabledPlugins()` call. Components that render
   * plugin contributions on the initial page can gate on this to avoid the
   * brief flash of disabled plugin items between mount and first fetch.
   */
  isDisabledLoaded(): boolean {
    return this.disabledLoaded;
  }

  private notify(): void {
    this.version++;
    for (const cb of this.subscribers) cb();
  }

  /**
   * Filter an array of plugin-owned items to exclude items from disabled plugins.
   * The single source of truth for the disabled-plugin filter — every getter
   * MUST use this. Direct access to the internal arrays bypasses the filter
   * and is a bug.
   */
  private filterEnabled<T extends { plugin: string }>(items: readonly T[]): T[] {
    return items.filter(item => !this.disabledPlugins.has(item.plugin));
  }

  // ────────────────────────────────────────────────────────────────────────────

  setDisabledPlugins(names: string[]): void {
    const next = new Set(names);
    // Equality short-circuit: prevents an infinite re-render loop when
    // AuthenticatedApp re-renders, recreates wsManager, refires the fetch
    // useEffect, and calls this with the same disabled list every time.
    // We must still notify on the first call to flip the disabledLoaded gate.
    if (
      this.disabledLoaded
      && next.size === this.disabledPlugins.size
      && [...next].every(n => this.disabledPlugins.has(n))
    ) {
      return;
    }
    this.disabledPlugins = next;
    this.disabledLoaded = true;
    this.notify();
  }

  registerNav(plugin: string, items: PluginNavItem[]): void {
    for (const item of items) {
      this.navItems.push({ ...item, plugin });
    }
    this.notify();
  }

  registerPages(plugin: string, entries: PluginPageEntry[]): void {
    for (const entry of entries) {
      this.pages.push({ ...entry, plugin });
    }
    this.notify();
  }

  registerCommands(plugin: string, cmds: PluginCommandEntry[]): void {
    for (const cmd of cmds) {
      this.commands.push({ ...cmd, plugin });
    }
    this.notify();
  }

  registerDecoders(plugin: string, decoders: ProtocolDecoder[]): void {
    for (const decoder of decoders) {
      this.decoders.push({ ...decoder, plugin });
    }
    this.notify();
  }

  getNavItems(): Array<PluginNavItem & { plugin: string }> {
    return this.filterEnabled(this.navItems);
  }

  getPages(): Array<PluginPageEntry & { plugin: string }> {
    return this.filterEnabled(this.pages);
  }

  getCommands(): Array<PluginCommandEntry & { plugin: string }> {
    return this.filterEnabled(this.commands);
  }

  getDecoders(): ProtocolDecoder[] {
    return this.filterEnabled(this.decoders);
  }

  registerUiSlots(plugin: string, defs: UiSlotDefinition[]): void {
    for (const def of defs) this.uiSlots.push({ ...def, plugin });
    this.notify();
  }

  registerUiContributions(plugin: string, contribs: UiContribution[]): void {
    for (const c of contribs) this.uiContributions.push({ ...c, plugin, order: this.contributionOrderCounter++ });
    this.notify();
  }

  registerContributionComponents(plugin: string, map: ContributionComponentMap): void {
    this.contributionComponents.set(plugin, { ...(this.contributionComponents.get(plugin) ?? {}), ...map });
    this.notify();
  }

  getAllSlots(): Array<UiSlotDefinition & { plugin: string }> {
    return this.filterEnabled(this.uiSlots);
  }

  /**
   * Return raw (unresolved) contributions for a slot, filtered to enabled
   * plugins. Used for back-compat shims where contributions carry arbitrary
   * extra fields (e.g. `label`, `path`) rather than the component-map key
   * used by the standard typed-contribution path.
   */
  getRawSlotContributions(slotId: string): Array<UiContribution & { plugin: string; order: number }> {
    return this.filterEnabled(this.uiContributions)
      .filter(c => c.slot === slotId)
      .sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      });
  }

  getSlotContributions(slotId: string): ResolvedContribution[] {
    const matches = this.filterEnabled(this.uiContributions)
      .filter(c => c.slot === slotId)
      .sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      });
    const resolved: ResolvedContribution[] = [];
    for (const c of matches) {
      const compMap = this.contributionComponents.get(c.plugin);
      const Component = compMap?.[c.component];
      if (!Component) {
        console.warn(
          `[plugin-registry] Contribution "${c.id}" from plugin "${c.plugin}" references ` +
          `component "${c.component}" which is not registered. Did you call ` +
          `pluginRegistry.registerContributionComponents('${c.plugin}', { ${c.component}: ... })?`,
        );
        continue;
      }
      resolved.push({ slot: c.slot, id: c.id, priority: c.priority ?? 0, component: Component, plugin: c.plugin });
    }
    return resolved;
  }

  registerButtonContribution(plugin: string, c: ButtonContribution): void {
    this.buttonContribs.push({ ...c, plugin, order: this.typedOrderCounter++ });
    this.notify();
  }

  registerNavItemContribution(plugin: string, c: NavItemContribution): void {
    this.navItemContribs.push({ ...c, plugin, order: this.typedOrderCounter++ });
    this.notify();
  }

  getButtonContributions(slotId: string): Array<ButtonListItem & { plugin: string }> {
    return this.filterEnabled(this.buttonContribs)
      .filter(c => c.slot === slotId)
      .sort((a, b) => {
        const pa = a.priority ?? 0, pb = b.priority ?? 0;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      })
      .map(({ plugin, order: _order, slot: _slot, ...rest }) => ({ ...rest, plugin }));
  }

  getNavItemContributions(slotId: string): Array<NavItemListItem & { plugin: string }> {
    return this.filterEnabled(this.navItemContribs)
      .filter(c => c.slot === slotId)
      .sort((a, b) => {
        const pa = a.priority ?? 0, pb = b.priority ?? 0;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      })
      .map(({ plugin, order: _order, slot: _slot, ...rest }) => ({ ...rest, plugin }));
  }

  registerSettings(plugin: string, opts: { label: string; component: React.ComponentType; order?: number }): void {
    // Replace any prior entry for the same plugin.
    this.settings = this.settings.filter(s => s.pluginName !== plugin);
    this.settings.push({
      pluginName: plugin,
      label: opts.label,
      component: opts.component,
      order: opts.order ?? 0,
    });
    this.notify();
  }

  getSettings(): Array<{ pluginName: string; label: string; component: React.ComponentType; order: number }> {
    return this.settings
      .filter(s => !this.disabledPlugins.has(s.pluginName))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }
}

// Singleton — plugins register at import time
export const pluginRegistry = new PluginFrontendRegistryImpl();

// Re-export the class for testing
export { PluginFrontendRegistryImpl as PluginFrontendRegistry };

/** Reset all internal singleton state. For tests only. */
export function __resetPluginRegistry(): void {
  (pluginRegistry as any).navItems = [];
  (pluginRegistry as any).pages = [];
  (pluginRegistry as any).commands = [];
  (pluginRegistry as any).decoders = [];
  (pluginRegistry as any).disabledPlugins = new Set();
  (pluginRegistry as any).uiSlots = [];
  (pluginRegistry as any).uiContributions = [];
  (pluginRegistry as any).contributionComponents = new Map();
  (pluginRegistry as any).contributionOrderCounter = 0;
  (pluginRegistry as any).buttonContribs = [];
  (pluginRegistry as any).navItemContribs = [];
  (pluginRegistry as any).typedOrderCounter = 0;
  (pluginRegistry as any).settings = [];
  (pluginRegistry as any).disabledLoaded = false;
}

/**
 * Subscribe to the plugin registry in a React component.
 *
 * Every mutation on pluginRegistry (registerNav, setDisabledPlugins, etc.)
 * notifies subscribers, which causes useSyncExternalStore to schedule a
 * re-render. This is the correct way to read from the registry in components
 * that need to stay in sync with enable/disable state changes.
 *
 * Internally, the snapshot is the registry's version counter (a number).
 * This avoids infinite re-render loops that would occur if we snapshotted
 * derived arrays directly (arrays from filter/sort/map are always new
 * references and would fool useSyncExternalStore into looping forever).
 * The selector runs in a useMemo keyed on the version, so it only recomputes
 * when the registry actually mutates.
 *
 * @example
 *   const items = usePluginRegistrySnapshot(r => r.getNavItemContributions('my:slot'));
 */
export function usePluginRegistrySnapshot<T>(
  selector: (registry: PluginFrontendRegistryImpl) => T,
): T {
  const version = useSyncExternalStore(
    cb => pluginRegistry.subscribe(cb),
    () => pluginRegistry.getVersion(),
    () => pluginRegistry.getVersion(),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => selector(pluginRegistry), [version]);
}
