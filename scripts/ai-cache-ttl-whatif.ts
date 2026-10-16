/**
 * Replays the recorded AI requests under a 5-minute and a 1-hour prompt cache and prints which would have cost less,
 * per purpose. Reads the database and nothing else; it changes nothing and makes no AI request.
 *
 *   npx tsx scripts/ai-cache-ttl-whatif.ts [--db <path>] [--days <1-365>]
 *
 * The database is DATABASE_PATH, or ./data/darkride.db, unless --db says otherwise. Run it against a copy of the
 * file when the server is on another machine. The window is the last 30 days unless --days says otherwise.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import * as schema from '../backend/db/schema';
import { AI_MODEL_PRICES_SETTING } from '../backend/services/ai-call-logger';
import { formatWhatIf, loadWhatIfRuns, simulateCacheTtl } from '../backend/services/ai-cache-ttl-whatif';

const USAGE = 'Usage: npx tsx scripts/ai-cache-ttl-whatif.ts [--db <path>] [--days <1-365>]';

export interface WhatIfOptions { dbPath: string; days: number; now?: Date }

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): WhatIfOptions {
  let dbPath = env.DATABASE_PATH || './data/darkride.db';
  let days = 30;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`--db needs a path\n${USAGE}`);
      dbPath = value;
    } else if (arg === '--days') {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 365) {
        throw new Error(`--days must be a whole number from 1 to 365\n${USAGE}`);
      }
      days = Number(value);
    } else {
      throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    }
  }
  return { dbPath, days };
}

export function runCacheTtlWhatIf(opts: WhatIfOptions): string {
  if (!existsSync(opts.dbPath)) throw new Error(`No database at ${opts.dbPath}`);
  const sqlite = new Database(opts.dbPath, { readonly: true });
  try {
    const db = drizzle(sqlite, { schema });
    const overrides = db.select({ value: schema.settings.value }).from(schema.settings)
      .where(eq(schema.settings.key, AI_MODEL_PRICES_SETTING)).get()?.value;
    const runs = loadWhatIfRuns(db, { days: opts.days, now: opts.now ?? new Date() });
    return formatWhatIf(simulateCacheTtl(runs, overrides), { days: opts.days });
  } finally {
    sqlite.close();
  }
}

if (require.main === module) {
  try {
    process.stdout.write(runCacheTtlWhatIf(parseArgs(process.argv.slice(2), process.env)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
