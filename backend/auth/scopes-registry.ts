export interface ScopeMetadata {
  key: string;
  label: string;
  description: string;
  /** Category for grouping in UI pickers. */
  category: string;
}

const REGISTRY: ScopeMetadata[] = [
  // Devices
  { key: 'core.devices:read', label: 'Read devices', description: 'List connected devices and view their state.', category: 'Devices' },
  { key: 'core.devices:manage', label: 'Manage devices', description: 'Connect, disconnect, configure, and push binaries to devices.', category: 'Devices' },
  { key: 'core.devices:shell', label: 'Device shell access', description: 'Execute arbitrary shell commands on connected devices.', category: 'Devices' },

  // APKs
  { key: 'core.apk:read', label: 'Read APKs', description: 'Browse APK inventory, view analysis results and diffs.', category: 'APKs' },
  { key: 'core.apk:manage', label: 'Manage APKs', description: 'Upload APKs, trigger analysis, manage retention.', category: 'APKs' },

  // Automations
  { key: 'core.automations:read', label: 'Read automations', description: 'View automation definitions and session history.', category: 'Automations' },
  { key: 'core.automations:edit', label: 'Edit automations', description: 'Create, modify, and delete automation scripts.', category: 'Automations' },
  { key: 'core.automations:execute', label: 'Run automations', description: 'Execute automation scripts on devices.', category: 'Automations' },

  // Frida
  { key: 'core.frida:read', label: 'Read Frida state', description: 'View Frida scripts and session output.', category: 'Frida' },
  { key: 'core.frida:manage', label: 'Run Frida', description: 'Start frida-server, run Frida scripts, attach to apps.', category: 'Frida' },

  // Traffic
  { key: 'core.traffic:read', label: 'Read traffic', description: 'View captured HTTP/WebSocket traffic.', category: 'Traffic' },
  { key: 'core.traffic:manage', label: 'Manage traffic', description: 'Start/stop captures, edit capture rules.', category: 'Traffic' },

  // Proxies
  { key: 'core.proxies:read', label: 'Read proxies', description: 'View configured upstream proxies.', category: 'Proxies' },
  { key: 'core.proxies:manage', label: 'Manage proxies', description: 'Configure upstream proxy settings.', category: 'Proxies' },

  // Settings
  { key: 'core.settings:read', label: 'Read settings', description: 'View server configuration.', category: 'Settings' },
  { key: 'core.settings:write', label: 'Write settings', description: 'Modify server configuration.', category: 'Settings' },

  // Credentials
  { key: 'core.credentials:read', label: 'Read credentials', description: 'View stored credential entries (values remain hidden per-entry policy).', category: 'Credentials' },
  { key: 'core.credentials:write', label: 'Write credentials', description: 'Add, modify, delete credential entries.', category: 'Credentials' },

  // Background / plugins
  { key: 'core.jobs:manage', label: 'Manage jobs', description: 'Run, pause, and inspect scheduled jobs.', category: 'Background' },
  { key: 'core.plugins:manage', label: 'Manage plugins', description: 'Install, enable, disable, and configure plugins.', category: 'Background' },

  // AI
  { key: 'core.ai:chat', label: 'Use AI chat', description: 'Interact with the in-app AI Assistant.', category: 'AI' },

  // Integrations
  { key: 'mcp', label: 'Use MCP tools', description: 'Call DarkRide MCP tools on your behalf, with your current permissions.', category: 'Integrations' },

  // Admin (destructive — show last, treat with care)
  { key: 'core.host:shell', label: 'Host shell access', description: 'Execute commands on the DarkRide server host. Dangerous.', category: 'Admin' },
  { key: 'core.users:admin', label: 'Admin users', description: 'Create, edit, disable user accounts and their grants.', category: 'Admin' },
];

const PLUGIN_SCOPES = new Map<string, ScopeMetadata>();

export function registerPluginScopes(pluginName: string, scopes: ScopeMetadata[]): void {
  const prefix = `plugin.${pluginName}`;
  for (const s of scopes) {
    if (!s.key.startsWith(`${prefix}:`) && !s.key.startsWith(`${prefix}.`)) {
      throw new Error(
        `Plugin "${pluginName}" cannot register scope "${s.key}" — must start with "${prefix}:" or "${prefix}."`,
      );
    }
    const existing = PLUGIN_SCOPES.get(s.key);
    if (existing) {
      // Idempotent on identical metadata
      if (existing.label !== s.label || existing.description !== s.description || existing.category !== s.category) {
        throw new Error(`Scope "${s.key}" is already registered with different metadata`);
      }
      continue;
    }
    PLUGIN_SCOPES.set(s.key, s);
  }
}

/** Test-only helper. Not exported for general use. */
export function __resetPluginScopesForTests(): void {
  PLUGIN_SCOPES.clear();
}

export function listSupportedScopes(): ScopeMetadata[] {
  return [...REGISTRY, ...PLUGIN_SCOPES.values()];
}

export function getScopeMetadata(key: string): ScopeMetadata | undefined {
  return REGISTRY.find(s => s.key === key) ?? PLUGIN_SCOPES.get(key);
}

export function isSupportedScope(key: string): boolean {
  return REGISTRY.some(s => s.key === key) || PLUGIN_SCOPES.has(key);
}
