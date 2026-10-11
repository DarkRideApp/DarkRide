import type { HookBus, SchemaField } from './types/hooks';

interface HookDefinition {
  name: string;
  schema: SchemaField[];
  description: string;
}

type HookHandler = (...args: any[]) => void | Promise<void>;

export class HookBusImpl implements HookBus {
  private handlers = new Map<string, Set<HookHandler>>();
  private definitions: HookDefinition[] = [];

  define(name: string, schema?: SchemaField[] | Record<string, string>, description?: string): void {
    // A plugin already compiled against the pre-existing documented signature
    // (define(name, Record<string,string>) or define(name) with no schema at all — see
    // docs/plugins/backend.md) calls this at runtime with the old shape regardless of which
    // @darkrideapp/plugin-sdk version it was built against: plugins run in-process against
    // this host's live HookBusImpl, not their own. Normalize rather than trust the caller, so
    // getDefinedHooks() always returns a real SchemaField[] — never an object a consumer
    // (e.g. the editor's SchemaFieldListEditor, which calls .map on it) would crash on.
    const normalizedSchema = Array.isArray(schema)
      ? schema
      : Object.entries(schema ?? {}).map(([field, type]) => ({ field, type, description: '' }));
    this.definitions.push({ name, schema: normalizedSchema, description: description ?? '' });
  }

  on(name: string, handler: HookHandler): void {
    if (!this.handlers.has(name)) {
      this.handlers.set(name, new Set());
    }
    this.handlers.get(name)!.add(handler);
  }

  off(name: string, handler: HookHandler): void {
    this.handlers.get(name)?.delete(handler);
  }

  emit(name: string, ...args: any[]): void {
    const handlers = this.handlers.get(name);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        const result = handler(...args);
        // Async handlers return a Promise. Without this branch a rejection
        // would surface as an unhandledRejection — the global handler logs
        // it, but with no context about which hook or which plugin. Hook
        // handlers are fire-and-forget by contract, so log and swallow.
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err) => {
            console.error(`[hook-bus] Hook handler error for "${name}" (async):`, err);
          });
        }
      } catch (err) {
        console.error(`[hook-bus] Hook handler error for "${name}":`, err);
      }
    }
  }

  getDefinedHooks(): HookDefinition[] {
    return [...this.definitions];
  }
}
