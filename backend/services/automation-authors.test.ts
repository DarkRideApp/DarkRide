import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import type { AppDatabase } from '../db/index';
import { recordAuthor, clearAuthor, resolveToolAccess, listUnclaimed, claimUnclaimed } from './automation-authors';

describe('automation authors', () => {
  let db: AppDatabase;
  let userCount = 0;

  beforeEach(() => {
    db = createTestDb();
    userCount = 0;
  });

  function addUser(scopes: string[], enabled = true) {
    const now = new Date();
    db.insert(schema.users).values({
      username: `user${++userCount}`, providerId: 'core.local', scopes, enabled, createdAt: now, updatedAt: now,
    }).run();
    return db.select().from(schema.users).all().pop()!;
  }

  const SHIPPED = 'export default async function() {}';

  // A managed script as the reconciler leaves it: code equals the default the plugin ships.
  function addAutomation(opts: { managedBy?: string; isOverridden?: boolean; code?: string; currentDefaultCode?: string | null } = {}) {
    const now = new Date();
    db.insert(schema.automations).values({
      name: 'script', code: opts.code ?? SHIPPED, passcode: `p${Math.random()}`,
      managedBy: opts.managedBy ?? null, managedKey: opts.managedBy ? 'key' : null,
      currentDefaultCode: opts.managedBy ? (opts.currentDefaultCode === undefined ? SHIPPED : opts.currentDefaultCode) : null,
      isOverridden: opts.isOverridden ?? false, createdAt: now, updatedAt: now,
    }).run();
    return db.select().from(schema.automations).all().pop()!;
  }

  const authorRow = (automationId: number) =>
    db.select().from(schema.automationAuthors).where(eq(schema.automationAuthors.automationId, automationId)).all()[0];

  describe('resolveToolAccess', () => {
    it('denies a script nobody has claimed, and says how to claim it', () => {
      const a = addAutomation();
      const access = resolveToolAccess(db, a.id);
      expect(access.kind).toBe('denied');
      expect((access as any).reason).toMatch(/no author on record/i);
      expect((access as any).reason).toMatch(/save the automation/i);
    });

    it('trusts a plugin-managed script that the operator has not overridden', () => {
      const a = addAutomation({ managedBy: 'some-plugin', isOverridden: false });
      expect(resolveToolAccess(db, a.id)).toEqual({ kind: 'trusted' });
    });

    it('does not trust a managed script once the operator has overridden it', () => {
      const a = addAutomation({ managedBy: 'some-plugin', isOverridden: true });
      expect(resolveToolAccess(db, a.id).kind).toBe('denied');
    });

    it('does not trust a managed script whose code was changed outside the plugin, even with the override flag unset', () => {
      const a = addAutomation({ managedBy: 'some-plugin', isOverridden: false, code: 'await tools.run_adb_command({});' });
      expect(resolveToolAccess(db, a.id).kind).toBe('denied');
    });

    it('does not trust a managed script when the plugin default is unknown', () => {
      const a = addAutomation({ managedBy: 'some-plugin', currentDefaultCode: null });
      expect(resolveToolAccess(db, a.id).kind).toBe('denied');
    });

    it('applies the author\'s scopes to a changed managed script once someone has claimed it', () => {
      const user = addUser(['core.devices:shell']);
      const a = addAutomation({ managedBy: 'some-plugin', code: 'edited by an operator' });
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });
      expect(resolveToolAccess(db, a.id).kind).toBe('scoped');
    });

    it('returns the saved snapshot and the author\'s current scopes', () => {
      const user = addUser(['core.devices:*', 'core.automations:edit']);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });

      const access = resolveToolAccess(db, a.id);
      expect(access.kind).toBe('scoped');
      expect([...(access as any).snapshot]).toEqual(['core.devices:shell']);
      expect([...(access as any).current].sort()).toEqual(['core.automations:edit', 'core.devices:*']);
    });

    it('follows a change to the author\'s scopes on the next lookup', () => {
      const user = addUser(['core.devices:shell']);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });
      db.update(schema.users).set({ scopes: [] }).where(eq(schema.users.id, user.id)).run();

      const access = resolveToolAccess(db, a.id);
      expect(access.kind).toBe('scoped');
      expect([...(access as any).current]).toEqual([]);
    });

    it('denies when the author\'s account is disabled', () => {
      const user = addUser(['core.devices:shell'], false);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });

      const access = resolveToolAccess(db, a.id);
      expect(access.kind).toBe('denied');
      expect((access as any).reason).toMatch(/disabled/i);
    });

    it('denies when the author\'s account was removed (user id cleared by the foreign key)', () => {
      const user = addUser(['core.devices:shell']);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });
      db.update(schema.automationAuthors).set({ userId: null }).where(eq(schema.automationAuthors.automationId, a.id)).run();

      const access = resolveToolAccess(db, a.id);
      expect(access.kind).toBe('denied');
      expect((access as any).reason).toMatch(/removed/i);
    });

    it('denies when the user row is gone even if the foreign key did not clear it', () => {
      const user = addUser(['core.devices:shell']);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });
      db.delete(schema.users).where(eq(schema.users.id, user.id)).run();

      expect(resolveToolAccess(db, a.id).kind).toBe('denied');
    });

    it('denies an automation that no longer exists', () => {
      expect(resolveToolAccess(db, 9999).kind).toBe('denied');
    });
  });

  describe('recordAuthor', () => {
    it('replaces the author and the snapshot on a later save', () => {
      const first = addUser(['core.devices:*']);
      const second = addUser(['core.apk:read']);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: first.id, effectiveScopes: new Set(['core.devices:shell']) });
      recordAuthor(db, a.id, { userId: second.id, effectiveScopes: new Set(['core.apk:read']) });

      const row = authorRow(a.id);
      expect(row.userId).toBe(second.id);
      expect(row.scopes).toEqual(['core.apk:read']);
      expect(db.select().from(schema.automationAuthors).all()).toHaveLength(1);
    });
  });

  describe('clearAuthor', () => {
    it('removes the author so tool calls are denied again', () => {
      const user = addUser(['core.devices:shell']);
      const a = addAutomation();
      recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set(['core.devices:shell']) });
      clearAuthor(db, a.id);

      expect(authorRow(a.id)).toBeUndefined();
      expect(resolveToolAccess(db, a.id).kind).toBe('denied');
    });

    it('is a no-op when there is no author', () => {
      const a = addAutomation();
      expect(() => clearAuthor(db, a.id)).not.toThrow();
    });
  });

  describe('unclaimed scripts', () => {
    const SHELL = 'core.devices:shell';
    const claimer = () => ({ userId: addUser([SHELL]).id, effectiveScopes: new Set([SHELL]) });

    describe('listUnclaimed', () => {
      it('lists a script nobody has claimed', () => {
        const a = addAutomation();
        expect(listUnclaimed(db)).toEqual([a.id]);
      });

      it('lists a script whose author account was removed', () => {
        const user = addUser([SHELL]);
        const a = addAutomation();
        recordAuthor(db, a.id, { userId: user.id, effectiveScopes: new Set([SHELL]) });
        db.update(schema.automationAuthors).set({ userId: null }).where(eq(schema.automationAuthors.automationId, a.id)).run();

        expect(listUnclaimed(db)).toEqual([a.id]);
      });

      it('leaves out a script that has an author, even a disabled one', () => {
        const active = addAutomation();
        const disabled = addAutomation();
        recordAuthor(db, active.id, { userId: addUser([SHELL]).id, effectiveScopes: new Set([SHELL]) });
        recordAuthor(db, disabled.id, { userId: addUser([SHELL], false).id, effectiveScopes: new Set([SHELL]) });

        expect(listUnclaimed(db)).toEqual([]);
      });

      it('leaves out a plugin script the operator has not changed, since it needs no author', () => {
        addAutomation({ managedBy: 'some-plugin' });
        expect(listUnclaimed(db)).toEqual([]);
      });

      it('lists a plugin script once its code differs from what the plugin ships', () => {
        const changed = addAutomation({ managedBy: 'some-plugin', code: 'export default async function() { /* edited */ }' });
        const overridden = addAutomation({ managedBy: 'some-plugin', isOverridden: true });

        expect(listUnclaimed(db).sort()).toEqual([changed.id, overridden.id].sort());
      });

      it('returns nothing when there are no scripts', () => {
        expect(listUnclaimed(db)).toEqual([]);
      });
    });

    describe('claimUnclaimed', () => {
      it('makes the caller the author of every unclaimed script, with the scopes of the credential used', () => {
        const a = addAutomation();
        const b = addAutomation();
        const caller = claimer();

        expect(claimUnclaimed(db, caller)).toBe(2);

        for (const id of [a.id, b.id]) {
          expect(authorRow(id).userId).toBe(caller.userId);
          expect(authorRow(id).scopes).toEqual([SHELL]);
        }
        expect(resolveToolAccess(db, a.id).kind).toBe('scoped');
      });

      it('leaves scripts that already have an author with that author', () => {
        const owner = addUser(['core.admin:*']);
        const owned = addAutomation();
        recordAuthor(db, owned.id, { userId: owner.id, effectiveScopes: new Set(['core.admin:*']) });
        const loose = addAutomation();
        const caller = claimer();

        expect(claimUnclaimed(db, caller)).toBe(1);

        expect(authorRow(owned.id).userId).toBe(owner.id);
        expect(authorRow(loose.id).userId).toBe(caller.userId);
      });

      it('takes over a script whose author account was removed', () => {
        const gone = addUser([SHELL]);
        const a = addAutomation();
        recordAuthor(db, a.id, { userId: gone.id, effectiveScopes: new Set([SHELL]) });
        db.update(schema.automationAuthors).set({ userId: null }).where(eq(schema.automationAuthors.automationId, a.id)).run();
        const caller = claimer();

        expect(claimUnclaimed(db, caller)).toBe(1);
        expect(authorRow(a.id).userId).toBe(caller.userId);
      });

      it('does not claim an unchanged plugin script', () => {
        const managed = addAutomation({ managedBy: 'some-plugin' });

        expect(claimUnclaimed(db, claimer())).toBe(0);
        expect(authorRow(managed.id)).toBeUndefined();
      });

      it('claims nothing the second time', () => {
        addAutomation();
        const caller = claimer();
        claimUnclaimed(db, caller);

        expect(claimUnclaimed(db, caller)).toBe(0);
      });
    });
  });
});
