import { randomUUID } from 'crypto';
import { createLoggers } from '../logs';
import type {
  TrafficFilter,
  HookRequestObject,
  HookResponseObject,
  RequestHookCallback,
  ResponseHookCallback,
} from '../../shared/types/automation';
import type { SavedTrafficStore } from './saved-traffic-store';

const { log, error } = createLoggers('traffic-hook-registry');

export interface RegisteredHook {
  id: string;
  deviceId: string;
  filter: TrafficFilter;
  onRequest?: RequestHookCallback;
  onResponse?: ResponseHookCallback;
}

export interface InterceptRequest {
  deviceId: string;
  phase: 'request' | 'response';
  guid: string;
  method: string;
  url: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
}

export interface InterceptResult {
  action: 'pass' | 'block' | 'modify';
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | null;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
}

function matchesField(filter: string | RegExp, value: string): boolean {
  if (typeof filter === 'string') return value.includes(filter);
  return filter.test(value);
}

function matchesFilter(filter: TrafficFilter, request: InterceptRequest): boolean {
  if (filter.hostname && !matchesField(filter.hostname, request.hostname)) return false;
  if (filter.path && !matchesField(filter.path, request.path)) return false;
  if (filter.method && !matchesField(filter.method, request.method)) return false;
  if (filter.url && !matchesField(filter.url, request.url)) return false;
  return true;
}

export class TrafficHookRegistry {
  private hooks = new Map<string, RegisteredHook[]>();
  private savedTrafficStore: SavedTrafficStore | null = null;
  /** Guids where req.save() was called — auto-save when response arrives */
  private pendingSaves = new Set<string>();

  setSavedTrafficStore(store: SavedTrafficStore): void {
    this.savedTrafficStore = store;
  }

  registerHook(
    deviceId: string,
    filter: TrafficFilter,
    onRequest?: RequestHookCallback,
    onResponse?: ResponseHookCallback,
  ): string {
    const id = randomUUID();
    const hook: RegisteredHook = { id, deviceId, filter, onRequest, onResponse };
    const deviceHooks = this.hooks.get(deviceId) || [];
    deviceHooks.push(hook);
    this.hooks.set(deviceId, deviceHooks);
    log(`Registered hook ${id} for device ${deviceId}`);
    return id;
  }

  removeHook(deviceId: string, hookId: string): boolean {
    const deviceHooks = this.hooks.get(deviceId);
    if (!deviceHooks) return false;
    const idx = deviceHooks.findIndex((h) => h.id === hookId);
    if (idx === -1) return false;
    deviceHooks.splice(idx, 1);
    if (deviceHooks.length === 0) {
      this.hooks.delete(deviceId);
    }
    return true;
  }

  clearHooks(deviceId: string): void {
    this.hooks.delete(deviceId);
    log(`Cleared all hooks for device ${deviceId}`);
  }

  hasHooks(deviceId: string): boolean {
    const deviceHooks = this.hooks.get(deviceId);
    return !!deviceHooks && deviceHooks.length > 0;
  }

  async processIntercept(request: InterceptRequest): Promise<InterceptResult> {
    // Check for pending saves from req.save() even if no hooks match
    if (request.phase === 'response' && this.pendingSaves.has(request.guid)) {
      this.pendingSaves.delete(request.guid);
      this.autoSaveResponse(request);
    }

    const deviceHooks = this.hooks.get(request.deviceId);
    if (!deviceHooks || deviceHooks.length === 0) {
      return { action: 'pass' };
    }

    const matchingHooks = deviceHooks.filter((h) => matchesFilter(h.filter, request));
    if (matchingHooks.length === 0) {
      return { action: 'pass' };
    }

    if (request.phase === 'request') {
      return this.processRequestPhase(matchingHooks, request);
    } else {
      return this.processResponsePhase(matchingHooks, request);
    }
  }

  private autoSaveResponse(request: InterceptRequest): void {
    if (!this.savedTrafficStore) return;
    this.savedTrafficStore.save({
      url: request.url,
      method: request.method,
      requestHeaders: JSON.stringify(request.headers),
      requestBody: request.body,
      responseStatus: request.status ?? null,
      responseHeaders: request.responseHeaders ? JSON.stringify(request.responseHeaders) : null,
      responseBody: request.responseBody ?? null,
      deviceId: request.deviceId ?? null,
    });
  }

  private makeSaveRequest(req: HookRequestObject): () => Promise<void> {
    return async () => {
      // Mark this flow for auto-save when the response arrives
      this.pendingSaves.add(req.guid);
    };
  }

  private makeSaveResponse(resp: HookResponseObject, deviceId?: string): () => Promise<void> {
    return async () => {
      if (!this.savedTrafficStore) return;
      this.savedTrafficStore.save({
        url: resp.request.url,
        method: resp.request.method,
        requestHeaders: JSON.stringify(resp.request.headers),
        requestBody: resp.request.body,
        responseStatus: resp.status,
        responseHeaders: JSON.stringify(resp.headers),
        responseBody: resp.body,
        deviceId: deviceId ?? null,
      });
    };
  }

  private async processRequestPhase(
    hooks: RegisteredHook[],
    request: InterceptRequest,
  ): Promise<InterceptResult> {
    let modified = false;
    let current: HookRequestObject = {
      guid: request.guid,
      method: request.method,
      url: request.url,
      hostname: request.hostname,
      path: request.path,
      headers: { ...request.headers },
      body: request.body,
      save: undefined as any,
    };
    current.save = this.makeSaveRequest(current);

    for (const hook of hooks) {
      if (!hook.onRequest) continue;
      try {
        const result = await hook.onRequest(current);
        if (result === null) {
          return { action: 'block' };
        }
        if (result !== undefined) {
          current = result;
          modified = true;
        }
      } catch (err: any) {
        error(`Hook ${hook.id} request callback error: ${err.message}`);
        // Fail open — continue processing
      }
    }

    if (modified) {
      return {
        action: 'modify',
        method: current.method,
        url: current.url,
        headers: current.headers,
        body: current.body,
      };
    }

    return { action: 'pass' };
  }

  private async processResponsePhase(
    hooks: RegisteredHook[],
    request: InterceptRequest,
  ): Promise<InterceptResult> {
    let modified = false;
    let current: HookResponseObject = {
      guid: request.guid,
      status: request.status ?? 0,
      headers: { ...request.responseHeaders ?? {} },
      body: request.responseBody ?? null,
      request: {
        guid: request.guid,
        method: request.method,
        url: request.url,
        hostname: request.hostname,
        path: request.path,
        headers: { ...request.headers },
        body: request.body,
        save: undefined as any,
      },
      save: undefined as any,
    };
    current.save = this.makeSaveResponse(current, request.deviceId);

    for (const hook of hooks) {
      if (!hook.onResponse) continue;
      try {
        const result = await hook.onResponse(current);
        if (result === null) {
          return { action: 'block' };
        }
        if (result !== undefined) {
          current = result;
          modified = true;
        }
      } catch (err: any) {
        error(`Hook ${hook.id} response callback error: ${err.message}`);
        // Fail open — continue processing
      }
    }

    if (modified) {
      return {
        action: 'modify',
        status: current.status,
        responseHeaders: current.headers,
        responseBody: current.body,
      };
    }

    return { action: 'pass' };
  }
}

export const trafficHookRegistry = new TrafficHookRegistry();
