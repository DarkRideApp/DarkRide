import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db';
import { capturedTraffic } from '../db/schema';
import { deriveTrafficColumns } from '../../shared/lib/traffic-classify';

export interface BackfillProgress {
  processed: number;
  total: number;
}

export interface BackfillOptions {
  batchSize?: number;
  onProgress?: (p: BackfillProgress) => void;
}

/**
 * Fill the deep-filter columns added in migration 0099 for rows captured
 * before it. New rows get them at insert. Runs in batches and yields to the
 * event loop between them, so the server keeps serving while a large table
 * is classified. Rows still NULL simply don't match content-type/size
 * filters until reached. Idempotent: only NULL rows are touched.
 */
export async function backfillTrafficFilterColumns(db: AppDatabase, opts: BackfillOptions = {}): Promise<number> {
  const batchSize = opts.batchSize ?? 200;
  const t = capturedTraffic;
  const total = db.select({ n: sql<number>`count(*)` }).from(t).where(isNull(t.responseCategory)).all()[0].n;
  if (total === 0) return 0;

  let processed = 0;
  let lastId = 0;
  for (;;) {
    const rows = db.select({
      id: t.id,
      type: t.type,
      requestMethod: t.requestMethod,
      requestUrl: t.requestUrl,
      requestHeaders: t.requestHeaders,
      requestBody: t.requestBody,
      responseHeaders: t.responseHeaders,
      responseBody: t.responseBody,
    })
      .from(t)
      // id > lastId guarantees forward progress even if a write is lost.
      .where(and(isNull(t.responseCategory), gt(t.id, lastId)))
      .orderBy(asc(t.id))
      .limit(batchSize)
      .all();
    if (rows.length === 0) break;

    db.transaction((tx) => {
      for (const row of rows) {
        tx.update(t).set(deriveTrafficColumns(row)).where(eq(t.id, row.id)).run();
      }
    });
    lastId = rows[rows.length - 1].id;
    processed += rows.length;
    opts.onProgress?.({ processed, total });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return processed;
}
