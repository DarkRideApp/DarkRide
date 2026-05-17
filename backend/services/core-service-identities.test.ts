import { describe, it, expect, expectTypeOf } from 'vitest';
import { CORE_SERVICE_IDENTITIES, type CoreServiceKey } from './core-service-identities';

describe('core-service-identities', () => {
  it('exposes a frozen const list', () => {
    expect(CORE_SERVICE_IDENTITIES).toContain('apk-analyzer');
    expect(CORE_SERVICE_IDENTITIES).toContain('apk-diff-engine');
    expect(Object.isFrozen(CORE_SERVICE_IDENTITIES)).toBe(true);
  });

  it('derives a compile-time typed key', () => {
    const k: CoreServiceKey = 'apk-analyzer';
    expectTypeOf(k).toEqualTypeOf<'apk-analyzer' | 'apk-diff-engine'>();
  });
});
