import type { HookBus } from './types/hooks';

interface HookDefinition {
  name: string;
  schema?: Record<string, string>;
}

type HookHandler = (...args: any[]) => void | Promise<void>;

export class HookBusImpl implements HookBus {
  private handlers = new Map<string, Set<HookHandler>>();
  private definitions: HookDefinition[] = [];

  define(name: string, schema?: Record<string, string>): void {
    this.definitions.push({ name, schema });
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
