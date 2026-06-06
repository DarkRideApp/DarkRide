import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and, isNotNull } from 'drizzle-orm';
import { automations } from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import type { AppDatabase } from '../db';
import type { ManagedAutomationDef } from '@darkrideapp/plugin-sdk';
import { reconcileManagedAutomations } from './managed-automation-reconciler';

function makeDef(overrides: Partial<ManagedAutomationDef> = {}): ManagedAutomationDef {
  return {
    key: 'poller',
    name: 'Poller',
    code: 'console.log("v1");\n',
    defaultSchedule: JSON.stringify({ type: 'interval', intervalMs: 60_000 }),
    enabledByDefault: true,
    requiresDevice: false,
    timeoutMs: 60_000,
    allowUserOverride: true,
    ...overrides,
  };
}

function getRow(db: AppDatabase, plugin: string, key: string) {
  return db.select().from(automations)
    .where(and(eq(automations.managedBy, plugin), eq(automations.managedKey, key)))
    .all()[0];
}

describe('reconcileManagedAutomations', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('case 1: no row exists for this declaration → INSERT', () => {
    it('inserts a managed row stamped with provenance + seeds', () => {
      const def = makeDef({ code: 'console.log("hello");\n' });
      reconcileManagedAutomations(db, 'plugin-x', [def]);

      const row = getRow(db, 'plugin-x', 'poller');
      expect(row).toBeDefined();
      expect(row.managedBy).toBe('plugin-x');
      expect(row.managedKey).toBe('poller');
      expect(row.code).toBe('console.log("hello");\n');
      expect(row.currentDefaultCode).toBe('console.log("hello");\n');
      expect(row.baseDefaultCode).toBeNull();
      expect(row.isOverridden).toBe(false);
      expect(row.allowUserOverride).toBe(true);
      expect(row.schedule).toBe(def.defaultSchedule);
      expect(row.enabled).toBe(true);
      expect(row.requiresDevice).toBe(false);
      expect(row.timeoutMs).toBe(60_000);
      expect(row.name).toBe('Poller');
    });
  });

  describe('case 2: row exists, not overridden → adopt silently', () => {
    it('refreshes code + display metadata, leaves operator-owned schedule/enabled/deviceFilter alone', () => {
      // first load
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        name: 'Old name',
        code: 'v1\n',
      })]);

      // operator edits the schedule (operator-owned post-insert)
      db.update(automations).set({
        schedule: JSON.stringify({ type: 'cron', expressions: ['0 9 * * *'] }),
        enabled: false,
      }).where(eq(automations.managedKey, 'poller')).run();

      // second load: plugin ships a new code + display name
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        name: 'New name',
        code: 'v2\n',
      })]);

      const row = getRow(db, 'plugin-x', 'poller');
      expect(row.code).toBe('v2\n');                            // updated (silent adoption)
      expect(row.currentDefaultCode).toBe('v2\n');             // updated
      expect(row.name).toBe('New name');                       // display metadata refreshed
      // operator-owned fields preserved
      expect(row.schedule).toBe(JSON.stringify({ type: 'cron', expressions: ['0 9 * * *'] }));
      expect(row.enabled).toBe(false);
      // baseDefaultCode stays null (still not overridden)
      expect(row.baseDefaultCode).toBeNull();
      expect(row.isOverridden).toBe(false);
    });
  });

  describe('case 3: row exists and is overridden → preserve operator code, refresh current_default_code', () => {
    it('keeps operator code unchanged but updates current_default_code so drift can detect it', () => {
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ code: 'v1\n' })]);

      // operator forks
      db.update(automations).set({
        code: 'operator-edits\n',
        baseDefaultCode: 'v1\n',
        isOverridden: true,
      }).where(eq(automations.managedKey, 'poller')).run();

      // plugin ships a new default
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ code: 'v2\n' })]);

      const row = getRow(db, 'plugin-x', 'poller');
      expect(row.code).toBe('operator-edits\n');             // preserved
      expect(row.currentDefaultCode).toBe('v2\n');           // refreshed → drift now
      expect(row.baseDefaultCode).toBe('v1\n');              // ancestor unchanged
      expect(row.isOverridden).toBe(true);                   // still overridden
    });
  });

  describe('case 4: managed row no longer declared (plugin dropped the script)', () => {
    it('orphans an overridden row (null managed_*, enabled = 0, keep code)', () => {
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'poller' })]);
      db.update(automations).set({
        code: 'operator-edits\n',
        baseDefaultCode: 'v1\n',
        isOverridden: true,
      }).where(eq(automations.managedKey, 'poller')).run();

      // re-reconcile with the key absent from the declared set
      reconcileManagedAutomations(db, 'plugin-x', []);

      const orphan = db.select().from(automations)
        .where(and(eq(automations.code, 'operator-edits\n'), eq(automations.enabled, false)))
        .all()[0];
      expect(orphan).toBeDefined();
      expect(orphan.managedBy).toBeNull();
      expect(orphan.managedKey).toBeNull();
      expect(orphan.code).toBe('operator-edits\n');  // operator work preserved
    });

    it('deletes a non-overridden row outright', () => {
      reconcileManagedAutomations(db, 'plugin-x', [makeDef()]);
      // confirm it's there
      expect(getRow(db, 'plugin-x', 'poller')).toBeDefined();

      reconcileManagedAutomations(db, 'plugin-x', []);

      // gone
      expect(getRow(db, 'plugin-x', 'poller')).toBeUndefined();
      // and there are no leftover ordinary rows either
      const all = db.select().from(automations).all();
      expect(all).toHaveLength(0);
    });
  });

  describe('case 5: LF normalisation on code compare', () => {
    it('does not flag drift when the plugin ships CRLF and the DB stored LF', () => {
      // First load: plugin ships LF code
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ code: 'line1\nline2\n' })]);

      // Operator forks (override) — clones LF code
      db.update(automations).set({
        code: 'line1\nline2\n',          // operator hasn't edited yet, just adopted
        baseDefaultCode: 'line1\nline2\n',
        isOverridden: true,
      }).where(eq(automations.managedKey, 'poller')).run();

      // Plugin re-ships *the same logical code* but author saved as CRLF this time
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ code: 'line1\r\nline2\r\n' })]);

      const row = getRow(db, 'plugin-x', 'poller');
      // current_default_code stored as LF (host normalises) so drift = false
      expect(row.currentDefaultCode).toBe('line1\nline2\n');
      expect(row.baseDefaultCode).toBe('line1\nline2\n');
      // would be drift if we compared exact-with-CRLF — assert it's NOT
      expect(row.currentDefaultCode).toBe(row.baseDefaultCode);
    });
  });

  describe('case 6: rename heuristic', () => {
    it('warns when a previously known key disappears AND a new key appears in the same load', () => {
      const logs: string[] = [];
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'poller' })]);

      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'poller-v2' })], {
        warn: (msg) => logs.push(msg),
      });

      const renameMsg = logs.find((m) => /rename/i.test(m) && m.includes('poller') && m.includes('poller-v2'));
      expect(renameMsg).toBeDefined();
    });

    it('does NOT warn when only a new key appears (clean add)', () => {
      const logs: string[] = [];
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'poller-v2' })], {
        warn: (msg) => logs.push(msg),
      });
      expect(logs.find((m) => /rename/i.test(m))).toBeUndefined();
    });
  });

  describe('case 7: allowUserOverride revoked while overridden', () => {
    it('keeps operator code, flips the flag, leaves operator visible to the IDE as read-only', () => {
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ allowUserOverride: true })]);
      db.update(automations).set({
        code: 'operator-edits\n',
        baseDefaultCode: 'v1\n',
        isOverridden: true,
      }).where(eq(automations.managedKey, 'poller')).run();

      // plugin update revokes override permission
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        allowUserOverride: false,
        code: 'v2\n',
      })]);

      const row = getRow(db, 'plugin-x', 'poller');
      expect(row.code).toBe('operator-edits\n');            // never clobber operator code
      expect(row.allowUserOverride).toBe(false);            // flag flipped — IDE renders read-only
      expect(row.isOverridden).toBe(true);                  // still flagged so operator sees notice
    });
  });

  describe('case 8b: orphan also back-fills sessions.managed = 0', () => {
    // Without this back-fill, an orphaned automation that the operator now
    // owns would have its history hidden behind the default "hide managed"
    // session-history filter — confusing UX.
    it('flips automation_sessions.managed to 0 for the orphaned automation', async () => {
      const { automationSessions } = await import('../db/schema');
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'poller' })]);
      const autoId = getRow(db, 'plugin-x', 'poller').id;

      // Mark as overridden so the orphan path fires (not delete).
      db.update(automations).set({
        code: 'operator-edits\n',
        baseDefaultCode: 'v1\n',
        isOverridden: true,
      }).where(eq(automations.id, autoId)).run();

      // Insert a historical session row stamped managed = true
      db.insert(automationSessions).values({
        automationId: autoId,
        name: 'Poller',
        status: 'success',
        triggerType: 'schedule',
        startedAt: new Date(),
        managed: true,
      } as any).run();

      // Re-reconcile with the key absent → orphan path
      reconcileManagedAutomations(db, 'plugin-x', []);

      const sess = db.select().from(automationSessions).where(eq(automationSessions.automationId, autoId)).all();
      expect(sess).toHaveLength(1);
      expect(sess[0].managed).toBe(false);
    });
  });

  describe('case 9: uninstall sweep equivalence', () => {
    // The boot-time uninstall sweep just calls reconcileManagedAutomations
    // with an empty def list for every managed_by value whose plugin isn't
    // loaded. This test pins down that contract — empty defs across a
    // mixed set of overridden + non-overridden rows yields the right
    // orphan/delete outcomes per row, identical to the "no longer
    // declared" tail pass for an active plugin.
    it('on empty defs: orphans overridden rows, deletes non-overridden rows', () => {
      // Seed two rows
      reconcileManagedAutomations(db, 'plugin-gone', [
        makeDef({ key: 'overridden-one' }),
        makeDef({ key: 'plain-one' }),
      ]);
      // Operator overrode one of them
      db.update(automations).set({
        code: 'edited\n',
        baseDefaultCode: 'v1\n',
        isOverridden: true,
      }).where(eq(automations.managedKey, 'overridden-one')).run();

      // Plugin uninstalled → sweep calls with no defs
      reconcileManagedAutomations(db, 'plugin-gone', []);

      // Overridden row preserved as orphan (managedBy null, code intact)
      const orphan = db.select().from(automations)
        .where(eq(automations.code, 'edited\n')).all()[0];
      expect(orphan).toBeDefined();
      expect(orphan.managedBy).toBeNull();
      expect(orphan.managedKey).toBeNull();
      expect(orphan.enabled).toBe(false);

      // Non-overridden row deleted
      const stillThere = db.select().from(automations)
        .where(eq(automations.code, 'console.log("v1");\n')).all();
      expect(stillThere).toHaveLength(0);
    });
  });

  describe('case 8: plugin scoping', () => {
    it('does not touch rows owned by other plugins', () => {
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'a' })]);
      reconcileManagedAutomations(db, 'plugin-y', [makeDef({ key: 'a' })]);

      // re-reconcile plugin-x with the key absent — plugin-y's row stays
      reconcileManagedAutomations(db, 'plugin-x', []);

      const yRow = getRow(db, 'plugin-y', 'a');
      expect(yRow).toBeDefined();
      const xRow = getRow(db, 'plugin-x', 'a');
      expect(xRow).toBeUndefined();

      // also: no managed rows for plugin-x at all
      const xRows = db.select().from(automations)
        .where(and(isNotNull(automations.managedBy), eq(automations.managedBy, 'plugin-x')))
        .all();
      expect(xRows).toHaveLength(0);
    });
  });
});
