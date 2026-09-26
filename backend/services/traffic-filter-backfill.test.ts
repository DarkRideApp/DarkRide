import { describe, it, expect, vi } from 'vitest';
import { isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { backfillTrafficFilterColumns } from './traffic-filter-backfill';
import { deriveTrafficColumns } from '../../shared/lib/traffic-classify';

const { capturedTraffic } = schema;

function insertLegacyRows(db: ReturnType<typeof createTestDb>, n: number) {
  for (let i = 0; i < n; i++) {
    db.insert(capturedTraffic).values({
      requestMethod: i % 3 === 0 ? 'POST' : 'GET',
      requestUrl: `https://api.example.com/${i}`,
      requestBody: i % 3 === 0 ? JSON.stringify({ query: 'query Q { a }' }) : null,
      responseStatus: 200,
      responseHeaders: JSON.stringify({ 'content-type': i % 2 ? 'image/png' : 'application/json' }),
      responseBody: i % 2 ? `[binary image/png, ${1000 + i} chars]` : '{"ok":true}',
      capturedAt: new Date(),
    }).run();
  }
}

describe('backfillTrafficFilterColumns', () => {
  it('fills every pre-0099 row with the shared classifier values', async () => {
    const db = createTestDb();
    insertLegacyRows(db, 25);
    const filled = await backfillTrafficFilterColumns(db as any, { batchSize: 7 });
    expect(filled).toBe(25);
    for (const row of db.select().from(capturedTraffic).all()) {
      const d = deriveTrafficColumns(row as any);
      expect(row).toMatchObject({
        responseCategory: d.responseCategory,
        responseSizeBytes: d.responseSizeBytes,
        isGraphql: d.isGraphql,
        isProtobuf: d.isProtobuf,
      });
    }
    expect(db.select().from(capturedTraffic).where(isNull(capturedTraffic.responseCategory)).all()).toHaveLength(0);
  });

  it('is idempotent and leaves already-classified rows alone', async () => {
    const db = createTestDb();
    insertLegacyRows(db, 5);
    await backfillTrafficFilterColumns(db as any, { batchSize: 2 });
    expect(await backfillTrafficFilterColumns(db as any, { batchSize: 2 })).toBe(0);
  });

  it('reports progress per batch with processed / total', async () => {
    const db = createTestDb();
    insertLegacyRows(db, 10);
    const onProgress = vi.fn();
    await backfillTrafficFilterColumns(db as any, { batchSize: 4, onProgress });
    expect(onProgress.mock.calls.map(([p]) => [p.processed, p.total])).toEqual([[4, 10], [8, 10], [10, 10]]);
  });

  it('yields to the event loop between batches', async () => {
    const db = createTestDb();
    insertLegacyRows(db, 6);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    await backfillTrafficFilterColumns(db as any, { batchSize: 1 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('returns 0 on an empty table', async () => {
    expect(await backfillTrafficFilterColumns(createTestDb() as any)).toBe(0);
  });
});
