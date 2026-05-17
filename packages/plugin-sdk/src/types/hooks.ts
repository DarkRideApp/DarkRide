export interface HookBus {
  define(name: string, schema?: Record<string, string>): void;
  on(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  off(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  emit(name: string, ...args: any[]): void;
}
