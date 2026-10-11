import type { SchemaField } from '../types';

export interface RegisteredFunctionInfo {
  name: string;
  description: string;
  inputSchema?: SchemaField[];
  outputSchema?: SchemaField[];
}

export interface FunctionRegistry<Fn> {
  register(name: string, fn: Fn, description: string, schema?: { inputSchema?: SchemaField[]; outputSchema?: SchemaField[] }): void;
  get(name: string): Fn | undefined;
  list(): RegisteredFunctionInfo[];
}

/**
 * Shared implementation behind every node kind's "registered function" catalog (Sink's write
 * functions, Trigger's expand functions, Transform's reshape functions) — previously three
 * near-identical hand-rolled `Object.create(null)` maps, one per nodes/*.ts file. `Object.create
 * (null)` (not `{}` or `Map`, to match what every caller already relies on for the "no
 * Object.prototype key resolves" guarantee) keyed by name, in insertion order for `list()`.
 */
export function createFunctionRegistry<Fn>(): FunctionRegistry<Fn> {
  const fns: Record<string, Fn> = Object.create(null);
  const info: Record<string, RegisteredFunctionInfo> = Object.create(null);
  const order: string[] = [];

  return {
    register(name, fn, description, schema) {
      if (!(name in fns)) order.push(name);
      fns[name] = fn;
      info[name] = { name, description, inputSchema: schema?.inputSchema, outputSchema: schema?.outputSchema };
    },
    get(name) {
      return fns[name];
    },
    list() {
      return order.map(name => info[name]);
    },
  };
}
