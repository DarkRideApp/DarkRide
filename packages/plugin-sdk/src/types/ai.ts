import type { PluginAgent } from './agent';

export interface PluginAiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  context: string[];
  execute: (params: any) => Promise<unknown>;
}

export interface PluginAiContext {
  id: string;
  label: string;
  tools: string[];
}

export interface PluginAiTierInfo {
  name: string;
  sortOrder: number;
  isHardcoded: boolean;
  enabledModelCount: number;
}

export interface PluginAiApi {
  /**
   * Run AI as this plugin's system identity.
   * Pass { tier } to pick a specific tier (default: 'High').
   */
  agent(options?: { tier?: string }): PluginAgent;

  /**
   * Run AI on behalf of a human user who invoked this plugin's route.
   * Scopes = user's live scopes ∩ this plugin's manifest aiScopes.
   */
  forUser(userId: number, options?: { tier?: string }): PluginAgent;

  /**
   * List all configured tiers. Most plugins should use the shared
   * <TierPicker /> component instead — this is for unusual cases where
   * a plugin backend needs to make tier-aware decisions directly.
   */
  listTiers(): PluginAiTierInfo[];
}
