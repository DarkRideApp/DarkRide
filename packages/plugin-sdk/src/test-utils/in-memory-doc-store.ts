import type { DocStoreApi } from '../types/doc-store';

/**
 * Mirrors the host adapter's key rules (DocStoreApi spec §3.1) so a test that
 * passes a key prod would reject fails here too, instead of silently passing.
 */
function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('documentStore: key must be a non-empty string');
  }
  if (countUtf8Bytes(key) > 256) {
    throw new Error('documentStore: key exceeds 256 bytes');
  }
  if (/\s/.test(key) || [...key].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    throw new Error('documentStore: key contains whitespace or control characters');
  }
}

// TextEncoder is universal (Node + browsers); avoids a Node Buffer dependency
// in the SDK so the fixture stays environment-agnostic.
function countUtf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * In-memory DocStoreApi for plugin tests. Backs a Map and JSON-round-trips on
 * put (so non-serialisable values reject the same way prod will), validates
 * keys the same way the host adapter does, and maps absent keys to `null` on
 * get (matching the real adapter).
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
      validateKey(key);
      store.set(key, JSON.stringify(value));
    },
    async getDoc<T = unknown>(key: string): Promise<T | null> {
      validateKey(key);
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    // Returns a fresh snapshot Map on each access (not a live view); read it
    // again after each mutation rather than holding a reference.
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
