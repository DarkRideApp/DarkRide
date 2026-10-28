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

const CLAIM_HINT = 'Save the automation in the editor, or use Claim all on the Automations page.';

// A plugin's own script is the plugin's code. The override flag alone is not proof: the generic
// update route and the AI code tools rewrite `code` without setting it, so the code must still match what the plugin ships.
function isShippedByPlugin(a: { managedBy: string | null; isOverridden: boolean | null; code: string; currentDefaultCode: string | null }): boolean {
  return a.managedBy != null && !a.isOverridden && a.currentDefaultCode != null && a.code === a.currentDefaultCode;
}

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

/**
 * Scripts that cannot use gated calls until someone claims them: no author on record, or an author whose account is gone.
 * A plugin's own unmodified script needs none.
 */
export function listUnclaimed(db: Db): number[] {
  const authorOf = new Map(
    db.select({ automationId: automationAuthors.automationId, userId: automationAuthors.userId }).from(automationAuthors).all()
      .map((row) => [row.automationId, row.userId] as const),
  );
  const accounts = new Set(db.select({ id: users.id }).from(users).all().map((row) => row.id));
  return db
    .select({ id: automations.id, managedBy: automations.managedBy, isOverridden: automations.isOverridden, code: automations.code, currentDefaultCode: automations.currentDefaultCode })
    .from(automations)
    .all()
    .filter((a) => {
      if (isShippedByPlugin(a)) return false;
      const userId = authorOf.get(a.id);
      return userId == null || !accounts.has(userId);
    })
    .map((a) => a.id);
}

/** Make the caller the author of every unclaimed script; scripts that already have an author are left alone. Returns how many. */
export function claimUnclaimed(db: Db, caller: AuthorIdentity): number {
  const ids = listUnclaimed(db);
  for (const id of ids) recordAuthor(db, id, caller);
  return ids.length;
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
  if (!automation) return { kind: 'denied', reason: 'Access denied: the automation no longer exists.' };

  if (isShippedByPlugin(automation)) return { kind: 'trusted' };

  const author = db.select().from(automationAuthors).where(eq(automationAuthors.automationId, automationId)).get();
  if (!author) return { kind: 'denied', reason: `Access denied: this automation has no author on record. ${CLAIM_HINT}` };

  const removed: ToolAccess = { kind: 'denied', reason: `Access denied: the author's account was removed. ${CLAIM_HINT}` };
  if (author.userId == null) return removed;
  const user = db.select({ scopes: users.scopes, enabled: users.enabled }).from(users).where(eq(users.id, author.userId)).get();
  if (!user) return removed;
  if (!user.enabled) return { kind: 'denied', reason: "Access denied: the author's account is disabled." };

  return { kind: 'scoped', snapshot: toScopeSet(author.scopes), current: toScopeSet(user.scopes) };
}
