import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { automationAuthors, automations, users } from '../db/schema';

/** The database or a transaction on it, so a code write and its author change can land together. */
type Db = Pick<AppDatabase, 'select' | 'insert' | 'delete'>;

export interface AuthorIdentity {
  userId: number;
  /** Scopes of the credential that saved the code (an API key's scopes, not its owner's). */
  effectiveScopes: Set<string>;
}

export type ToolAccess =
  | { kind: 'trusted' }
  | { kind: 'denied'; reason: string }
  /** Both sets must cover a tool's scope: what the credential held when it saved, and what the author holds now. */
  | { kind: 'scoped'; snapshot: Set<string>; current: Set<string> };

const CLAIM_HINT = 'Save the automation in the editor to claim it.';

export function recordAuthor(db: Db, automationId: number, author: AuthorIdentity): void {
  const scopes = [...author.effectiveScopes];
  const updatedAt = new Date();
  db.insert(automationAuthors)
    .values({ automationId, userId: author.userId, scopes, updatedAt })
    .onConflictDoUpdate({ target: automationAuthors.automationId, set: { userId: author.userId, scopes, updatedAt } })
    .run();
}

export function clearAuthor(db: Db, automationId: number): void {
  db.delete(automationAuthors).where(eq(automationAuthors.automationId, automationId)).run();
}

/** The author's user id right now, or null for none. A run compares it to the value it started with. */
export function currentAuthorId(db: Db, automationId: number): number | null {
  const row = db.select({ userId: automationAuthors.userId }).from(automationAuthors).where(eq(automationAuthors.automationId, automationId)).get();
  return row?.userId ?? null;
}

/** Make the caller the author; a request with no identity leaves the script unclaimed. */
export function claimAutomation(db: Db, automationId: number, caller?: AuthorIdentity): void {
  if (caller) recordAuthor(db, automationId, caller);
  else clearAuthor(db, automationId);
}

// Older rows can hold the JSON text of the array instead of the array.
function toScopeSet(raw: unknown): Set<string> {
  const list = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
  return new Set(list as string[]);
}

/** Decide what a script's `tools` calls may do, read fresh on every call so a revoked scope bites at once. */
export function resolveToolAccess(db: Db, automationId: number): ToolAccess {
  const automation = db
    .select({
      managedBy: automations.managedBy,
      isOverridden: automations.isOverridden,
      code: automations.code,
      currentDefaultCode: automations.currentDefaultCode,
    })
    .from(automations)
    .where(eq(automations.id, automationId))
    .get();
  if (!automation) return { kind: 'denied', reason: 'Tool access denied: the automation no longer exists.' };

  // A plugin's own script is the plugin's code. The override flag alone is not proof: the generic
  // update route and the AI code tools rewrite `code` without setting it, so the code must still match what the plugin ships.
  const shippedByPlugin = automation.managedBy != null
    && !automation.isOverridden
    && automation.currentDefaultCode != null
    && automation.code === automation.currentDefaultCode;
  if (shippedByPlugin) return { kind: 'trusted' };

  const author = db.select().from(automationAuthors).where(eq(automationAuthors.automationId, automationId)).get();
  if (!author) return { kind: 'denied', reason: `Tool access denied: this automation has no author on record. ${CLAIM_HINT}` };

  const removed: ToolAccess = { kind: 'denied', reason: `Tool access denied: the author's account was removed. ${CLAIM_HINT}` };
  if (author.userId == null) return removed;
  const user = db.select({ scopes: users.scopes, enabled: users.enabled }).from(users).where(eq(users.id, author.userId)).get();
  if (!user) return removed;
  if (!user.enabled) return { kind: 'denied', reason: "Tool access denied: the author's account is disabled." };

  return { kind: 'scoped', snapshot: toScopeSet(author.scopes), current: toScopeSet(user.scopes) };
}
