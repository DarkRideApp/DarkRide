import { eq } from 'drizzle-orm';
import { appSources } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { PlayStoreSource } from '../play-store-source';
import { QqSource } from './qq-source';
import { HuaweiSource } from './huawei-source';
import { ApkPureSource } from './apkpure-source';
import { XiaomiSource } from './xiaomi-source';
import { SourceRegistry } from './registry';

export { SourceRegistry } from './registry';
export { QqSource, parseQqRecord } from './qq-source';
export * from './types';

/**
 * Build the default registry of remote APK sources, wired to the DB so each
 * source can read its settings (credentials, defaults). Registration order is
 * the UI display order: download-capable Western/Play first, then the China
 * stores. QQ + Huawei + APKPure can download; Xiaomi is availability-only.
 */
export function createSourceRegistry(db: AppDatabase): SourceRegistry {
  const sources = [
    new PlayStoreSource(),
    new ApkPureSource(),
    new QqSource(),
    new HuaweiSource(),
    new XiaomiSource(),
  ];
  const registry = new SourceRegistry();
  for (const s of sources) {
    s.setDatabase(db);
    registry.register(s);
  }
  return registry;
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
