import type { TransformConfig } from '../types';
import type { SchemaField } from '../types';
import { createFunctionRegistry } from './function-registry';

export type TransformFn = (input: Record<string, unknown>) => Record<string, unknown>;

const registry = createFunctionRegistry<TransformFn>();
export const TRANSFORM_REGISTRY: Record<string, TransformFn> = new Proxy({} as Record<string, TransformFn>, {
  get: (_t, name: string) => registry.get(name),
});
export const TRANSFORM_DESCRIPTIONS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_t, name: string) => registry.list().find(e => e.name === name)?.description,
});
export const TRANSFORM_SCHEMAS: Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }> =
  new Proxy({} as Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }>, {
    get: (_t, name: string) => {
      const entry = registry.list().find(e => e.name === name);
      return entry && { inputSchema: entry.inputSchema ?? [], outputSchema: entry.outputSchema ?? [] };
    },
  });

export function registerTransform(
  name: string, fn: TransformFn, description: string,
  schema: { inputSchema: SchemaField[]; outputSchema: SchemaField[] },
): void {
  registry.register(name, fn, description, schema);
}

export function runTransform(config: TransformConfig, input: Record<string, unknown>): Record<string, unknown> {
  const fn = registry.get(config.fn);
  if (!fn) throw new Error(`Unknown transform "${config.fn}"`);
  return fn(input);
}
