export interface SchemaField { field: string; type: string; description: string }

export interface HookBus {
  define(name: string, schema: SchemaField[], description: string): void;
  on(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  off(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  emit(name: string, ...args: any[]): void;
}
