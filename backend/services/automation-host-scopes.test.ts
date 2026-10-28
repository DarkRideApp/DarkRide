import { describe, it, expect } from 'vitest';
import { HOST_CALLS, isScriptCallable, requiredHostScope } from './automation-host-scopes';
import { DeviceAPIImpl } from './device-api';
import { DeviceHTTPImpl, NoopDeviceHTTP } from './device-http';
import { DeviceFridaImpl, NoopDeviceFrida } from './device-frida';
import { HttpAPIImpl } from './http-api';

// What a script may call: the documented API (shared/types/automation.ts) plus `takeScreenshot`, an alias of `screenshot`.
// Anything else on a host object is the runner's.
const DOCUMENTED: Record<string, string[]> = {
  device: [
    'click', 'longClick', 'setText', 'getText', 'exists', 'waitFor', 'waitForAndClick', 'existsAny', 'clickAny',
    'scroll', 'scrollToElement', 'getDOM', 'updateDOM', 'screenshot', 'takeScreenshot', 'getAppInfo', 'startApp', 'stopApp',
    'pressKey', 'swipe', 'tapAt', 'deviceInfo', 'getCurrentAppId', 'getWebViewInfo', 'pressButton', 'gatherDOM', 'searchDOM',
    'httpGet', 'httpPost', 'getCredentials', 'setProxy', 'setTlsProfile', 'sleep',
  ],
  'device.http': ['hook', 'hookRequest', 'hookResponse', 'unhook', 'unhookAll', 'intercept', 'useClientCert'],
  'device.frida': ['run', 'inject', 'loadScript', 'getMessages', 'send', 'stop'],
  http: ['get', 'post', 'put', 'delete', 'patch', 'setProxy', 'setTlsProfile'],
  documentStore: ['getDoc', 'putDoc'],
};

// Methods that exist on the same objects only so the runner can wire and clean up a run.
const HOST_ONLY: Record<string, string[]> = {
  device: [
    'getDeviceId', 'getExecutionLog', 'setRulesRunner', 'setProxyHandler', 'setTlsProfileHandler', 'setFridaScriptResolver',
    'setCachedDOM', 'clearCachedDOM', 'setATXFree', 'wakeAndUnlock', 'callBridge', 'logCall', 'invalidateDOMCache',
    'mergeDOM', 'collectTexts', 'collectLeafNodes', 'findDOMMatch', 'findMatchingNodes', 'findFirstMatchingNode', 'matchesSelector',
  ],
  'device.http': [],
  'device.frida': ['cleanup'],
  http: ['dispose', 'buildDispatcher', 'send'],
  documentStore: [],
};

describe('requiredHostScope', () => {
  it('asks for the credentials read scope before a script reads stored credentials', () => {
    expect(requiredHostScope('device', 'getCredentials')).toBe('core.credentials:read');
  });

  it('asks for the proxies scope before a script changes the proxy, on both namespaces', () => {
    expect(requiredHostScope('device', 'setProxy')).toBe('core.proxies:manage');
    expect(requiredHostScope('http', 'setProxy')).toBe('core.proxies:manage');
  });

  it('asks for the traffic scope before a script hooks, rewrites or adds a client certificate to traffic', () => {
    for (const method of ['hook', 'hookRequest', 'hookResponse', 'intercept', 'useClientCert']) {
      expect(requiredHostScope('device.http', method), method).toBe('core.traffic:manage');
    }
  });

  it('asks for the Frida scope before a script runs, injects, loads, messages or stops Frida', () => {
    for (const method of ['run', 'inject', 'loadScript', 'send', 'stop']) {
      expect(requiredHostScope('device.frida', method), method).toBe('core.frida:manage');
    }
  });

  it('asks only for the read scope before a script reads Frida output', () => {
    expect(requiredHostScope('device.frida', 'getMessages')).toBe('core.frida:read');
  });

  it('leaves outbound HTTP, ordinary device calls and removing the script\'s own hooks open', () => {
    expect(requiredHostScope('device', 'httpGet')).toBeUndefined();
    expect(requiredHostScope('device', 'httpPost')).toBeUndefined();
    expect(requiredHostScope('http', 'get')).toBeUndefined();
    expect(requiredHostScope('http', 'post')).toBeUndefined();
    expect(requiredHostScope('device', 'click')).toBeUndefined();
    expect(requiredHostScope('documentStore', 'getDoc')).toBeUndefined();
    expect(requiredHostScope('device.http', 'unhook')).toBeUndefined();
    expect(requiredHostScope('device.http', 'unhookAll')).toBeUndefined();
  });

  it('does not let a method name on another namespace pick up a gate', () => {
    expect(requiredHostScope('device.http', 'getCredentials')).toBeUndefined();
    expect(requiredHostScope('documentStore', 'setProxy')).toBeUndefined();
    expect(requiredHostScope('device', 'run')).toBeUndefined();
    expect(requiredHostScope('device', 'hook')).toBeUndefined();
  });

  it('ignores names that only exist on Object.prototype', () => {
    expect(requiredHostScope('device', 'constructor')).toBeUndefined();
    expect(requiredHostScope('device', 'toString')).toBeUndefined();
    expect(requiredHostScope('device', '__proto__')).toBeUndefined();
  });
});

