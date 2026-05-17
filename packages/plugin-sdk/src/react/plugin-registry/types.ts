import type React from 'react';
import type { PluginCommand } from '@darkrideapp/plugin-sdk';

export type ContributionComponentMap = Record<string, React.ComponentType<any>>;

export interface ButtonListItem {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  priority?: number;
  requiredScope?: string;
}

export interface NavItemListItem {
  id: string;
  label: string;
  to: string;
  icon?: string;
  badge?: string | number;
  priority?: number;
  requiredScope?: string;
  end?: boolean;
}

export interface ButtonContribution extends ButtonListItem {
  slot: string;
}

export interface NavItemContribution extends NavItemListItem {
  slot: string;
}

export interface ResolvedContribution {
  slot: string;
  id: string;
  priority: number;
  component: React.ComponentType<any>;
  plugin: string;
}

export interface PluginPageEntry {
  path: string;
  component: React.ComponentType<any>;
}

export interface PluginCommandEntry extends PluginCommand {
  action: () => void;
}
