import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';

export const SYSTEM_USERNAME = '__system__';
export const SYSTEM_PROVIDER_ID = 'core.system';
const SYSTEM_SCOPES = ['core.admin:*'];

/**
 * Ensure the `__system__` user row exists. Used by background AI jobs
 * (e.g. APK auto-analyze) that don't have a human user in context.
 *
 * - Can't log in interactively (provider_id 'core.system' is not a valid
 *   login provider, password_hash is null).
 * - Owns the ephemeral PATs minted for auto-run tasks, so admins can
 *   audit background AI activity via `api_keys WHERE user_id = <systemId>`.
 *
 * Returns the user id.
 */
export function ensureSystemUser(db: BetterSQLite3Database<any>): number {
  const existing = db.select().from(users).where(eq(users.username, SYSTEM_USERNAME)).get();
  if (existing) {
    // Patch legacy rows that were created before the kind column existed (defaulted to 'human').
    // __system__ must be 'core-service' so bootstrap and isSetupRequired ignore it.
    if (existing.kind !== 'core-service') {
      db.update(users).set({ kind: 'core-service' }).where(eq(users.id, existing.id)).run();
    }
    return existing.id;
  }

  const now = new Date();
  const created = db.insert(users).values({
    username: SYSTEM_USERNAME,
    providerId: SYSTEM_PROVIDER_ID,
    displayName: 'DarkRide System',
    passwordHash: null,
    scopes: SYSTEM_SCOPES,
    kind: 'core-service' as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }).returning().get();
  return created.id;
}
