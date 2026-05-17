/**
 * Post-migration schema validator.
 *
 * Drizzle's migrator marks migrations as "applied" even when they partially
 * fail (e.g. one statement in a multi-statement migration errors out). This
 * leaves the DB in a broken state where the code expects columns that don't
 * exist.
 *
 * This validator runs AFTER migrations and compares every table's actual
 * columns (via PRAGMA table_info) against the Drizzle schema definition.
 * Missing columns are added automatically with ALTER TABLE.
 *
 * Missing TABLES are also created — if an entire migration was skipped.
 */
import type Database from 'better-sqlite3';
import { getTableName, getTableColumns, type Table } from 'drizzle-orm';
import { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('schema-validator');

interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Validate and repair the database schema after migrations.
 * Returns the number of repairs made.
 */
export function validateAndRepairSchema(sqlite: Database.Database): number {
  let repairs = 0;

  // Get all tables defined in the Drizzle schema
  const schemaTables = Object.entries(schema).filter(
    ([, value]) => value && typeof value === 'object' && getTableName(value as any),
  ) as [string, Table][];

  for (const [exportName, table] of schemaTables) {
    const tableName = getTableName(table);
    if (!tableName) continue;

    // Check if the table exists at all
    const tableExists = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(tableName);

    if (!tableExists) {
      log(`Table "${tableName}" missing — creating via schema definition`);
      try {
        createTableFromSchema(sqlite, tableName, table);
        repairs++;
      } catch (err: any) {
        error(`Failed to create table "${tableName}": ${err.message}`);
      }
      continue;
    }

    // Table exists — check columns
    const actualColumns = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as PragmaColumn[];
    const actualColumnNames = new Set(actualColumns.map(c => c.name));

    const expectedColumns = getTableColumns(table);

    for (const [, column] of Object.entries(expectedColumns)) {
      const col = column as SQLiteColumn;
      const columnName = col.name;

      if (!actualColumnNames.has(columnName)) {
        const sqlType = getSqliteType(col);
        log(`Column "${tableName}"."${columnName}" missing — adding (${sqlType})`);
        try {
          const defaultClause = getDefaultClause(col);
          sqlite.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${sqlType}${defaultClause}`);
          repairs++;
        } catch (err: any) {
          error(`Failed to add column "${tableName}"."${columnName}": ${err.message}`);
        }
      }
    }
  }

  // Verify essential seed data exists
  repairs += ensureSeedData(sqlite);

  if (repairs > 0) {
    log(`Schema validation complete — ${repairs} repair(s) applied`);
  }

  return repairs;
}

/**
 * Ensure essential seed data exists.
 * Catches cases where migration INSERTs failed (e.g. unixepoch() on old SQLite).
 */
function ensureSeedData(sqlite: Database.Database): number {
  let repairs = 0;

  // Built-in DarkRide signing key must exist
  try {
    const hasKey = sqlite.prepare(
      `SELECT id FROM trusted_signing_keys WHERE id = 'darkride-official'`,
    ).get();

    if (!hasKey) {
      sqlite.prepare(
        `INSERT INTO trusted_signing_keys (id, public_key, label, built_in, created_at)
         VALUES (?, ?, ?, 1, ?)`,
      ).run(
        'darkride-official',
        'MCowBQYDK2VwAyEAhYfjgsV0gzpQbh/Jxr22CvOb01svQdbmdZ39zDze0qM=',
        'DarkRide Official',
        Math.floor(Date.now() / 1000),
      );
      log('Inserted missing built-in signing key: darkride-official');
      repairs++;
    }
  } catch {
    // Table might not exist yet (handled by column repair above)
  }

  // Default plugin source must exist
  try {
    const hasDefault = sqlite.prepare(
      `SELECT id FROM plugin_sources WHERE is_default = 1`,
    ).get();

    if (!hasDefault) {
      sqlite.prepare(
        `INSERT INTO plugin_sources (name, type, url, enabled, is_default, priority, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, 0, ?, ?)`,
      ).run(
        'DarkRide Official',
        'registry',
        'https://darkride.app/plugins.json',
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      );
      log('Inserted missing default plugin source: DarkRide Official');
      repairs++;
    }
  } catch {
    // Table might not exist yet
  }

  return repairs;
}

/**
 * Map a Drizzle column to its SQLite type string.
 */
function getSqliteType(column: SQLiteColumn): string {
  const dataType = column.dataType;
  switch (dataType) {
    case 'string': return 'TEXT';
    case 'number': return 'INTEGER';
    case 'boolean': return 'INTEGER';
    case 'bigint': return 'INTEGER';
    case 'json': return 'TEXT';
    case 'buffer': return 'BLOB';
    default: return 'TEXT';
  }
}

/**
 * Generate a DEFAULT clause for ALTER TABLE ADD COLUMN.
 */
function getDefaultClause(column: SQLiteColumn): string {
  if (column.hasDefault && column.default !== undefined) {
    const val = column.default;
    if (typeof val === 'string') return ` DEFAULT '${val}'`;
    if (typeof val === 'number' || typeof val === 'boolean') return ` DEFAULT ${Number(val)}`;
  }
  if (column.notNull) {
    // NOT NULL columns need a default for ALTER TABLE
    const dataType = column.dataType;
    if (dataType === 'string') return ` NOT NULL DEFAULT ''`;
    if (dataType === 'number' || dataType === 'boolean') return ` NOT NULL DEFAULT 0`;
  }
  return '';
}

/**
 * Create a table from its Drizzle schema definition.
 * Used when an entire migration was skipped.
 */
function createTableFromSchema(sqlite: Database.Database, tableName: string, table: Table): void {
  const columns = getTableColumns(table);
  const colDefs: string[] = [];

  for (const [, column] of Object.entries(columns)) {
    const col = column as SQLiteColumn;
    const sqlType = getSqliteType(col);
    let def = `"${col.name}" ${sqlType}`;

    if (col.primary) def += ' PRIMARY KEY';
    if ((col as any).autoIncrement) def += ' AUTOINCREMENT';
    if (col.notNull && !col.primary) def += ' NOT NULL';
    if (col.hasDefault && col.default !== undefined) {
      const val = col.default;
      if (typeof val === 'string') def += ` DEFAULT '${val}'`;
      else if (typeof val === 'number' || typeof val === 'boolean') def += ` DEFAULT ${Number(val)}`;
    }

    colDefs.push(def);
  }

  sqlite.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')})`);
}
