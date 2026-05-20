import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { createLoggers } from '../logs';

const { error: logError } = createLoggers('plugin-migrator');

export interface PluginRef {
  name: string;
  path: string;
}

export interface PluginMigrationFailure {
  plugin: string;
  filename: string;
  error: string;
}

export interface ApplyResult {
  applied: number;
  total: number;
  /**
   * Per-plugin migration failures. When a plugin's migration file errors,
   * the migrator stops applying further migrations for THAT plugin (the
   * remainder probably depend on the failed one) but continues with the
   * NEXT plugin. The boot sequence is expected to disable each failed
   * plugin via pluginStateManager so it isn't loaded with a half-migrated
   * schema.
   */
  failures: PluginMigrationFailure[];
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Apply any plugin migrations not yet recorded in plugin_migrations.
 *
 * Per plugin: list `<path>/migrations/*.sql`, sort lexicographically, skip
 * filenames already in plugin_migrations(plugin_name=?). For each unseen
 * file, run inside a transaction; on success insert the tracking row.
 *
 * Failure isolation: a failing migration aborts the rest of THAT plugin's
 * queue (later migrations probably depend on the failed one), but the next
 * plugin's migrations still run. Failures are collected and returned for
 * the boot sequence to disable the offending plugins. This avoids the old
 * behaviour where one bad SQL file took down the whole server with no UI
 * recovery path.
 *
 * The transaction guarantees that the tracking row is only written if the
 * SQL itself succeeded, so a fix-and-retry on next boot sees the broken
 * migration as unapplied.
 */
export function applyPluginMigrations(db: Database.Database, plugins: PluginRef[]): ApplyResult {
  let applied = 0;
  let total = 0;
  const failures: PluginMigrationFailure[] = [];

  const isAppliedStmt = db.prepare(
    'SELECT 1 FROM plugin_migrations WHERE plugin_name = ? AND filename = ?',
  );
  const insertStmt = db.prepare(
    'INSERT INTO plugin_migrations (plugin_name, filename, applied_at) VALUES (?, ?, ?)',
  );

  for (const plugin of plugins) {
    const migrationsDir = join(plugin.path, 'migrations');
    if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) continue;

    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let pluginFailed = false;
    for (const filename of files) {
      if (pluginFailed) {
        // Stop the queue for this plugin after the first failure. Don't
        // count later files in `total` either — we never tried them.
        break;
      }
      total += 1;
      const seen = isAppliedStmt.get(plugin.name, filename);
      if (seen) continue;

      const sqlPath = join(migrationsDir, filename);
      const sql = readFileSync(sqlPath, 'utf-8');

      // Transaction wrapper for atomicity. better-sqlite3 commits if the
      // function returns normally, rolls back if it throws.
      const runOne = db.transaction(() => {
        db.exec(sql);
        insertStmt.run(plugin.name, filename, Math.floor(Date.now() / 1000));
      });

      try {
        runOne();
        applied += 1;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const wrapped = `${plugin.name}:${filename}: ${msg}`;
        logError(wrapped);
        failures.push({ plugin: plugin.name, filename, error: wrapped });
        pluginFailed = true;
      }
    }
  }

  return { applied, total, failures };
}

/**
 * List the SQLite tables owned by a plugin. Conventional plugin tables are
 * named `plugin_<name>__*`. Returns an empty array if none exist.
 */
export function listPluginTables(db: Database.Database, pluginName: string): string[] {
  const rawPrefix = `plugin_${pluginName}__`;
  const escapedPrefix = rawPrefix.replace(/_/g, '\\_');
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ESCAPE '\\'",
  ).all(`${escapedPrefix}%`) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Drop all tables created by a plugin's migrations. Conventional plugin tables
 * are named `plugin_<name>__*`. Also clears the plugin's rows from
 * plugin_migrations so a future re-install runs all migrations cleanly.
 *
 * No-op if the plugin has no matching tables. Idempotent.
 */
export function dropPluginTables(db: Database.Database, pluginName: string): void {
  for (const name of listPluginTables(db, pluginName)) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }

  db.prepare('DELETE FROM plugin_migrations WHERE plugin_name = ?').run(pluginName);
}

/**
 * One-time backfill: for each plugin that still has a `meta/_journal.json`,
 * mirror its applied entries (those present in __drizzle_migrations) into
 * plugin_migrations. Idempotent — second-time call is a no-op.
 *
 * After this runs, `applyPluginMigrations` correctly skips already-applied
 * migrations even though the new system doesn't read the journal.
 */
export function backfillPluginMigrationsFromJournal(
  db: Database.Database,
  plugins: PluginRef[],
): void {
  // Drizzle stores migration tags as `hash` in __drizzle_migrations.
  const drizzleStmt = db.prepare('SELECT created_at FROM __drizzle_migrations WHERE hash = ?');
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO plugin_migrations (plugin_name, filename, applied_at) VALUES (?, ?, ?)',
  );

  for (const plugin of plugins) {
    const journalPath = join(plugin.path, 'migrations', 'meta', '_journal.json');
    if (!existsSync(journalPath)) continue;

    let journal: Journal;
    try {
      journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal;
    } catch (err: any) {
      logError(`Failed to parse journal at ${journalPath}: ${err?.message ?? String(err)} — skipping backfill for ${plugin.name}`);
      continue;
    }

    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    for (const entry of entries) {
      const drizzleRow = drizzleStmt.get(entry.tag) as { created_at: number | string } | undefined;
      if (!drizzleRow) continue; // never applied under old system → leave for the new applier

      const filename = `${entry.tag}.sql`;
      const appliedAt = typeof drizzleRow.created_at === 'number'
        ? drizzleRow.created_at
        : Math.floor(Date.now() / 1000);
      insertStmt.run(plugin.name, filename, appliedAt);
    }
  }
}
