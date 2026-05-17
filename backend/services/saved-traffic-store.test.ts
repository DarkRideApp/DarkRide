import { describe, it, expect, beforeEach } from 'vitest';
import * as schema from '../db/schema';
import { SavedTrafficStore } from './saved-traffic-store';
import { createTestDb } from '../test-utils/create-test-db';

describe('SavedTrafficStore', () => {
  let db: ReturnType<typeof createTestDb>;
  let store: SavedTrafficStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SavedTrafficStore(db);
  });

  describe('save', () => {
    it('inserts a new entry', () => {
      store.save({
        url: 'https://api.example.com/data',
        method: 'GET',
        responseStatus: 200,
        responseBody: '{"ok":true}',
      });

      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0].url).toBe('https://api.example.com/data');
      expect(all[0].method).toBe('GET');
      expect(all[0].responseStatus).toBe(200);
      expect(all[0].responseBody).toBe('{"ok":true}');
    });

    it('upserts on same URL + method', () => {
      store.save({
        url: 'https://api.example.com/data',
        method: 'GET',
        responseStatus: 200,
        responseBody: '{"version":1}',
      });

      store.save({
        url: 'https://api.example.com/data',
        method: 'GET',
        responseStatus: 200,
        responseBody: '{"version":2}',
      });

      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0].responseBody).toBe('{"version":2}');
    });

    it('keeps separate entries for different methods', () => {
      store.save({ url: 'https://api.example.com/data', method: 'GET', responseStatus: 200 });
      store.save({ url: 'https://api.example.com/data', method: 'POST', responseStatus: 201 });

      const all = store.list();
      expect(all).toHaveLength(2);
    });

    it('keeps separate entries for different URLs', () => {
      store.save({ url: 'https://api.example.com/a', method: 'GET', responseStatus: 200 });
      store.save({ url: 'https://api.example.com/b', method: 'GET', responseStatus: 200 });

      const all = store.list();
      expect(all).toHaveLength(2);
    });

    it('stores request data', () => {
      store.save({
        url: 'https://api.example.com/post',
        method: 'POST',
        requestHeaders: '{"content-type":"application/json"}',
        requestBody: '{"name":"test"}',
        responseStatus: 201,
        responseBody: '{"id":1}',
        deviceId: 'device-123',
      });

      const all = store.list();
      expect(all[0].requestHeaders).toBe('{"content-type":"application/json"}');
      expect(all[0].requestBody).toBe('{"name":"test"}');
      expect(all[0].deviceId).toBe('device-123');
    });
  });

  describe('search', () => {
    beforeEach(() => {
      store.save({ url: 'https://api.example.com/users', method: 'GET', responseStatus: 200, responseBody: '[1,2]' });
      store.save({ url: 'https://api.example.com/products', method: 'GET', responseStatus: 200, responseBody: '[3,4]' });
      store.save({ url: 'https://other.com/data', method: 'GET', responseStatus: 200, responseBody: '[]' });
    });

    it('matches by regex pattern', () => {
      const results = store.search('api\\.example\\.com');
      expect(results).toHaveLength(2);
    });

    it('matches by substring when regex is invalid', () => {
      const results = store.search('api.example.com');
      expect(results).toHaveLength(2);
    });

    it('returns empty array for no matches', () => {
      const results = store.search('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('matches specific path', () => {
      const results = store.search('/users');
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe('https://api.example.com/users');
    });

    it('results are sorted by savedAt descending', () => {
      const results = store.search('api\\.example\\.com');
      expect(results).toHaveLength(2);
      // Most recent should be first
      const time0 = new Date(results[0].savedAt).getTime();
      const time1 = new Date(results[1].savedAt).getTime();
      expect(time0).toBeGreaterThanOrEqual(time1);
    });
  });

  describe('delete', () => {
    it('deletes by ID', () => {
      store.save({ url: 'https://api.example.com/a', method: 'GET', responseStatus: 200 });
      const all = store.list();
      expect(all).toHaveLength(1);

      const deleted = store.delete(all[0].id);
      expect(deleted).toBe(true);
      expect(store.list()).toHaveLength(0);
    });

    it('returns false for non-existent ID', () => {
      expect(store.delete(999)).toBe(false);
    });
  });

  describe('deleteAll', () => {
    it('clears all entries', () => {
      store.save({ url: 'https://a.com', method: 'GET', responseStatus: 200 });
      store.save({ url: 'https://b.com', method: 'GET', responseStatus: 200 });
      expect(store.list()).toHaveLength(2);

      store.deleteAll();
      expect(store.list()).toHaveLength(0);
    });
  });
});
