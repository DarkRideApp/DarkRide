export interface PluginNavItem {
  group: string;
  label: string;
  path: string;
  icon: string;
  priority?: number;
  end?: boolean;
}

export interface PluginPageDef {
  path: string;
}

export interface PluginSetting {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  secret?: boolean;
  defaultValue?: string;
}

export interface PluginCommand {
  id: string;
  label: string;
  keywords?: string[];
  icon?: string;
}

export type UiSlotKind = 'container' | 'button-list' | 'nav-item-list';

export interface UiSlotDefinition {
  /** Fully-qualified slot id, typically `<pluginName>:<surface>:<position>`. */
  id: string;
  kind: UiSlotKind;
  /** Human-readable description shown in dev tooling / docs. */
  description: string;
}

export interface UiContainerContribution {
  /** Slot id to contribute to. */
  slot: string;
  /** Stable contribution id, typically `<pluginName>:<name>`. Used as React key. */
  id: string;
  /**
   * Optional sort priority (lower renders first). Ties broken by declaration
   * order. Use for coarse ordering where it matters.
   */
  priority?: number;
  /**
   * Key of the component as registered on the frontend plugin's contribution
   * component map via `pluginRegistry.registerContributionComponents(...)`.
   * Resolved at render time.
   */
  component: string;
}

export type UiContribution = UiContainerContribution; // union grows as typed kinds land
