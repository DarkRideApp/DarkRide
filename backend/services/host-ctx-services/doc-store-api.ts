import type { DocStoreApi } from '@darkrideapp/plugin-sdk';
import type { AppDatabase } from '../../db/index';
import { DocumentStore, DocumentStoreHttpError } from '../document-store';

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('documentStore: key must be a non-empty string');
  }
  if (Buffer.byteLength(key, 'utf8') > 256) {
    throw new Error('documentStore: key exceeds 256 bytes');
  }
  // §3.1: reject whitespace and control characters; other chars (incl. `-`,
  // `_`) are allowed and URL-encoded downstream by the raw service.
  // Range-free so `-` is never caught: \s covers whitespace; the charCode
  // check covers C0 controls (<0x20) and DEL (0x7f).
  if (/\s/.test(key) || [...key].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    throw new Error('documentStore: key contains whitespace or control characters');
  }
}

/**
 * Host-side adapter exposing the SDK's `DocStoreApi` contract over the raw
 * `DocumentStore` HTTP service. Reconciles the raw service with the v1 spec:
 * 404 -> null on get, void return on put, key validation, typed errors.
 * One shared instance is wired onto every plugin's `ctx.documentStore`.
 */
export function createDocStoreApi(db: AppDatabase): DocStoreApi {
  const raw = new DocumentStore(db);
  return {
    async putDoc(key: string, value: unknown): Promise<void> {
      validateKey(key);
      await raw.putDoc(key, value);
    },
    async getDoc<T = unknown>(key: string): Promise<T | null> {
      validateKey(key);
      try {
        return (await raw.getDoc(key)) as T;
      } catch (err) {
        if (err instanceof DocumentStoreHttpError && err.status === 404) return null;
        throw err;
      }
    },
  };
}