describe('isScriptCallable', () => {
  const documented = Object.entries(DOCUMENTED).flatMap(([target, methods]) => methods.map((m) => [target, m] as const));
  const hostOnly = Object.entries(HOST_ONLY).flatMap(([target, methods]) => methods.map((m) => [target, m] as const));

  it.each(documented)('lets a script call the documented %s.%s', (target, method) => {
    expect(isScriptCallable(target, method)).toBe(true);
  });

  it.each(hostOnly)('refuses %s.%s, which exists only for the runner', (target, method) => {
    expect(isScriptCallable(target, method)).toBe(false);
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', '__defineGetter__', '__lookupGetter__'])(
    'refuses %s, which every object inherits',
    (name) => {
      for (const target of Object.keys(DOCUMENTED)) expect(isScriptCallable(target, name), `${target}.${name}`).toBe(false);
    },
  );

  it('refuses a method name on a namespace that does not have it', () => {
    expect(isScriptCallable('device.http', 'click')).toBe(false);
    expect(isScriptCallable('device.frida', 'hook')).toBe(false);
    expect(isScriptCallable('http', 'getCredentials')).toBe(false);
    expect(isScriptCallable('documentStore', 'get')).toBe(false);
  });

  it('refuses an unknown namespace and a different spelling', () => {
    expect(isScriptCallable('tools', 'anything')).toBe(false);
    expect(isScriptCallable('Device', 'click')).toBe(false);
    expect(isScriptCallable('device', 'Click')).toBe(false);
    expect(isScriptCallable('', '')).toBe(false);
  });
});

describe('HOST_CALLS', () => {
  const classes: Record<string, Array<{ prototype: object }>> = {
    device: [DeviceAPIImpl],
    'device.http': [DeviceHTTPImpl, NoopDeviceHTTP],
    'device.frida': [DeviceFridaImpl, NoopDeviceFrida],
    http: [HttpAPIImpl],
  };
  const protoMethods = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== 'constructor');
  const listed = (target: string) => Object.keys(HOST_CALLS[target] ?? {});

  // The sandbox exposes whatever a class has, so a new method is callable from a script the day it is added unless it is
  // classified here. Fail the build until someone decides which side it is on.
  it.each(Object.entries(classes).flatMap(([target, list]) => list.flatMap((cls) => protoMethods(cls).map((m) => [target, cls, m] as const))))(
    '%s.%s is classified as callable or runner-only',
    (target, _cls, method) => {
      const known = listed(target).includes(method) || HOST_ONLY[target].includes(method);
      expect(known, `${target}.${method} is new: add it to HOST_CALLS if scripts should call it, or to HOST_ONLY in this test`).toBe(true);
    },
  );

  it.each(Object.entries(classes).flatMap(([target, list]) => listed(target).map((m) => [target, m, list] as const)))(
    '%s.%s still exists on the class a script reaches it through',
    (_target, method, list) => {
      expect(typeof (list[0].prototype as any)[method]).toBe('function');
    },
  );

  it('keeps the callable list equal to what is documented', () => {
    for (const [target, methods] of Object.entries(DOCUMENTED)) {
      expect(listed(target).sort(), target).toEqual([...methods].sort());
    }
  });

  it('lists nothing as both callable and runner-only', () => {
    for (const [target, methods] of Object.entries(HOST_ONLY)) {
      expect(methods.filter((m) => listed(target).includes(m)), target).toEqual([]);
    }
  });
});
