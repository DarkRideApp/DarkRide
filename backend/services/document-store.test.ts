import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as schema from '../db/schema';
import { DocumentStore, DocumentStoreHttpError } from './document-store';
import { gunzipSync } from 'zlib';
import { createTestDb } from '../test-utils/create-test-db';

describe('DocumentStore', () => {
  let db: ReturnType<typeof createTestDb>;
  let store: DocumentStore;

  beforeEach(() => {
    db = createTestDb();
    store = new DocumentStore(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when URL not configured', async () => {
    await expect(store.getDoc('abc')).rejects.toThrow('Document store URL not configured');
  });

  it('throws when URL not configured for putDoc', async () => {
    await expect(store.putDoc('abc', { x: 1 })).rejects.toThrow('Document store URL not configured');
  });

  describe('with configured URL', () => {
    beforeEach(() => {
      db.insert(schema.settings).values({ key: 'document_store_url', value: 'https://docs.example.com/api' }).run();
    });

    it('getDoc returns parsed JSON on 200', async () => {
      const mockData = { id: 'doc1', title: 'Test' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      }));

      const result = await store.getDoc('doc1');
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith('https://docs.example.com/api/id/doc1', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
    });

    it('getDoc throws on non-200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      await expect(store.getDoc('missing')).rejects.toThrow('Document store GET failed: 404');
    });

    it('putDoc sends gzipped body and returns parsed JSON', async () => {
      const doc = { title: 'New Doc', content: 'hello' };
      const responseData = { id: 'doc2', rev: '1-abc' };
      let capturedBody: Buffer | null = null;

      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedBody = opts.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(responseData),
        });
      }));

      const result = await store.putDoc('doc2', doc);
      expect(result).toEqual(responseData);
      expect(fetch).toHaveBeenCalledWith('https://docs.example.com/api/id/doc2', expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      }));

      // Verify the body is valid gzipped JSON
      expect(capturedBody).not.toBeNull();
      const decompressed = gunzipSync(capturedBody!).toString();
      expect(JSON.parse(decompressed)).toEqual(doc);
    });

    it('putDoc throws on non-200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      await expect(store.putDoc('doc3', { x: 1 })).rejects.toThrow('Document store PUT failed: 500');
    });

    it('merges custom headers from document_store_headers setting into getDoc', async () => {
      db.insert(schema.settings).values({
        key: 'document_store_headers',
        value: JSON.stringify({ Authorization: 'Bearer abc', 'X-Env': 'prod' }),
      }).run();

      let capturedHeaders: Record<string, string> | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      await store.getDoc('doc1');
      expect(capturedHeaders).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer abc',
        'X-Env': 'prod',
      });
    });

    it('custom headers override defaults on collision', async () => {
      db.insert(schema.settings).values({
        key: 'document_store_headers',
        value: JSON.stringify({ 'Content-Type': 'application/vnd.custom+json' }),
      }).run();

      let capturedHeaders: Record<string, string> | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      await store.getDoc('doc1');
      expect(capturedHeaders!['Content-Type']).toBe('application/vnd.custom+json');
    });

    it('merges custom headers into putDoc', async () => {
      db.insert(schema.settings).values({
        key: 'document_store_headers',
        value: JSON.stringify({ Authorization: 'Bearer abc' }),
      }).run();

      let capturedHeaders: Record<string, string> | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      await store.putDoc('doc1', { x: 1 });
      expect(capturedHeaders).toEqual({
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        Authorization: 'Bearer abc',
      });
    });

    it('ignores malformed headers JSON', async () => {
      db.insert(schema.settings).values({
        key: 'document_store_headers',
        value: 'not json {',
      }).run();

      let capturedHeaders: Record<string, string> | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      await store.getDoc('doc1');
      expect(capturedHeaders).toEqual({ 'Content-Type': 'application/json' });
    });

    it('ignores non-object headers (array / null / primitive)', async () => {
      db.insert(schema.settings).values({
        key: 'document_store_headers',
        value: JSON.stringify(['not', 'an', 'object']),
      }).run();

      let capturedHeaders: Record<string, string> | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      await store.getDoc('doc1');
      expect(capturedHeaders).toEqual({ 'Content-Type': 'application/json' });
    });

    it('getDoc throws a DocumentStoreHttpError carrying the status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(store.getDoc('missing')).rejects.toMatchObject({
        name: 'DocumentStoreHttpError',
        status: 404,
        message: 'Document store GET failed: 404',
      });
    });

    it('URL-encodes the key in the path', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
      await store.getDoc('a b/c');
      expect(fetch).toHaveBeenCalledWith(
        'https://docs.example.com/api/id/a%20b%2Fc',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('strips trailing slash from URL', async () => {
      // Update the URL to have a trailing slash
      db.update(schema.settings).set({ value: 'https://docs.example.com/api/' })
        .where(schema.settings.key.getSQL ? undefined as any : undefined)
        .run();
      // Re-insert with trailing slash
      db.delete(schema.settings).run();
      db.insert(schema.settings).values({ key: 'document_store_url', value: 'https://docs.example.com/api/' }).run();

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }));

      await store.getDoc('doc1');
      expect(fetch).toHaveBeenCalledWith('https://docs.example.com/api/id/doc1', expect.anything());
    });
  });
});
