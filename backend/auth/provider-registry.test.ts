import { describe, it, expect } from 'vitest';
import { listProviders, getProvider } from './provider-registry';

// MG-7: provider-registry coverage
describe('provider-registry', () => {
  it('lists the built-in core.local provider', () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(1);
    const local = providers.find(p => p.id === 'core.local');
    expect(local).toBeDefined();
    expect(local!.displayName).toBe('Password login');
    expect(local!.flow).toBe('credentials');
  });

  it('getProvider returns the provider by ID', () => {
    const local = getProvider('core.local');
    expect(local).toBeDefined();
    expect(local!.id).toBe('core.local');
  });

  it('getProvider returns undefined for non-existent ID', () => {
    expect(getProvider('nonexistent')).toBeUndefined();
  });
});
