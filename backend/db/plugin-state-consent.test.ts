import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { applyMigrations } from '../test-utils/create-test-db';

describe('pluginState.approvedAiScopes', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    applyMigrations(sqlite);
    db = drizzle(sqlite, { schema });
  });

  it('defaults to null when no consent recorded', () => {
    db.insert(schema.pluginState).values({
      name: 'demo',
      enabled: false,
      installedVia: 'npm',
      installedAt: new Date(),
      updatedAt: new Date(),
    } as any).run();
    const row = db.select().from(schema.pluginState)
      .where(eq(schema.pluginState.name, 'demo')).get();
    expect(row).toBeDefined();
    expect(row!.approvedAiScopes).toBeNull();
  });

  it('stores approved scope array', () => {
    db.insert(schema.pluginState).values({
      name: 'demo',
      enabled: true,
      installedVia: 'npm',
      approvedAiScopes: ['core.apk:read', 'mcp'] as any,
      installedAt: new Date(),
      updatedAt: new Date(),
    } as any).run();
    const row = db.select().from(schema.pluginState)
      .where(eq(schema.pluginState.name, 'demo')).get();
    expect(row!.approvedAiScopes).toEqual(['core.apk:read', 'mcp']);
  });
});
