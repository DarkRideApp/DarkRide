/**
 * One-shot reconciliation: populate __drizzle_migrations with the canonical
 * (LF-normalized) sha256 hash of every migration in the journal, treating
 * each as already-applied. Use this when:
 *
 *   - Your DB schema is up-to-date (the migrations have been applied at
 *     some point, e.g. by Drizzle's old migrator, by hand, or by an older
 *     version of this codebase) but `__drizzle_migrations` is incomplete
 *     or missing rows.
 *   - Switching from Drizzle's old `migrate()` to the in-house
 *     `applyMigrations()` runner has surfaced this discrepancy as
 *     "duplicate column name" / "table already exists" errors at startup.
 *
 * After running this script, the migrator's `appliedHashes` set covers
 * every journal entry, so no migration will be re-applied. Future migrations
 * (those added AFTER the script ran) will apply normally.
 *
 * Run with:
 *   DATABASE_PATH=./data/darkride.db npx tsx scripts/sync-migration-hashes.ts
 *
 * On Windows PowerShell:
 *   $env:DATABASE_PATH=".\data\darkride.db"; npx tsx scripts\sync-migration-hashes.ts
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

function main() {
  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath) {
    console.error('Set DATABASE_PATH to the SQLite file location, e.g.:');
    console.error('  DATABASE_PATH=./data/darkride.db npx tsx scripts/sync-migration-hashes.ts');
    process.exit(1);
  }

  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);

  const journalPath = join('migrations', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  const existing = new Set<string>(
    sqlite.prepare(`SELECT hash FROM __drizzle_migrations`).all().map((r: any) => r.hash),
  );

  let added = 0;
  let alreadyKnown = 0;

  for (const entry of journal.entries) {
    const sqlPath = join('migrations', `${entry.tag}.sql`);
    const sql = readFileSync(sqlPath, 'utf-8').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(sql).digest('hex');

    if (existing.has(hash)) {
      alreadyKnown += 1;
      continue;
    }

    sqlite.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
      .run(hash, Date.now());
    console.log(`+ marked applied: ${entry.tag} (${hash.slice(0, 12)}…)`);
    added += 1;
  }

  sqlite.close();
  console.log('');
  console.log(`Done. Added ${added} hash row(s); ${alreadyKnown} were already present.`);
  console.log('Restart the server now — the migrator will skip every journal entry.');
}

main();
