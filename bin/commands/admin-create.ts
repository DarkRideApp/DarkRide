import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import * as schema from '../../backend/db/schema';
import { hashPassword, validatePasswordPolicy } from '../../backend/auth/password';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * Core logic — testable, no process.exit, no env var reads.
 * The CLI wrapper below handles args + env + DB path resolution.
 */
export async function createAdminUser(
  db: BetterSQLite3Database<any>,
  username: string,
  password: string,
  opts: { forceAdd?: boolean } = {},
): Promise<{ userId: number }> {
  // Check for existing users
  const existingUsers = db.select({ id: schema.users.id }).from(schema.users).all();
  if (existingUsers.length > 0 && !opts.forceAdd) {
    throw new Error(`${existingUsers.length} user(s) already exist. Use --force-add-admin to add another admin.`);
  }

  // Check for duplicate username
  const dup = db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.username, username))
    .get();
  if (dup) {
    throw new Error(`Username "${username}" already exists.`);
  }

  // Validate password
  const policyCheck = validatePasswordPolicy(password, username, null);
  if (!policyCheck.valid) {
    throw new Error(`Password policy violation: ${policyCheck.reason}`);
  }

  // Create admin
  const now = new Date();
  const hash = await hashPassword(password);
  const result = db.insert(schema.users).values({
    username,
    passwordHash: hash,
    passwordUpdatedAt: now,
    providerId: 'core.local',
    scopes: JSON.stringify(['core.admin:*']) as any,
    createdAt: now,
    updatedAt: now,
  }).run();

  return { userId: Number(result.lastInsertRowid) };
}

/**
 * CLI wrapper — handles args, env vars, DB path, process.exit.
 */
export async function adminCreate(args: string[]): Promise<void> {
  let username: string | null = null;
  let passwordEnvVar: string | null = null;
  let forceAdd = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) username = args[++i];
    if (args[i] === '--password-from-env' && args[i + 1]) passwordEnvVar = args[++i];
    if (args[i] === '--force-add-admin') forceAdd = true;
  }

  if (!username || !passwordEnvVar) {
    console.error('Usage: darkride admin create --username NAME --password-from-env ENV_VAR [--force-add-admin]');
    console.error('');
    console.error('Creates an admin user with core.admin:* scope.');
    console.error('The password is read from the specified environment variable (never from the command line).');
    console.error('');
    console.error('Options:');
    console.error('  --username NAME          Username for the new admin');
    console.error('  --password-from-env VAR  Environment variable containing the password');
    console.error('  --force-add-admin        Allow creating when users already exist');
    process.exit(1);
  }

  const password = process.env[passwordEnvVar];
  if (!password) {
    console.error(`Error: Environment variable ${passwordEnvVar} is not set or is empty`);
    process.exit(1);
  }

  const dbPath = process.env.DATABASE_PATH || './data/darkride.db';

  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    console.error('Start the server at least once to create the database, or set DATABASE_PATH.');
    process.exit(1);
  }

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });

  try {
    await createAdminUser(db, username, password, { forceAdd });
    console.log(`Admin user "${username}" created with core.admin:* scope.`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    sqlite.close();
  }
}
