/**
 * Secure automation sandbox using isolated-vm (V8 isolates).
 *
 * Replaces Node's `vm` module which has known sandbox escapes.
 * All host object method calls (DeviceAPI, crypto, timers, etc.) cross
 * the isolate boundary via ivm.Reference callbacks — the automation code
 * cannot access Node's `process`, `require`, or any host objects directly.
 */
import ivm from 'isolated-vm';
import crypto from 'crypto';
import { createLoggers } from '../logs';
import type { DeviceAPI, HttpAPI } from '../../shared/types/automation';

const { log } = createLoggers('automation-sandbox');

/** Memory limit for each automation isolate (MB). */
const ISOLATE_MEMORY_LIMIT = 128;

/**
 * Produce a structured-clone-safe shallow-recursive copy of `obj`.
 * Strips functions (ivm.ExternalCopy rejects them) but preserves plain
 * objects, arrays, and primitives. Used to sanitize hook request/response
 * objects before passing them into the isolate.
 */
function sanitizeForCopy(obj: any, seen: WeakSet<object> = new WeakSet()): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return undefined; // break cycles
  seen.add(obj);
  if (Array.isArray(obj)) {
    return obj.map((v) => (typeof v === 'function' ? undefined : sanitizeForCopy(v, seen)));
  }
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'function') continue;
    out[key] = sanitizeForCopy(val, seen);
  }
  return out;
}

/**
 * DOM utility functions — pure JavaScript, safe to eval inside the isolate.
 * Duplicated here to avoid importing the TypeScript module.
 */
const DOM_UTILS_SOURCE = `
const dom = {
  findAll(root, predicate) {
    const results = [];
    if (predicate(root)) results.push(root);
    for (const child of root.children) results.push(...dom.findAll(child, predicate));
    return results;
  },
  find(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
      const match = dom.find(child, predicate);
      if (match) return match;
    }
    return null;
  },
  flatten(root) {
    const results = [root];
    for (const child of root.children) results.push(...dom.flatten(child));
    return results;
  },
  filter(nodes, predicate) { return nodes.filter(predicate); },
  getCenter(node) {
    const [x1, y1, x2, y2] = node.bounds;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  },
  getSize(node) {
    const [x1, y1, x2, y2] = node.bounds;
    return { width: x2 - x1, height: y2 - y1 };
  },
  getAllText(root) {
    const texts = [];
    if (root.text) texts.push(root.text);
    if (root.description) texts.push(root.description);
    for (const child of root.children) texts.push(...dom.getAllText(child));
    return texts;
  },
};
`;

/**
 * Handle returned by executeInSandbox when invoked with { keepAlive: true }.
 * Caller MUST call dispose() when the sandbox is no longer needed, otherwise
 * the isolate and any registered callbacks leak until the host process exits.
 */
export interface SandboxHandle {
  dispose: () => void;
}

export interface ExecuteInSandboxOptions {
  /**
   * Keep the isolate alive after the script returns so registered callbacks
   * (e.g. traffic hooks from device.http.hookRequest) can still fire.
   * Caller owns the returned handle and MUST call dispose() to clean up.
   */
  keepAlive?: boolean;
  /**
   * AbortSignal to forcefully terminate the isolate from outside. When the
   * signal fires, the isolate is disposed (killing all in-flight JS) and
   * the execute() promise rejects with an AbortError. Used by the runner's
   * "stop automation" surface.
   */
  signal?: AbortSignal;
}

/**
 * Execute compiled automation code inside a V8 isolate.
 *
 * The isolate has NO access to Node.js APIs. All interactions with the host
 * (device operations, crypto, timers, console) go through ivm.Reference
 * callbacks that cross the isolate boundary.
 *
 * With `keepAlive: true`, returns a SandboxHandle — the isolate is NOT
 * disposed automatically. Used by capture rules where hook callbacks must
 * outlive the script's top-level execution.
 */
