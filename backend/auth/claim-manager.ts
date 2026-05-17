import { randomBytes, createHash } from 'crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { users, passwordResetTokens } from '../db/schema';
import { hashPassword, validatePasswordPolicy } from './password';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const CLAIM_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ClaimManager {
  constructor(private db: BetterSQLite3Database<any>) {}

  /**
   * Create a new user (no password yet) and generate a claim token.
   * Returns the user ID and plaintext token for the admin to share.
   */
  createUserWithClaim(
    username: string,
    displayName: string | null,
    email: string | null,
    scopes: string[],
  ): { userId: number; token: string; claimUrl: string } {
    if (!username || username.length < 2) {
      throw new Error('Username must be at least 2 characters');
    }

    // Check for existing username
    const existing = this.db.select({ id: users.id }).from(users)
      .where(eq(users.username, username)).get();
    if (existing) throw new Error(`Username "${username}" already exists`);

    const now = new Date();
    const userResult = this.db.insert(users).values({
      username,
      displayName,
      email,
      providerId: 'core.local',
      passwordMustChange: true,
      scopes,
      createdAt: now,
      updatedAt: now,
    }).run();
    const userId = Number(userResult.lastInsertRowid);

    // Generate claim token
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    this.db.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      purpose: 'admin-create',
      createdAt: now,
      expiresAt: new Date(now.getTime() + CLAIM_EXPIRY_MS),
    }).run();

    return { userId, token, claimUrl: `/ui/claim?token=${token}` };
  }

  /**
   * Generate a password reset claim for an existing user.
   */
  createResetClaim(userId: number): { token: string; claimUrl: string } {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new Error('User not found');

    const now = new Date();
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    this.db.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      purpose: 'password-reset',
      createdAt: now,
      expiresAt: new Date(now.getTime() + CLAIM_EXPIRY_MS),
    }).run();

    this.db.update(users)
      .set({ passwordMustChange: true, updatedAt: now })
      .where(eq(users.id, userId))
      .run();

    return { token, claimUrl: `/ui/claim?token=${token}` };
  }

  /**
   * Validate and consume a claim token. Sets the user's password.
   */
  async consumeClaim(token: string, newPassword: string): Promise<{ userId: number; username: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.db.select().from(passwordResetTokens)
      .where(and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ))
      .get();

    if (!row) throw new Error('Invalid or expired claim token');

    const user = this.db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user) throw new Error('User not found');

    const policyCheck = validatePasswordPolicy(newPassword, user.username, user.email);
    if (!policyCheck.valid) throw new Error(policyCheck.reason!);

    const now = new Date();
    const hash = await hashPassword(newPassword);

    this.db.update(users).set({
      passwordHash: hash,
      passwordUpdatedAt: now,
      passwordMustChange: false,
      updatedAt: now,
    }).where(eq(users.id, user.id)).run();

    this.db.update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.id, row.id))
      .run();

    return { userId: user.id, username: user.username };
  }
}
