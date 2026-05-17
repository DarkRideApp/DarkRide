import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import Database from 'better-sqlite3';
import {
  createTestDb as sdkCreateTestDb,
  generateCreateSQL,
  topoSort,
  type CreateTestDbOptions,
} from '@darkrideapp/plugin-sdk/test-utils';
import * as schema from '../db/schema';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Create a host-shaped test DB. Wraps the SDK's generic createTestDb
 * with the host schema baked in. Backend host tests use this; plugin
 * tests use the SDK version directly with their own plugin schema.
 */
export function createTestDb(tables?: SQLiteTable[], options?: CreateTestDbOptions) {
  return sdkCreateTestDb(schema, tables, options);
}

export { generateCreateSQL, topoSort };
export type { CreateTestDbOptions };

/**
 * Apply every migration SQL file under migrations/ (in filename order)
 * to the given better-sqlite3 Database. Splits each file on
 * `--> statement-breakpoint` and runs each statement via sqlite.exec().
 *
 * Use this from any test that needs a realistic DB schema. It catches
 * migration-file syntax errors that schema-synthesis helpers miss.
 *
 * Stays in backend because it reads the project's migrations/ directory.
 */
export function applyMigrations(sqlite: Database.Database): void {
  // Core migrations live at the project root.
  const coreDir = path.resolve(__dirname, '../../migrations');
  if (!fs.existsSync(coreDir)) {
    throw new Error(`Migrations directory not found at ${coreDir}`);
  }

  applyMigrationsFromDir(sqlite, coreDir);

  // Each plugin may carry its own migrations at plugins/<name>/migrations/.
  // Apply them in plugin-name alphabetical order — tests don't need full topo
  // ordering since plugin migrations don't have cross-plugin SQL dependencies.
  const pluginsRoot = path.resolve(__dirname, '../../plugins');
  if (fs.existsSync(pluginsRoot)) {
    for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const pluginMigrationsDir = path.join(pluginsRoot, entry.name, 'migrations');
      if (fs.existsSync(pluginMigrationsDir)) {
        applyMigrationsFromDir(sqlite, pluginMigrationsDir);
      }
    }
  }
}

function applyMigrationsFromDir(sqlite: Database.Database, dir: string): void {
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    const statements = content
      .split(/-->\s*statement-breakpoint/g)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      sqlite.exec(stmt);
    }
  }
}
