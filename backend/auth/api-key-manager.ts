import { randomBytes, createHash } from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { apiKeys, users } from '../db/schema';
import { scopeMatches } from './scope-matcher';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const KEY_PREFIX = 'darkride_pat_';

export class ApiKeyManager {
  constructor(private db: BetterSQLite3Database<any>) {}

  create(
    userId: number,
    name: string,
    requestedScopes: string[],
    expiresAt: Date | null,
    internal = false,
  ): { id: number; key: string; keyPrefix: string } {
    if (!name || name.trim().length === 0) {
      throw new Error('Key name is required');
    }

    // No wildcards in user-created key scopes — prevents users from minting
    // keys with broader grants than intended. Internal mints (e.g. AI Assistant
    // ephemeral tokens) are server-driven actions that inherit the user's
    // live scope set verbatim, so the rule doesn't apply.
    if (!internal) {
      for (const scope of requestedScopes) {
        if (scope.includes('*')) {
          throw new Error('API key scopes cannot contain wildcards — pick specific scopes');
        }
      }
    }

    // All scopes must be covered by user's grants
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new Error('User not found');

    const userScopes = new Set(
      (Array.isArray(user.scopes) ? user.scopes : JSON.parse(user.scopes as any)) as string[]
    );
    for (const scope of requestedScopes) {
      if (!scopeMatches(userScopes, scope)) {
        throw new Error(`You don't have scope '${scope}' — can't grant it to an API key`);
      }
    }

    // Generate key
    const keyBytes = randomBytes(20);
    const key = KEY_PREFIX + keyBytes.toString('hex');
    const keyHash = createHash('sha256').update(key).digest('hex');
    const keyPrefix = keyBytes.toString('hex').substring(0, 8);

    const now = new Date();
    const result = this.db.insert(apiKeys).values({
      userId,
      name: name.trim(),
      keyHash,
      keyPrefix,
      scopes: requestedScopes,
      expiresAt,
      internal,
      createdAt: now,
    }).run();

    return { id: Number(result.lastInsertRowid), key, keyPrefix };
  }

  listForUser(userId: number) {
    return this.db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt), eq(apiKeys.internal, false)))
      .all();
  }

  listAll() {
    return this.db.select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys)
      .where(isNull(apiKeys.revokedAt))
      .all();
  }

  revoke(keyId: number, userId: number): boolean {
    const result = this.db.update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .run();
    return result.changes > 0;
  }

  revokeAsAdmin(keyId: number): boolean {
    const result = this.db.update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId))
      .run();
    return result.changes > 0;
  }

  revokeInternalOrphans(): number {
    const result = this.db.update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(apiKeys.internal, true),
        isNull(apiKeys.revokedAt),
      )).run();
    return (result as any).changes ?? 0;
  }
}
