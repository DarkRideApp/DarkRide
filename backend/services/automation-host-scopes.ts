const TRAFFIC = 'core.traffic:manage';
const FRIDA = 'core.frida:manage';

/**
 * Every host call a script can make, and the scope its author must hold (`null`: none). Keys are the namespace the
 * sandbox dispatches on, then the method. A call that is not listed is refused: the isolate can name any function a host
 * object has, including the ones that exist only so the runner can wire up and clean up a run, and a public method added
 * later would otherwise be reachable from a script the day it lands. The scopes match what the same operation needs over REST.
 *
 * Outbound HTTP (`httpGet`, `httpPost`, `http.get` and the rest) is deliberately open: it is what an automation is for.
 * Removing a script's own hooks (`unhook`, `unhookAll`) is open too, since it only undoes what the script registered.
 */
export const HOST_CALLS: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  device: {
    click: null, longClick: null, setText: null, getText: null, exists: null, waitFor: null, waitForAndClick: null,
    existsAny: null, clickAny: null, scroll: null, scrollToElement: null, getDOM: null, updateDOM: null, screenshot: null,
    takeScreenshot: null, getAppInfo: null, startApp: null, stopApp: null, pressKey: null, swipe: null, tapAt: null,
    deviceInfo: null, getCurrentAppId: null, getWebViewInfo: null, pressButton: null, gatherDOM: null, searchDOM: null,
    httpGet: null, httpPost: null, setTlsProfile: null, sleep: null,
    getCredentials: 'core.credentials:read',
    setProxy: 'core.proxies:manage',
  },
  'device.http': {
    hook: TRAFFIC, hookRequest: TRAFFIC, hookResponse: TRAFFIC, intercept: TRAFFIC, useClientCert: TRAFFIC,
    unhook: null, unhookAll: null,
  },
  'device.frida': {
    run: FRIDA, inject: FRIDA, loadScript: FRIDA, send: FRIDA, stop: FRIDA,
    getMessages: 'core.frida:read',
  },
  http: {
    get: null, post: null, put: null, delete: null, patch: null, setTlsProfile: null,
    setProxy: 'core.proxies:manage',
  },
  documentStore: {
    getDoc: null, putDoc: null,
  },
};

function entry(target: string, method: string): string | null | undefined {
  if (!Object.hasOwn(HOST_CALLS, target)) return undefined;
  const methods = HOST_CALLS[target];
  return Object.hasOwn(methods, method) ? methods[method] : undefined;
}

/** Whether a script may make this call at all. Names every object inherits (`constructor`, `toString`) are not listed, so they are refused. */
export function isScriptCallable(target: string, method: string): boolean {
  return entry(target, method) !== undefined;
}

/** The scope the script's author must hold for this call, or undefined when it needs none (or is not callable). */
export function requiredHostScope(target: string, method: string): string | undefined {
  return entry(target, method) ?? undefined;
}
