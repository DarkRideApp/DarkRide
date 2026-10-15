import { describe, it, expect } from 'vitest';
import { GATED_HOST_CALLS, requiredHostScope } from './automation-host-scopes';
import { DeviceAPIImpl } from './device-api';
import { HttpAPIImpl } from './http-api';

describe('requiredHostScope', () => {
  it('asks for the credentials read scope before a script reads stored credentials', () => {
    expect(requiredHostScope('device', 'getCredentials')).toBe('core.credentials:read');
  });

  it('asks for the proxies scope before a script changes the proxy, on both namespaces', () => {
    expect(requiredHostScope('device', 'setProxy')).toBe('core.proxies:manage');
    expect(requiredHostScope('http', 'setProxy')).toBe('core.proxies:manage');
  });

  it('leaves outbound HTTP and ordinary device calls open', () => {
    expect(requiredHostScope('device', 'httpGet')).toBeUndefined();
    expect(requiredHostScope('device', 'httpPost')).toBeUndefined();
    expect(requiredHostScope('http', 'get')).toBeUndefined();
    expect(requiredHostScope('http', 'post')).toBeUndefined();
    expect(requiredHostScope('device', 'click')).toBeUndefined();
    expect(requiredHostScope('documentStore', 'getDoc')).toBeUndefined();
  });

  it('does not let a method name on another namespace pick up a gate', () => {
    expect(requiredHostScope('device.http', 'getCredentials')).toBeUndefined();
    expect(requiredHostScope('documentStore', 'setProxy')).toBeUndefined();
  });

  it('ignores names that only exist on Object.prototype', () => {
    expect(requiredHostScope('device', 'constructor')).toBeUndefined();
    expect(requiredHostScope('device', 'toString')).toBeUndefined();
    expect(requiredHostScope('device', '__proto__')).toBeUndefined();
  });
});

describe('GATED_HOST_CALLS', () => {
  const classes: Record<string, { prototype: object }> = { device: DeviceAPIImpl, http: HttpAPIImpl };

  // The sandbox exposes whatever the class has, so a renamed method would silently stop being gated.
  it.each(Object.keys(GATED_HOST_CALLS))('%s still exists on the class a script reaches it through', (key) => {
    const [target, method] = key.split('.');
    expect(typeof (classes[target].prototype as any)[method]).toBe('function');
  });
});
