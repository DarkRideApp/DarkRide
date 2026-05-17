import { eq, and } from 'drizzle-orm';
import { users } from '../../db/schema';
import { verifyPassword } from '../password';
import { checkIpRateLimit } from '../rate-limiter';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const DELAY_SCHEDULE = [
  { threshold: 5,  delayMs: 5_000 },
  { threshold: 10, delayMs: 30_000 },
  { threshold: 15, delayMs: 60_000 },
];
const HARD_LOCK_THRESHOLD = 20;
const MIN_DELAY_MS = 200;

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface LocalAuthResult {
  userId: number;
  username: string;
  scopes: string[];
}

export async function authenticateLocal(
  db: BetterSQLite3Database<any>,
  username: string,
  password: string,
  ip: string,
): Promise<LocalAuthResult> {
  const ipCheck = checkIpRateLimit(ip);
  if (!ipCheck.allowed) {
    await sleep(MIN_DELAY_MS);
    throw new AuthenticationError('Too many login attempts. Please wait before trying again.');
  }

  const start = Date.now();

  const user = db.select().from(users)
    .where(and(eq(users.username, username), eq(users.providerId, 'core.local')))
    .get();

  if (!user || !user.passwordHash) {
    await enforceMinDelay(start);
    throw new AuthenticationError('Invalid username or password');
  }

  if (!user.enabled) {
    await enforceMinDelay(start);
    throw new AuthenticationError('Account is disabled');
  }

  // Hard lock check
  if (user.failedLoginAttempts >= HARD_LOCK_THRESHOLD) {
    await enforceMinDelay(start);
    throw new AuthenticationError('Account locked. Contact an administrator.');
  }

  // Progressive delay check (lockedUntil used for temporary delays)
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await enforceMinDelay(start);
    throw new AuthenticationError('Invalid username or password. Too many attempts — please wait before trying again.');
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const delay = getProgressiveDelay(attempts);

    // Set lockedUntil for progressive delay so subsequent attempts are also blocked
    const lockedUntil = delay > 0 ? new Date(Date.now() + delay) : null;

    db.update(users)
      .set({ failedLoginAttempts: attempts, lockedUntil })
      .where(eq(users.id, user.id))
      .run();

    await enforceMinDelay(start);
    throw new AuthenticationError('Invalid username or password');
  }

  // Success — reset counter
  const rawScopes = user.scopes;
  const scopes = (Array.isArray(rawScopes) ? rawScopes : JSON.parse(rawScopes as any)) as string[];

  db.update(users)
    .set({
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .run();

  await enforceMinDelay(start);

  return { userId: user.id, username: user.username, scopes };
}

function getProgressiveDelay(attempts: number): number {
  for (let i = DELAY_SCHEDULE.length - 1; i >= 0; i--) {
    if (attempts >= DELAY_SCHEDULE[i].threshold) return DELAY_SCHEDULE[i].delayMs;
  }
  return 0;
}

async function enforceMinDelay(startMs: number): Promise<void> {
  const elapsed = Date.now() - startMs;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
