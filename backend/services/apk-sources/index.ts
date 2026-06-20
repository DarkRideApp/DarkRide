import { eq } from 'drizzle-orm';
import { appSources } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { PlayStoreSource } from '../play-store-source';
import { QqSource } from './qq-source';
import { SourceRegistry } from './registry';

export { SourceRegistry } from './registry';
export { QqSource, parseQqRecord } from './qq-source';
export * from './types';

/**
 * Build the default registry of remote APK sources, wired to the DB so each
 * source can read its settings (credentials, defaults).
 */
export function createSourceRegistry(db: AppDatabase): SourceRegistry {
  const playStore = new PlayStoreSource();
  playStore.setDatabase(db);

  const qq = new QqSource();
  qq.setDatabase(db);

  return new SourceRegistry()
    .register(playStore)
    .register(qq);
}

/**
 * Ensure an app_sources row exists for every registered remote source on the
 * given tracked app. Missing rows are created with the source's default
 * enablement. Idempotent — safe to call on every track / check.
 */
export function ensureAppSources(
  db: AppDatabase,
  trackedAppId: number,
  registry: SourceRegistry,
): void {
  const existing = new Set(
    db.select().from(appSources).where(eq(appSources.trackedAppId, trackedAppId)).all().map(r => r.source),
  );
  for (const source of registry.all()) {
    if (existing.has(source.id)) continue;
    // onConflictDoNothing keeps this genuinely idempotent: if a concurrent
    // caller (e.g. the tracker cycle seeding the same app) inserted the row
    // between our read and this write, the insert is a no-op instead of a
    // unique-constraint failure.
    db.insert(appSources).values({
      trackedAppId,
      source: source.id,
      enabled: source.defaultEnabled(),
      createdAt: new Date(),
    }).onConflictDoNothing().run();
  }
}
