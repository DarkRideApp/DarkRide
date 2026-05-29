import type { DocStoreApi } from '../types/doc-store';

/**
 * In-memory DocStoreApi for plugin tests. Backs a Map and JSON-round-trips on
 * put (so non-serialisable values reject the same way prod will) and maps
 * absent keys to `null` on get (matching the real adapter).
 *
 * NOTE: prod `getDoc` returns the store's response body, which may wrap the
 * value in store metadata (id/rev). This fixture returns the bare value. If a
 * test depends on the metadata envelope, assert against prod, not this stub.
 */
export function createInMemoryDocStore(): DocStoreApi & {
  readonly _store: ReadonlyMap<string, unknown>;
  clear(): void;
} {
  const store = new Map<string, string>();
  return {
    async putDoc(key: string, value: unknown): Promise<void> {
      store.set(key, JSON.stringify(value));
    },
    async getDoc<T = unknown>(key: string): Promise<T | null> {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    get _store(): ReadonlyMap<string, unknown> {
      const out = new Map<string, unknown>();
      for (const [k, v] of store) out.set(k, JSON.parse(v));
      return out;
    },
    clear(): void {
      store.clear();
    },
  };
}
