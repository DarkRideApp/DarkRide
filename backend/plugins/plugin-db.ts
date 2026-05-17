import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';

/**
 * Creates a Drizzle database instance scoped to a plugin's schema.
 * The plugin gets full read/write access to its own tables.
 */
export function createPluginDb<T extends Record<string, unknown>>(
  sqliteDb: Database.Database,
  pluginSchema: T,
): BetterSQLite3Database<T> {
  return drizzle(sqliteDb, { schema: pluginSchema });
}