export async function executeInSandbox(
  compiledCode: string,
  deviceAPI: DeviceAPI | null,
  context?: Record<string, any>,
): Promise<void>;
export async function executeInSandbox(
  compiledCode: string,
  deviceAPI: DeviceAPI | null,
  context: Record<string, any>,
  options: { keepAlive: true; signal?: AbortSignal },
): Promise<SandboxHandle>;
export async function executeInSandbox(
  compiledCode: string,
  deviceAPI: DeviceAPI | null,
  context: Record<string, any>,
  options: { keepAlive?: false; signal?: AbortSignal },
): Promise<void>;
export async function executeInSandbox(
  compiledCode: string,
  deviceAPI: DeviceAPI | null,
  context: Record<string, any> = {},
  options: ExecuteInSandboxOptions = {},
): Promise<SandboxHandle | void> {
  const isolate = new ivm.Isolate({ memoryLimit: ISOLATE_MEMORY_LIMIT });

  // Track timers so we can clean them up on dispose
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  let disposed = false;
  let aborted = false;
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    for (const timer of activeTimers) {
      clearTimeout(timer);
      clearInterval(timer as any);
    }
    activeTimers.clear();
    try { isolate.dispose(); } catch { /* already disposed */ }
  };

  // External abort: when the caller signals, kill the isolate immediately
  // and remember that we did so. The `try { ... await evalClosure ... }
  // catch (err)` below rethrows as a clean AbortError instead of leaking
  // isolated-vm's internal "isolate disposed" exception.
  let signalCleanup: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      aborted = true;
      cleanup();
    } else {
      const onAbort = () => {
        aborted = true;
        cleanup();
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      signalCleanup = () => options.signal!.removeEventListener('abort', onAbort);
    }
  }

  try {
    const ctx = isolate.createContextSync();
    const jail = ctx.global;
    jail.setSync('global', jail.derefInto());

    // ── Host call dispatcher ──────────────────────────────────────
    // All async host method calls go through this single entry point.
    // Arguments are JSON-serialized inside the isolate, deserialized here.
    // Return values use ExternalCopy for structured clone transfer.

    const hostObjects: Record<string, any> = {};
    if (deviceAPI) {
      hostObjects['device'] = deviceAPI;
      hostObjects['device.http'] = (deviceAPI as any).http;
      hostObjects['device.frida'] = (deviceAPI as any).frida;
    }
    // Top-level `http` namespace — always available when caller wires it,
    // regardless of whether a device is attached. Methods issue server-side
    // fetches (not via the device). device.httpGet / device.httpPost are
    // back-compat aliases for the same impl.
    const httpAPI: HttpAPI | undefined = context.httpAPI;
    if (httpAPI) hostObjects['http'] = httpAPI;
    if (context.documentStore) hostObjects['documentStore'] = context.documentStore;

    jail.setSync('__callHost', new ivm.Reference(async (target: string, method: string, argsJson: string) => {
      const obj = hostObjects[target];
      if (!obj) throw new Error(`Unknown host object: ${target}`);
      const fn = obj[method];
      if (typeof fn !== 'function') throw new Error(`${target}.${method} is not a function`);
      const args = JSON.parse(argsJson);
      const result = await fn.apply(obj, args);
      if (result === undefined) return undefined;
      if (result === null) return null;
      if (typeof result !== 'object') return result; // primitives transfer directly
      return new ivm.ExternalCopy(result).copyInto();
    }));

    // Sync variant for methods like http.hook/unhook/intercept
    jail.setSync('__callHostSync', new ivm.Reference((target: string, method: string, argsJson: string) => {
      const obj = hostObjects[target];
      if (!obj) throw new Error(`Unknown host object: ${target}`);
      const fn = obj[method];
      if (typeof fn !== 'function') throw new Error(`${target}.${method} is not a function`);
      const args = JSON.parse(argsJson);
      const result = fn.apply(obj, args);
      if (result === undefined) return undefined;
      if (result === null) return null;
      if (typeof result !== 'object') return result;
      return new ivm.ExternalCopy(result).copyInto();
    }));

    // ── Traffic hook callback registration ─────────────────────────
    // device.http.hook() passes callback functions from the isolate.
    // We store References to those callbacks and invoke them from Node
    // when traffic matches.

    const hookCallbackRefs = new Map<string, { onRequest?: ivm.Reference<Function>; onResponse?: ivm.Reference<Function> }>();

    // Per-guid save-function registry. Populated for the lifetime of each
    // onRequest / onResponse invocation so that __saveHookFlow can call the
    // real host-side save() by guid. Entries are removed in the finally
    // block of the wrappers below.
    const saveCallbacks = new Map<string, { request?: () => Promise<void>; response?: () => Promise<void> }>();

    jail.setSync('__saveHookFlow', new ivm.Reference(async (phase: string, guid: string) => {
      const entry = saveCallbacks.get(guid);
      if (!entry) return; // invocation already completed — no-op
      if (phase === 'request' && entry.request) return entry.request();
      if (phase === 'response' && entry.response) return entry.response();
    }));

    jail.setSync('__registerHook', new ivm.Reference((
      filterJson: string | ivm.Reference<string>,
      onRequestRef: ivm.Reference<Function> | null,
      onResponseRef: ivm.Reference<Function> | null,
    ) => {
      if (!deviceAPI) throw new Error('No device API available');
      // applySync with {arguments: {reference: true}} wraps every arg including
      // the filter string; normalize back to a primitive before parsing.
      const filterJsonStr = typeof filterJson === 'string'
        ? filterJson
        : (filterJson as ivm.Reference<string>).copySync();
      const filter = JSON.parse(filterJsonStr);

      // Reconstruct RegExp objects from serialized filters.
      // TrafficFilter supports hostname | path | method | url — all four must be
      // rehydrated if the script passed a regex.
      for (const key of ['hostname', 'path', 'method', 'url'] as const) {
        const val = filter[key];
        if (val && typeof val === 'object' && val.__isRegex) {
          filter[key] = new RegExp(val.source, val.flags);
        }
      }

      // Create wrapper callbacks that cross the boundary.
      //
      // With { arguments: { reference: true } }, ivm wraps every argument as
      // a Reference — even null/undefined. So `ref ? wrapper : undefined`
      // is always truthy. Check `ref.typeof === 'function'` instead.
      //
      // ivm.ExternalCopy is a structured clone — it rejects functions,
      // Promises, class instances with internal slots, etc. The hook
      // request/response objects carry a save() function that the user's
      // script may call; we strip all functions before copying so the
      // clone succeeds. save() inside the isolate is a follow-up.
      const hasRequestCb = onRequestRef != null && (onRequestRef as any).typeof === 'function';
      const hasResponseCb = onResponseRef != null && (onResponseRef as any).typeof === 'function';

      const onRequest = hasRequestCb ? async (req: any) => {
        const guid = req?.guid as string | undefined;
        if (guid && typeof req.save === 'function') {
          const existing = saveCallbacks.get(guid) ?? {};
          existing.request = () => req.save();
          saveCallbacks.set(guid, existing);
        }
        try {
          const clean = sanitizeForCopy(req);
          const resultCopy = new ivm.ExternalCopy(clean).copyInto();
          const modified = await onRequestRef!.apply(undefined, [resultCopy], { result: { promise: true, copy: true } });
          if (modified && typeof modified === 'object') return modified;
          return req;
        } catch (err: any) {
          log(`hook onRequest callback error: ${err?.message ?? err}`);
          return req;
        } finally {
          if (guid) {
            const entry = saveCallbacks.get(guid);
            if (entry) {
              delete entry.request;
              if (!entry.response) saveCallbacks.delete(guid);
            }
          }
        }
      } : undefined;

      const onResponse = hasResponseCb ? async (res: any) => {
        const guid = res?.guid as string | undefined;
        if (guid && typeof res.save === 'function') {
          const existing = saveCallbacks.get(guid) ?? {};
          existing.response = () => res.save();
          saveCallbacks.set(guid, existing);
        }
        try {
          const clean = sanitizeForCopy(res);
          const resultCopy = new ivm.ExternalCopy(clean).copyInto();
          const modified = await onResponseRef!.apply(undefined, [resultCopy], { result: { promise: true, copy: true } });
          if (modified && typeof modified === 'object') return modified;
          return res;
        } catch (err: any) {
          log(`hook onResponse callback error: ${err?.message ?? err}`);
          return res;
        } finally {
          if (guid) {
            const entry = saveCallbacks.get(guid);
            if (entry) {
              delete entry.response;
              if (!entry.request) saveCallbacks.delete(guid);
            }
          }
        }
      } : undefined;

      const id = (deviceAPI as any).http.hook(filter, onRequest, onResponse);
      hookCallbackRefs.set(id, { onRequest: onRequestRef ?? undefined, onResponse: onResponseRef ?? undefined });
      return id;
    }));

    // ── Console ───────────────────────────────────────────────────
    const consoleFns = context.console ?? createLoggers('automation');
    jail.setSync('__console_log', new ivm.Reference((...args: any[]) => consoleFns.log(...args)));
    jail.setSync('__console_warn', new ivm.Reference((...args: any[]) => consoleFns.warn(...args)));
    jail.setSync('__console_error', new ivm.Reference((...args: any[]) => consoleFns.error(...args)));

    // ── Crypto ────────────────────────────────────────────────────
    jail.setSync('__cryptoHash', new ivm.Reference((algo: string, data: string, encoding: string) => {
      return crypto.createHash(algo).update(data).digest(encoding as any);
    }));
    jail.setSync('__cryptoHmac', new ivm.Reference((algo: string, key: string, data: string, encoding: string) => {
      return crypto.createHmac(algo, key).update(data).digest(encoding as any);
    }));
    jail.setSync('__cryptoRandomBytes', new ivm.Reference((size: number) => {
      return new ivm.ExternalCopy(crypto.randomBytes(size)).copyInto();
    }));
    jail.setSync('__cryptoRandomUUID', new ivm.Reference(() => crypto.randomUUID()));
    jail.setSync('__cryptoRandomInt', new ivm.Reference((...args: number[]) => {
      return (crypto.randomInt as any)(...args);
    }));

    // ── Timers ────────────────────────────────────────────────────
    // Callbacks stay inside the isolate, identified by integer IDs.
    // Node fires the callback by eval'ing __timerFire(id) in the isolate.
    jail.setSync('__setTimeoutHost', new ivm.Reference((id: number, ms: number) => {
      const timer = setTimeout(async () => {
        activeTimers.delete(timer);
        try {
          await ctx.eval(`__timerFire(${id})`, { promise: true });
        } catch { /* isolate may be disposed */ }
      }, ms);
      activeTimers.add(timer);
      return id;
    }));

    jail.setSync('__clearTimeoutHost', new ivm.Reference((id: number) => {
      // We can't easily cancel a specific Node timer by isolate ID,
      // but the isolate-side __timerFire will just no-op if the callback was deleted.
    }));

    jail.setSync('__setIntervalHost', new ivm.Reference((id: number, ms: number) => {
      const timer = setInterval(async () => {
        try {
          await ctx.eval(`__timerFire(${id})`, { promise: true });
        } catch {
          clearInterval(timer);
          activeTimers.delete(timer);
        }
      }, ms);
      activeTimers.add(timer);
      return id;
    }));

    jail.setSync('__clearIntervalHost', new ivm.Reference((id: number) => {
      // Same note as clearTimeout — isolate tracks its own timer map
    }));

    // ── Tools proxy (AI tool registry) ────────────────────────────
    if (context.tools) {
      jail.setSync('__callTool', new ivm.Reference(async (name: string, paramsJson: string) => {
        const params = JSON.parse(paramsJson);
        const result = await context.tools[name](params);
        if (result === undefined) return undefined;
        if (result === null) return null;
        if (typeof result !== 'object') return result;
        return new ivm.ExternalCopy(result).copyInto();
      }));
    }

    // ── Setup code inside isolate ─────────────────────────────────
    // Discover methods via prototype chain (handles real DeviceAPI instances)
    // Falls back to own properties for plain object mocks
    function discoverMethods(obj: any): string[] {
      if (!obj) return [];
      const proto = Object.getPrototypeOf(obj);
      const names = proto && proto !== Object.prototype
        ? Object.getOwnPropertyNames(proto)
        : Object.getOwnPropertyNames(obj);
      return names.filter(m => m !== 'constructor' && typeof obj[m] === 'function');
    }

    const deviceMethods = deviceAPI ? discoverMethods(deviceAPI) : [];
    const syncMethods = ['hook', 'hookRequest', 'hookResponse', 'unhook', 'unhookAll', 'intercept', 'useClientCert'];
    const httpObj = deviceAPI ? (deviceAPI as any).http : null;
    const fridaObj = deviceAPI ? (deviceAPI as any).frida : null;
    const httpMethods = discoverMethods(httpObj);
    const fridaMethods = discoverMethods(fridaObj);

    const setupCode = `
      // ── Module system ──
      const module = { exports: {} };
      const exports = module.exports;

      // ── Console ──
      const console = {
        log: (...args) => __console_log.applyIgnored(undefined, args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))),
        warn: (...args) => __console_warn.applyIgnored(undefined, args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))),
        error: (...args) => __console_error.applyIgnored(undefined, args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))),
      };

      // ── Timers ──
      const __timerCallbacks = new Map();
      let __timerNextId = 1;

      function __timerFire(id) {
        const cb = __timerCallbacks.get(id);
        if (cb) {
          __timerCallbacks.delete(id);
          return cb();
        }
      }

      function setTimeout(fn, ms) {
        const id = __timerNextId++;
        __timerCallbacks.set(id, fn);
        __setTimeoutHost.applySync(undefined, [id, ms || 0]);
        return id;
      }

      function clearTimeout(id) {
        __timerCallbacks.delete(id);
      }

      function setInterval(fn, ms) {
        const id = __timerNextId++;
        __timerCallbacks.set(id, () => { fn(); __timerCallbacks.set(id, () => { fn(); }); });
        __setIntervalHost.applySync(undefined, [id, ms || 0]);
        return id;
      }

      function clearInterval(id) {
        __timerCallbacks.delete(id);
        __clearIntervalHost.applySync(undefined, [id]);
      }

      // ── Crypto ──
      const crypto = {
        createHash: (algo) => ({
          _algo: algo, _data: '',
          update(data) { this._data += (typeof data === 'string' ? data : String(data)); return this; },
          digest(encoding) { return __cryptoHash.applySync(undefined, [this._algo, this._data, encoding || 'hex']); },
        }),
        createHmac: (algo, key) => ({
          _algo: algo, _key: typeof key === 'string' ? key : String(key), _data: '',
          update(data) { this._data += (typeof data === 'string' ? data : String(data)); return this; },
          digest(encoding) { return __cryptoHmac.applySync(undefined, [this._algo, this._key, this._data, encoding || 'hex']); },
        }),
        randomBytes: (size) => __cryptoRandomBytes.applySync(undefined, [size]),
        randomUUID: () => __cryptoRandomUUID.applySync(undefined, []),
        randomInt: (...args) => __cryptoRandomInt.applySync(undefined, args),
      };

      // ── Require (only crypto allowed) ──
      function require(moduleName) {
        if (moduleName === 'crypto') return crypto;
        throw new Error('Module "' + moduleName + '" is not available in automations. Allowed: crypto');
      }

      // ── DOM utilities ──
      ${DOM_UTILS_SOURCE}

      ${deviceAPI ? `
      // ── DeviceAPI proxy ──
      const device = {};
      ${deviceMethods.map(m => `
      device.${m} = async (...args) => {
        return await __callHost.apply(undefined, ['device', '${m}', JSON.stringify(args)], { result: { promise: true, copy: true } });
      };`).join('')}

      // ── device.http ──
      device.http = {};
      ${httpMethods.filter(m => !['hook', 'hookRequest', 'hookResponse'].includes(m)).map(m => {
        if (syncMethods.includes(m)) {
          return `device.http.${m} = (...args) => __callHostSync.applySync(undefined, ['device.http', '${m}', JSON.stringify(args)]);`;
        }
        return `device.http.${m} = async (...args) => await __callHost.apply(undefined, ['device.http', '${m}', JSON.stringify(args)], { result: { promise: true, copy: true } });`;
      }).join('\n      ')}

      // Hook methods need special handling (callback functions as arguments).
      // The host strips functions off the req/res objects before copying them
      // into the isolate (ExternalCopy can't clone functions), so we wrap the
      // user callback here and attach a save() proxy that calls back to the
      // host registry keyed by guid.
      device.http.hook = (filter, onRequest, onResponse) => {
        const filterJson = JSON.stringify(filter, (key, val) => {
          if (val instanceof RegExp) return { __isRegex: true, source: val.source, flags: val.flags };
          return val;
        });
        // stripSave removes the save proxy before the object is cloned
        // back to the host (copy:true). Functions can't be structured-cloned;
        // users routinely return the same req/res they got.
        const stripSave = (o) => {
          if (o && typeof o === 'object') {
            delete o.save;
            if (o.request && typeof o.request === 'object') delete o.request.save;
          }
          return o;
        };
        const wrappedOnRequest = onRequest ? async (req) => {
          if (req && typeof req === 'object' && req.guid) {
            req.save = () => __saveHookFlow.apply(
              undefined,
              ['request', req.guid],
              { result: { promise: true, copy: true } },
            );
          }
          return stripSave(await onRequest(req));
        } : null;
        const wrappedOnResponse = onResponse ? async (res) => {
          if (res && typeof res === 'object' && res.guid) {
            res.save = () => __saveHookFlow.apply(
              undefined,
              ['response', res.guid],
              { result: { promise: true, copy: true } },
            );
          }
          return stripSave(await onResponse(res));
        } : null;
        return __registerHook.applySync(
          undefined,
          [filterJson, wrappedOnRequest, wrappedOnResponse],
          { arguments: { reference: true } }
        );
      };
      device.http.hookRequest = (filter, onRequest) => device.http.hook(filter, onRequest, undefined);
      device.http.hookResponse = (filter, onResponse) => device.http.hook(filter, undefined, onResponse);

      // ── device.frida ──
      device.frida = {};
      ${fridaMethods.map(m => `
      device.frida.${m} = async (...args) => {
        return await __callHost.apply(undefined, ['device.frida', '${m}', JSON.stringify(args)], { result: { promise: true, copy: true } });
      };`).join('')}
      ` : `
      // No device — stub for deviceless automations
      const device = null;
      `}

      ${httpAPI ? `
      // ── Server-side HTTP namespace (always available) ──
      const http = {
        get: async (url, options) => await __callHost.apply(undefined, ['http', 'get', JSON.stringify([url, options])], { result: { promise: true, copy: true } }),
        post: async (url, body, options) => await __callHost.apply(undefined, ['http', 'post', JSON.stringify([url, body, options])], { result: { promise: true, copy: true } }),
        put: async (url, body, options) => await __callHost.apply(undefined, ['http', 'put', JSON.stringify([url, body, options])], { result: { promise: true, copy: true } }),
        delete: async (url, options) => await __callHost.apply(undefined, ['http', 'delete', JSON.stringify([url, options])], { result: { promise: true, copy: true } }),
        patch: async (url, body, options) => await __callHost.apply(undefined, ['http', 'patch', JSON.stringify([url, body, options])], { result: { promise: true, copy: true } }),
        setProxy: async (mode, options) => await __callHost.apply(undefined, ['http', 'setProxy', JSON.stringify([mode, options])], { result: { promise: true, copy: true } }),
        setTlsProfile: async (profile) => await __callHost.apply(undefined, ['http', 'setTlsProfile', JSON.stringify([profile])], { result: { promise: true, copy: true } }),
      };
      ` : ''}

      ${context.documentStore ? `
      // ── Document Store ──
      const documentStore = {
        getDoc: async (docId) => await __callHost.apply(undefined, ['documentStore', 'getDoc', JSON.stringify([docId])], { result: { promise: true, copy: true } }),
        putDoc: async (docId, doc) => await __callHost.apply(undefined, ['documentStore', 'putDoc', JSON.stringify([docId, doc])], { result: { promise: true, copy: true } }),
      };
      ` : ''}

      ${context.tools ? `
      // ── Tools (AI tool registry) ──
      const tools = new Proxy({}, {
        get(_, name) {
          return async (params) => await __callTool.apply(undefined, [name, JSON.stringify(params || {})], { result: { promise: true, copy: true } });
        }
      });
      ` : ''}
    `;

    await ctx.eval(setupCode, { filename: 'sandbox-setup.js' });

    // ── Run automation code ───────────────────────────────────────
    await ctx.eval(compiledCode, { filename: 'automation.js' });

    // ── Call the exported function ─────────────────────────────────
    await ctx.eval(`
      (async () => {
        const __fn = module.exports.default || module.exports;
        if (typeof __fn !== 'function') throw new Error('Automation must export a default async function');
        await __fn(device);
      })()
    `, { promise: true, filename: 'automation-entry.js' });

    log('Automation completed in isolate');

    if (options.keepAlive) {
      // Caller owns lifecycle — return the dispose handle without cleanup.
      signalCleanup?.();
      return { dispose: cleanup };
    }
    cleanup();
    signalCleanup?.();
    return undefined;
  } catch (err) {
    cleanup();
    signalCleanup?.();
    if (aborted) {
      const abortErr = new Error('Automation aborted');
      (abortErr as any).name = 'AbortError';
      throw abortErr;
    }
    throw err;
  }
}
