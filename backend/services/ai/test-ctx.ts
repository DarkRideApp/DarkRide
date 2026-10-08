import { getProviderDescriptor } from '../../../shared/lib/ai-provider-catalog';
import type { DialectContext } from './dialect';

/** A DialectContext for a catalog id with deterministic ids and a placeholder key. */
export function makeCtx(id: string, over: Partial<DialectContext> = {}): DialectContext {
  const d = getProviderDescriptor(id);
  if (!d) throw new Error(`makeCtx: unknown provider ${id}`);
  let n = 0;
  return {
    descriptor: d,
    baseUrl: d.defaultBaseUrl ?? 'http://127.0.0.1:1234/v1',
    apiKey: 'sk-test-placeholder',
    model: d.defaultModel ?? 'test-model',
    newId: () => `id-${++n}`,
    flags: {},
    ...over,
  };
}
