import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { apiKeys } from '../schema';

describe('api_keys.internal column', () => {
  it('defaults to false when not specified', () => {
    const db = createTestDb([apiKeys]);
    const row = db.insert(apiKeys).values({
      userId: 1,
      name: 'test',
      keyHash: 'h',
      keyPrefix: 'p',
      scopes: [],
      createdAt: new Date(),
    }).returning().get();
    expect(row.internal).toBe(false);
  });

  it('accepts internal: true', () => {
    const db = createTestDb([apiKeys]);
    const row = db.insert(apiKeys).values({
      userId: 1,
      name: 'internal-test',
      keyHash: 'h2',
      keyPrefix: 'p',
      scopes: [],
      internal: true,
      createdAt: new Date(),
    }).returning().get();
    expect(row.internal).toBe(true);
  });
});
