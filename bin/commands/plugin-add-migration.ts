import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

/** Thrown for user-facing errors (bad input, missing plugin). The CLI prints
 *  the message and exits with code 1; tests catch it directly. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Zero-pad idx to 4 digits, e.g. 3 → "0003". */
export function padIdx(idx: number): string {
  return String(idx).padStart(4, '0');
}

/** Validate migration name: only lowercase letters, digits, underscores. */
export function isValidMigrationName(name: string): boolean {
  return /^[a-z0-9_]+$/.test(name);
}

/** Resolve the plugin directory for a workspace plugin (plugins/<name>). */
export function resolvePluginDir(pluginName: string): string | null {
  const pluginsDir = resolve('./plugins');
  const pluginDir = join(pluginsDir, pluginName);
  if (!existsSync(pluginDir)) return null;
  const pkgPath = join(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (!pkg.keywords?.includes('darkride-plugin')) return null;
  } catch {
    return null;
  }
  return pluginDir;
}

/**
 * Compute the next migration index by scanning existing `.sql` files in the
 * plugin's migrations directory. Looks for the leading 4-digit prefix on each
 * `.sql` file (e.g. `0003_foo.sql` → idx 3) and returns max+1, or 0 if no
 * files exist.
 */
export function nextIdxFromDir(migrationsDir: string): number {
  if (!existsSync(migrationsDir)) return 0;
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
  let max = -1;
  for (const file of files) {
    const m = /^(\d+)_/.exec(file);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Core logic — separated for testability. Throws UserError on bad input. */
export function runAddMigrationCore(pluginName: string, migrationName: string): void {
  if (!isValidMigrationName(migrationName)) {
    throw new UserError(
      `Invalid migration name "${migrationName}".\n` +
      `Migration names must contain only lowercase letters, digits, and underscores.\n` +
      `Example: add_user_settings`,
    );
  }

  const pluginDir = resolvePluginDir(pluginName);
  if (!pluginDir) {
    throw new UserError(
      `Plugin "${pluginName}" not found in plugins/ directory.\n` +
      `Run \`darkride plugin list\` to see installed plugins.`,
    );
  }

  const migrationsDir = join(pluginDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });

  const idx = nextIdxFromDir(migrationsDir);
  const tag = `${padIdx(idx)}_${migrationName}`;
  const sqlFile = join(migrationsDir, `${tag}.sql`);

  const sqlContent = `-- ${pluginName}: ${migrationName}
-- Add your DDL/DML here. Multi-statement migrations MUST include
--> statement-breakpoint
-- between each statement (better-sqlite3 rejects multi-statement SQL otherwise).

`;
  writeFileSync(sqlFile, sqlContent, 'utf-8');

  console.log(`Created plugins/${pluginName}/migrations/${tag}.sql`);
  console.log(`Edit it, then restart the dev server (or production) to apply on next boot.`);
}

export async function pluginAddMigration(args: string[]): Promise<void> {
  if (args.length < 2 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage: darkride plugin add-migration <plugin-name> <migration-name>

  <plugin-name>      Name of a workspace plugin under plugins/
  <migration-name>   Snake_case identifier, e.g. add_user_settings
                     Only lowercase letters, digits, and underscores allowed.

Example:
  darkride plugin add-migration my-plugin add_user_settings
`.trim());
    if (args[0] !== '--help' && args[0] !== '-h') {
      process.exit(1);
    }
    return;
  }

  const [pluginName, migrationName] = args;

  try {
    runAddMigrationCore(pluginName, migrationName);
  } catch (err) {
    if (err instanceof UserError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
