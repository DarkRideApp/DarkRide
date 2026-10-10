import type { TransformConfig } from '../types';

export type TransformFn = (input: Record<string, unknown>) => Record<string, unknown>;

export const TRANSFORM_REGISTRY: Record<string, TransformFn> = {};

export function registerTransform(name: string, fn: TransformFn): void {
  TRANSFORM_REGISTRY[name] = fn;
}

export function runTransform(config: TransformConfig, input: Record<string, unknown>): Record<string, unknown> {
  const fn = TRANSFORM_REGISTRY[config.fn];
  if (!fn) throw new Error(`Unknown transform "${config.fn}"`);
  return fn(input);
}
