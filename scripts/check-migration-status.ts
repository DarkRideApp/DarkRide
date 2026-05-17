import Database from 'better-sqlite3';
import { existsSync } from 'fs';

const dbPath = process.env.DATABASE_PATH || './data/darkride.db';
const db = new Database(dbPath, { readonly: true });

const count = db.prepare('SELECT count(*) as c FROM __drizzle_migrations').get() as any;
console.log('Migrations applied:', count.c);

const cols = db.prepare("PRAGMA table_info('cloud_files')").all() as any[];
console.log('cloud_files columns:', cols.map((c: any) => c.name));

const hasNamespace = cols.some((c: any) => c.name === 'namespace');
console.log('Has namespace column:', hasNamespace);

if (!hasNamespace) {
  console.log('\nMigration 0062 was NOT applied. Checking why...');
  const hashes = db.prepare('SELECT hash FROM __drizzle_migrations').all() as any[];
  console.log('Total migration hashes:', hashes.length);

  // Check if cloud_file_locks still exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  const hasLocks = tables.some((t: any) => t.name === 'cloud_file_locks');
  console.log('cloud_file_locks table exists:', hasLocks);
}

db.close();
