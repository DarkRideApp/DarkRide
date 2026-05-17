import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export class MigrationFileMissingError extends Error {
  constructor(public readonly tag: string, cause?: unknown) {
    super(`Migration file missing: ${tag}.sql`);
    if (cause) (this as any).cause = cause;
  }
}

export class MigrationFailedError extends Error {
  constructor(
    public readonly idx: number,
    public readonly tag: string,
    public readonly originalError: unknown,
  ) {
    const msg = originalError instanceof Error ? originalError.message : String(originalError);
    super(`Migration ${tag} (idx ${idx}) failed: ${msg}`);
  }
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Apply migrations from one or more folders in the order given. Each folder
 * has the same shape as Drizzle's output: `<folder>/meta/_journal.json` plus
 * a `.sql` file per journal entry.
 *
 * Hash-based dedup means already-applied migrations are skipped, regardless
 * of which folder they're loaded from. This lets per-plugin migrations be
 * processed alongside core's, with a single shared `__drizzle_migrations`
 * tracking table.
 *
 * Folders are processed in array order. Within each folder, migrations are
 * sorted by idx. Use this to control cross-folder ordering — typically core
 * first, then plugins in topological dependency order.
 */
export function applyMigrations(
  sqlite: Database.Database,
  folders: string | string[],
): void {
  const folderList = typeof folders === 'string' ? [folders] : folders;

  // Ensure tracking table exists. Match Drizzle's shape exactly.
  // Drizzle uses "id SERIAL PRIMARY KEY" (not AUTOINCREMENT) — avoids sqlite_sequence side-effect.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
  `);

  // Existing applied hashes — read once before any folder; mutate as we go.
  const appliedHashes = new Set<string>(
    sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all().map((r: any) => r.hash),
  );

  for (const migrationsFolder of folderList) {
    applyMigrationsFromFolder(sqlite, migrationsFolder, appliedHashes);
  }
}

function applyMigrationsFromFolder(
  sqlite: Database.Database,
  migrationsFolder: string,
  appliedHashes: Set<string>,
): void {
  // Load journal.
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal;

  // Sort by idx (NOT when). when is ignored.
  const sorted = [...journal.entries].sort((a, b) => a.idx - b.idx);

  for (const entry of sorted) {
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    let sql: string;
    try {
      sql = readFileSync(sqlPath, 'utf-8');
    } catch (err) {
      throw new MigrationFileMissingError(entry.tag, err);
    }
    // Compute three candidate hashes so we can match Drizzle's stored hash
    // regardless of which platform originally applied each migration.
    //
    // The historical situation: Drizzle hashes raw file bytes. If a migration
    // was applied on Linux, the stored hash is sha256(LF-content). If applied
    // on Windows (autocrlf=true), the stored hash is sha256(CRLF-content).
    // Our working-tree content depends on whatever git put there for THIS
    // checkout — could be either. So we accept any match and write the LF
    // form going forward as the canonical version.
    const sqlLf = sql.replace(/\r\n/g, '\n');
    const sqlCrlf = sqlLf.replace(/\n/g, '\r\n');
    const hashLf = createHash('sha256').update(sqlLf).digest('hex');
    const hashRaw = createHash('sha256').update(sql).digest('hex');
    const hashCrlf = createHash('sha256').update(sqlCrlf).digest('hex');
    if (
      appliedHashes.has(hashLf) ||
      appliedHashes.has(hashRaw) ||
      appliedHashes.has(hashCrlf)
    ) continue;
    const hash = hashLf; // canonical form for new inserts

    const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);

    sqlite.exec('BEGIN');
    try {
      for (const stmt of statements) {
        sqlite.exec(stmt);
      }
      sqlite.prepare(
        `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
      ).run(hash, Date.now());
      sqlite.exec('COMMIT');
      appliedHashes.add(hash);
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw new MigrationFailedError(entry.idx, entry.tag, err);
    }
  }
}
