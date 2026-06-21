import { describe, it, expect } from 'vitest';
import { createSourceRegistry } from './index';

/**
 * Integration guard: the default registry must wire up every built-in source.
 * The Sources panel, Check-stores, and store links are all registry-driven, so
 * a source that isn't registered here simply vanishes from the UI — this test
 * fails loudly if one is dropped or mis-ordered.
 */
describe('createSourceRegistry', () => {
  // setDatabase only stores the handle at build time (no queries run), so a
  // bare stub is enough to construct the registry.
  const reg = createSourceRegistry({} as any);

  it('registers all built-in sources in display order', () => {
    expect(reg.ids()).toEqual(['playstore', 'apkpure', 'qq', 'huawei', 'xiaomi']);
  });

  it('carries the right labels', () => {
    expect(reg.get('huawei')?.label).toBe('Huawei AppGallery');
    expect(reg.get('apkpure')?.label).toBe('APKPure');
    expect(reg.get('xiaomi')?.label).toBe('Xiaomi GetApps (小米应用商店)');
  });

  it('exposes storeUrl for the package-keyed stores and omits it for Huawei (id-keyed listing)', () => {
    expect(typeof reg.get('apkpure')?.storeUrl).toBe('function');
    expect(typeof reg.get('xiaomi')?.storeUrl).toBe('function');
    expect(reg.get('huawei')?.storeUrl).toBeUndefined();
  });
});
