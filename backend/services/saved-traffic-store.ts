import { eq, and } from 'drizzle-orm';
import { savedTraffic } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log } = createLoggers('saved-traffic');

export interface SavedTrafficEntry {
  url: string;
  method: string;
  requestHeaders?: string | null;
  requestBody?: string | null;
  responseStatus?: number | null;
  responseHeaders?: string | null;
  responseBody?: string | null;
  deviceId?: string | null;
}

export class SavedTrafficStore {
  constructor(private db: AppDatabase) {}

  /** Upsert a saved traffic entry (latest wins per URL + method). */
  save(entry: SavedTrafficEntry): void {
    const now = new Date();
    const existing = this.db.select({ id: savedTraffic.id })
      .from(savedTraffic)
      .where(and(
        eq(savedTraffic.url, entry.url),
        eq(savedTraffic.method, entry.method),
      ))
      .all();

    if (existing.length > 0) {
      this.db.update(savedTraffic)
        .set({
          requestHeaders: entry.requestHeaders ?? null,
          requestBody: entry.requestBody ?? null,
          responseStatus: entry.responseStatus ?? null,
          responseHeaders: entry.responseHeaders ?? null,
          responseBody: entry.responseBody ?? null,
          deviceId: entry.deviceId ?? null,
          savedAt: now,
        })
        .where(eq(savedTraffic.id, existing[0].id))
        .run();
      log(`Updated saved traffic: ${entry.method} ${entry.url}`);
    } else {
      this.db.insert(savedTraffic)
        .values({
          url: entry.url,
          method: entry.method,
          requestHeaders: entry.requestHeaders ?? null,
          requestBody: entry.requestBody ?? null,
          responseStatus: entry.responseStatus ?? null,
          responseHeaders: entry.responseHeaders ?? null,
          responseBody: entry.responseBody ?? null,
          deviceId: entry.deviceId ?? null,
          savedAt: now,
        })
        .run();
      log(`Saved new traffic: ${entry.method} ${entry.url}`);
    }
  }

  /** Find saved traffic entries matching a URL pattern (substring or regex). */
  search(urlPattern: string): Array<typeof savedTraffic.$inferSelect> {
    const all = this.db.select().from(savedTraffic).all();
    try {
      const regex = new RegExp(urlPattern);
      return all
        .filter(r => regex.test(r.url))
        .sort((a, b) => {
          const timeA = a.savedAt ? new Date(a.savedAt).getTime() : 0;
          const timeB = b.savedAt ? new Date(b.savedAt).getTime() : 0;
          return timeB - timeA;
        });
    } catch {
      // Fall back to substring match
      return all
        .filter(r => r.url.includes(urlPattern))
        .sort((a, b) => {
          const timeA = a.savedAt ? new Date(a.savedAt).getTime() : 0;
          const timeB = b.savedAt ? new Date(b.savedAt).getTime() : 0;
          return timeB - timeA;
        });
    }
  }

  /** Get all saved traffic entries. */
  list(): Array<typeof savedTraffic.$inferSelect> {
    return this.db.select().from(savedTraffic).all()
      .sort((a, b) => {
        const timeA = a.savedAt ? new Date(a.savedAt).getTime() : 0;
        const timeB = b.savedAt ? new Date(b.savedAt).getTime() : 0;
        return timeB - timeA;
      });
  }

  /** Delete a saved traffic entry by ID. */
  delete(id: number): boolean {
    const result = this.db.delete(savedTraffic)
      .where(eq(savedTraffic.id, id))
      .run();
    return result.changes > 0;
  }

  /** Delete all saved traffic entries. */
  deleteAll(): void {
    this.db.delete(savedTraffic).run();
  }
}
