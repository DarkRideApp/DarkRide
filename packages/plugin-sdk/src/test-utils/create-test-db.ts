import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * Topologically sort tables so referenced tables come before referencing ones.
 * Generic — operates on any Drizzle SQLite table set.
 */
export function topoSort(tables: SQLiteTable[]): SQLiteTable[] {
  const nameToTable = new Map<string, SQLiteTable>();
  for (const t of tables) {
    nameToTable.set(getTableConfig(t).name, t);
  }

  const sorted: SQLiteTable[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(table: SQLiteTable) {
    const cfg = getTableConfig(table);
    if (visited.has(cfg.name)) return;
    if (visiting.has(cfg.name)) return; // cycle — just skip
    visiting.add(cfg.name);

    // Visit dependencies first
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const refTableName = getTableConfig(ref.foreignTable as SQLiteTable).name;
      const dep = nameToTable.get(refTableName);
      if (dep && refTableName !== cfg.name) {
        visit(dep);
      }
    }

    visiting.delete(cfg.name);
    visited.add(cfg.name);
    sorted.push(table);
  }

  for (const t of tables) visit(t);
  return sorted;
}

function formatDefault(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  return String(value);
}

/**
 * Generate a CREATE TABLE statement for a Drizzle table. Generic.
 */
export function generateCreateSQL(table: SQLiteTable): string {
  const cfg = getTableConfig(table);
  const parts: string[] = [];

  for (const col of cfg.columns) {
    let def = `${col.name} ${col.getSQLType()}`;

    if (col.primary && cfg.primaryKeys.length === 0) {
      def += ' PRIMARY KEY';
      if ((col as any).autoIncrement) def += ' AUTOINCREMENT';
    }

    if (col.notNull && !col.primary) def += ' NOT NULL';
    if (col.hasDefault && col.default !== undefined) {
      def += ` DEFAULT ${formatDefault(col.default)}`;
    }
    if (col.isUnique) def += ' UNIQUE';

    parts.push(def);
  }

  // Single-column foreign keys
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference();
    if (ref.columns.length === 1) {
      const colName = (ref.columns[0] as any).name;
      const refTable = getTableConfig(ref.foreignTable as SQLiteTable).name;
      const refCol = (ref.foreignColumns[0] as any).name;
      // Find the column part and append REFERENCES
      const idx = parts.findIndex(p => p.startsWith(colName + ' '));
      if (idx !== -1) {
        parts[idx] += ` REFERENCES ${refTable}(${refCol})`;
      }
    }
  }

  // Composite primary keys
  if (cfg.primaryKeys.length > 0) {
    for (const pk of cfg.primaryKeys) {
      const cols = pk.columns.map((c: any) => c.name).join(', ');
      parts.push(`PRIMARY KEY(${cols})`);
    }
  }

  // Composite unique constraints
  for (const uc of cfg.uniqueConstraints) {
    const cols = uc.columns.map((c: any) => c.name).join(', ');
    parts.push(`UNIQUE(${cols})`);
  }

  return `CREATE TABLE ${cfg.name} (\n  ${parts.join(',\n  ')}\n);`;
}

export interface CreateTestDbOptions {
  /** Enable foreign_keys pragma (default: false for perf, enable in FK-specific tests) */
  foreignKeys?: boolean;
  /** Additional tables to create beyond what's in `schema`. */
  extraTables?: SQLiteTable[];
}

/**
 * Create an in-memory SQLite test database with the provided schema's
 * tables created. Generic — pass any schema.
 *
 * @param schema - The Drizzle schema record (typeof schema export)
 * @param tables - Specific tables to create (default: all from schema)
 * @param options - Additional options
 */
export function createTestDb<S extends Record<string, unknown>>(
  schema: S,
  tables?: SQLiteTable[],
  options?: CreateTestDbOptions,
): BetterSQLite3Database<S> {
  const sqlite = new Database(':memory:');

  // better-sqlite3 defaults to foreign_keys=ON, but most tests don't seed
  // all referenced rows, so we disable by default and let callers opt in.
  if (options?.foreignKeys) {
    sqlite.pragma('foreign_keys = ON');
  } else {
    sqlite.pragma('foreign_keys = OFF');
  }

  // Default to all SQLiteTable values from the schema record
  const allFromSchema: SQLiteTable[] = [];
  for (const value of Object.values(schema)) {
    try {
      getTableConfig(value as SQLiteTable);
      allFromSchema.push(value as SQLiteTable);
    } catch {
      // Not a table export
    }
  }

  const tablesToCreate = tables ? topoSort(tables) : topoSort(allFromSchema);
  for (const table of tablesToCreate) {
    sqlite.exec(generateCreateSQL(table));
  }

  if (options?.extraTables) {
    const sortedExtra = topoSort(options.extraTables);
    for (const table of sortedExtra) {
      sqlite.exec(generateCreateSQL(table));
    }
  }

  return drizzle(sqlite, { schema });
}
