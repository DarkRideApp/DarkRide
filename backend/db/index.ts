import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { applyMigrations } from './migrator';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import * as schema from './schema';
import { validateAndRepairSchema } from './schema-validator';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export function initDatabase(dbPath: string): AppDatabase {
  // Ensure the directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);

  // Apply SQLite optimizations
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('cache_size = -64000'); // 64MB cache
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
  sqlite.pragma('busy_timeout = 5000'); // 5s retry on SQLITE_BUSY

  const db = drizzle(sqlite, { schema });

  // Run migrations on startup
  applyMigrations(sqlite, './migrations');

  // Validate schema matches Drizzle definitions and repair any drift.
  // This catches partially-applied migrations, skipped migrations,
  // and SQLite version incompatibilities that cause silent failures.
  validateAndRepairSchema(sqlite);

  return db;
}
