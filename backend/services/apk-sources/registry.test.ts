import { describe, it, expect } from 'vitest';
import { SourceRegistry } from './registry';
import type { RemoteApkSource } from './types';

function fakeSource(id: string): RemoteApkSource {
  return {
    id,
    label: id,
    isConfigured: () => true,
    defaultEnabled: () => false,
    async checkVersion() { return null; },
    async downloadApk() { return { success: false }; },
  };
}

describe('SourceRegistry', () => {
  it('registers and retrieves sources, preserving insertion order', () => {
    const reg = new SourceRegistry()
      .register(fakeSource('playstore'))
      .register(fakeSource('qq'));

    expect(reg.ids()).toEqual(['playstore', 'qq']);
    expect(reg.get('qq')?.id).toBe('qq');
    expect(reg.has('playstore')).toBe(true);
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.all()).toHaveLength(2);
  });

  it('replaces a source registered under the same id', () => {
    const reg = new SourceRegistry()
      .register(fakeSource('qq'))
      .register({ ...fakeSource('qq'), label: 'QQ v2' });
    expect(reg.all()).toHaveLength(1);
    expect(reg.get('qq')?.label).toBe('QQ v2');
  });
});
