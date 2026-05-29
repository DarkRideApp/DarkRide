import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '../db/schema';
import { createDocStoreApi } from './doc-store-api';
import { createTestDb } from '../test-utils/create-test-db';

describe('createDocStoreApi', () => {
  let db: ReturnType<typeof createTestDb>;
  let api: ReturnType<typeof createDocStoreApi>;

  beforeEach(() => {
    db = createTestDb();
    db.insert(schema.settings).values({ key: 'document_store_url', value: 'https://docs.example.com/api' }).run();
    api = createDocStoreApi(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getDoc maps 404 to null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await api.getDoc('missing')).toBeNull();
  });

  it('getDoc rethrows non-404 store errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(api.getDoc('k')).rejects.toThrow('Document store GET failed: 503');
  });

  it('getDoc returns the store body on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ a: 1 }) }));
    expect(await api.getDoc('k')).toEqual({ a: 1 });
  });

  it('putDoc resolves to undefined (void) on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'k', rev: '1' }) }));
    expect(await api.putDoc('k', { a: 1 })).toBeUndefined();
  });

  it('putDoc rejects on a non-JSON-serialisable value', async () => {
    const circular: any = {}; circular.self = circular;
    await expect(api.putDoc('k', circular)).rejects.toThrow();
  });

  it('rejects an empty key', async () => {
    await expect(api.putDoc('', { a: 1 })).rejects.toThrow('non-empty string');
  });

  it('rejects a key with whitespace', async () => {
    await expect(api.putDoc('has space', { a: 1 })).rejects.toThrow('whitespace or control');
  });

  it('rejects a key over 256 bytes', async () => {
    await expect(api.getDoc('x'.repeat(257))).rejects.toThrow('256 bytes');
  });
});
