import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';
import { fetchIconFromSources } from './apk-tracker';
import { SourceRegistry } from './apk-sources/registry';
import type { RemoteApkSource } from './apk-sources/types';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

/** Minimal fake source that records fetchIcon calls and returns a fixed result. */
function fakeSource(id: string, opts: {
  fetchIcon?: (pkg: string) => Promise<boolean>;
  enabledDefault?: boolean;
} = {}): RemoteApkSource {
  return {
    id,
    label: id,
    isConfigured: () => true,
    defaultEnabled: () => opts.enabledDefault ?? true,
    checkVersion: async () => null,
    downloadApk: async () => ({ success: false }),
    ...(opts.fetchIcon ? { fetchIcon: opts.fetchIcon } : {}),
  };
}

function seedApp(db: BetterSQLite3Database<typeof schema>, packageName: string): number {
  const app = db.insert(schema.trackedApps).values({
    packageName, appName: packageName, createdAt: new Date(),
  } as any).returning({ id: schema.trackedApps.id }).get();
  return app.id;
}

function seedSourceRow(
  db: BetterSQLite3Database<typeof schema>,
  trackedAppId: number,
  source: string,
  enabled: boolean,
): void {
  db.insert(schema.appSources).values({
    trackedAppId, source, enabled, createdAt: new Date(),
  } as any).run();
}

describe('fetchIconFromSources', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns false when the registry is null', async () => {
    expect(await fetchIconFromSources(db, null, 'com.foo')).toBe(false);
  });

  it('returns false when the package is not tracked', async () => {
    const reg = new SourceRegistry().register(fakeSource('qq', { fetchIcon: async () => true }));
    expect(await fetchIconFromSources(db, reg, 'com.missing')).toBe(false);
  });

  it('asks an enabled source that implements fetchIcon and returns its success', async () => {
    const id = seedApp(db, 'com.foo');
    seedSourceRow(db, id, 'qq', true);
    let called = '';
    const reg = new SourceRegistry().register(
      fakeSource('qq', { fetchIcon: async (pkg) => { called = pkg; return true; } }),
    );
    expect(await fetchIconFromSources(db, reg, 'com.foo')).toBe(true);
    expect(called).toBe('com.foo');
  });

  it('skips disabled sources', async () => {
    const id = seedApp(db, 'com.foo');
    seedSourceRow(db, id, 'qq', false);
    let called = false;
    const reg = new SourceRegistry().register(
      fakeSource('qq', { fetchIcon: async () => { called = true; return true; } }),
    );
    expect(await fetchIconFromSources(db, reg, 'com.foo')).toBe(false);
    expect(called).toBe(false);
  });

  it('falls through to the next source when the first has no icon', async () => {
    const id = seedApp(db, 'com.foo');
    seedSourceRow(db, id, 'huawei', true);
    seedSourceRow(db, id, 'qq', true);
    const order: string[] = [];
    const reg = new SourceRegistry()
      .register(fakeSource('huawei', { fetchIcon: async () => { order.push('huawei'); return false; } }))
      .register(fakeSource('qq', { fetchIcon: async () => { order.push('qq'); return true; } }));
    expect(await fetchIconFromSources(db, reg, 'com.foo')).toBe(true);
    expect(order).toEqual(['huawei', 'qq']);
  });

  it('ignores a source that throws and tries the next', async () => {
    const id = seedApp(db, 'com.foo');
    seedSourceRow(db, id, 'huawei', true);
    seedSourceRow(db, id, 'qq', true);
    const reg = new SourceRegistry()
      .register(fakeSource('huawei', { fetchIcon: async () => { throw new Error('boom'); } }))
      .register(fakeSource('qq', { fetchIcon: async () => true }));
    expect(await fetchIconFromSources(db, reg, 'com.foo')).toBe(true);
  });

  it('skips sources that do not implement fetchIcon', async () => {
    const id = seedApp(db, 'com.foo');
    seedSourceRow(db, id, 'playstore', true); // no fetchIcon
    const reg = new SourceRegistry().register(fakeSource('playstore'));
    expect(await fetchIconFromSources(db, reg, 'com.foo')).toBe(false);
  });
});
