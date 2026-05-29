/**
 * Document Store — keyed JSON-document persistence with write-through to the
 * external store collectors read from. This is the typed counterpart to the
 * `documentStore` ambient available inside automation scripts.
 *
 * v1 surface is intentionally two methods: the host service exposes only
 * getDoc/putDoc, and the driving consumer only writes. deleteDoc/hasDoc/
 * listDocs are deferred until a real consumer + host-side support exist.
 */
export interface DocStoreApi {
  /**
   * Upsert a document by key. `value` is serialised as JSON. Last-write-wins
   * (the host issues a blind PUT with no rev). Rejects on a non-JSON-
   * serialisable `value` (circular refs, BigInt, …), an invalid key, or an
   * underlying store error.
   */
  putDoc(key: string, value: unknown): Promise<void>;

  /**
   * Read a document by key. Resolves to `null` when the key is absent;
   * rejects on any other store error. `T` is unchecked at runtime — validate
   * the shape before trusting it. The returned object is the store's response
   * body and may include store metadata (e.g. id/rev); do not assume a clean
   * round-trip of exactly what `putDoc` wrote.
   */
  getDoc<T = unknown>(key: string): Promise<T | null>;
}
