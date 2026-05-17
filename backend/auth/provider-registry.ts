export interface ProviderInfo {
  id: string;
  displayName: string;
  flow: 'credentials' | 'redirect';
  credentialFields?: Array<{
    name: string;
    label: string;
    type: 'text' | 'password' | 'email';
  }>;
}

const providers = new Map<string, ProviderInfo>();

export function registerProvider(info: ProviderInfo): void {
  providers.set(info.id, info);
}

export function getProvider(id: string): ProviderInfo | undefined {
  return providers.get(id);
}

export function listProviders(): ProviderInfo[] {
  return Array.from(providers.values());
}

// Register the built-in local provider
registerProvider({
  id: 'core.local',
  displayName: 'Password login',
  flow: 'credentials',
  credentialFields: [
    { name: 'username', label: 'Username', type: 'text' },
    { name: 'password', label: 'Password', type: 'password' },
  ],
});
