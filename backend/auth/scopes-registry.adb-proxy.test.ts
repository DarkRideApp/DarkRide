import { describe, expect, it } from 'vitest';
import { getScopeMetadata, isSupportedScope } from './scopes-registry';

describe('ADB proxy scopes', () => {
  it.each(['core.adb-proxy:read', 'core.adb-proxy:manage'])('registers %s under Devices', (key) => {
    expect(isSupportedScope(key)).toBe(true);
    expect(getScopeMetadata(key)?.category).toBe('Devices');
  });

  it('says that approving a machine also needs device shell access', () => {
    expect(getScopeMetadata('core.adb-proxy:manage')?.description).toContain('Approving a machine also needs Device shell access');
    expect(getScopeMetadata('core.devices:shell')?.label).toBe('Device shell access');
  });
});
