import type { ForEachConfig } from '../types';

export type ForEachItemFn = (item: unknown) => Promise<unknown>;
export type ForEachItemResult = { status: 'ok'; output: unknown } | { status: 'failed'; error: string };

export const FOREACH_REGISTRY: Record<string, ForEachItemFn> = Object.create(null);

export function registerForEachItemFn(name: string, fn: ForEachItemFn): void {
  FOREACH_REGISTRY[name] = fn;
}

export async function runForEach(config: ForEachConfig, items: unknown[]): Promise<ForEachItemResult[]> {
  if (!Array.isArray(items)) throw new Error('runForEach: items must be an array');
  const fn = FOREACH_REGISTRY[config.itemFn];
  if (!fn) throw new Error(`Unknown ForEach item function "${config.itemFn}"`);

  // The async wrapper turns a synchronous throw from fn into a rejection, so
  // allSettled records it as data instead of aborting the whole run.
  const settled = await Promise.allSettled(items.map(async (item) => fn(item)));
  return settled.map((s): ForEachItemResult =>
    s.status === 'fulfilled' ? { status: 'ok', output: s.value } : { status: 'failed', error: String(s.reason) },
  );
}
