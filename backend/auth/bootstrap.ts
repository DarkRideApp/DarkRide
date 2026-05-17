import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import { hashPassword, validatePasswordPolicy } from './password';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('auth');

let bootstrapToken: string | null = null;

/**
 * Check if bootstrap is needed and set up accordingly.
 * Called once on server startup AFTER the DB is ready.
 */
export async function checkBootstrap(
  db: BetterSQLite3Database<any>,
  host: string,
  port: number,
): Promise<void> {
  // Only count human users — service accounts (__system__, service:*:ai) are created
  // at startup before bootstrap runs and must not prevent admin account creation.
  const hasUsers = db.select({ id: users.id }).from(users).where(eq(users.kind, 'human')).limit(1).get();
  if (hasUsers) {
    bootstrapToken = null;
    return;
  }

  // Path 3: env-var bootstrap
  const envUsername = process.env.DARKRIDE_BOOTSTRAP_ADMIN_USERNAME;
  const envPassword = process.env.DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD;
  if (envUsername && envPassword) {
    try {
      await createAdminFromEnv(db, envUsername, envPassword);
      return;
    } catch (err: any) {
      error(`Env-var bootstrap failed: ${err.message}`);
      // Fall through to token wizard
    }
  }

  // Path 1: generate bootstrap token
  bootstrapToken = randomBytes(32).toString('hex');
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  log('');
  log('═══════════════════════════════════════════════════════════════');
  log('  No admin user exists. Create the first admin:');
  log(`  http://${displayHost}:${port}/ui/setup?token=${bootstrapToken}`);
  log('  This token expires the moment any user is created.');
  log('  The token is regenerated on every server restart.');
  log('═══════════════════════════════════════════════════════════════');
  log('');
}

export function getBootstrapToken(): string | null {
  return bootstrapToken;
}

export function isSetupRequired(db: BetterSQLite3Database<any>): boolean {
  const hasUsers = db.select({ id: users.id }).from(users).where(eq(users.kind, 'human')).limit(1).get();
  return !hasUsers;
}

/**
 * Complete the bootstrap — create the first admin user.
 * Called from the /v1/auth/setup endpoint.
 */
export async function completeBootstrap(
  db: BetterSQLite3Database<any>,
  token: string,
  username: string,
  password: string,
): Promise<{ userId: number }> {
  // Verify token
  if (!bootstrapToken || token !== bootstrapToken) {
    throw new Error('Invalid or expired setup token');
  }

  // Verify no human users exist (race protection)
  const hasUsers = db.select({ id: users.id }).from(users).where(eq(users.kind, 'human')).limit(1).get();
  if (hasUsers) {
    bootstrapToken = null;
    throw new Error('An admin user already exists');
  }

  // Validate
  if (!username || username.length < 2) {
    throw new Error('Username must be at least 2 characters');
  }
  const policyCheck = validatePasswordPolicy(password, username, null);
  if (!policyCheck.valid) throw new Error(policyCheck.reason!);

  // Create admin
  const now = new Date();
  const hash = await hashPassword(password);
  const result = db.insert(users).values({
    username,
    passwordHash: hash,
    passwordUpdatedAt: now,
    providerId: 'core.local',
    scopes: ['core.admin:*'],
    createdAt: now,
    updatedAt: now,
  }).run();

  const userId = Number(result.lastInsertRowid);
  bootstrapToken = null;
  log(`Admin user "${username}" created via setup wizard`);

  return { userId };
}

async function createAdminFromEnv(
  db: BetterSQLite3Database<any>,
  username: string,
  password: string,
): Promise<void> {
  const policyCheck = validatePasswordPolicy(password, username, null);
  if (!policyCheck.valid) {
    log(`WARNING: Bootstrap password does not meet policy: ${policyCheck.reason}`);
    // Still create — env-var bootstrap should not block startup
  }

  const now = new Date();
  const hash = await hashPassword(password);
  db.insert(users).values({
    username,
    passwordHash: hash,
    passwordUpdatedAt: now,
    providerId: 'core.local',
    scopes: ['core.admin:*'],
    createdAt: now,
    updatedAt: now,
  }).run();

  bootstrapToken = null;
  log(`Admin user "${username}" created via environment variables`);
}
