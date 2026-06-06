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

    it('stamps a non-empty random passcode so managed rows can not be triggered with an empty-passcode URL', () => {
      // Regression for PR #16 third-pass review: `passcode` is the
      // credential for the unauthenticated /v1/automation/run/:id/:passcode
      // external-trigger endpoint, not an IDE field. An empty passcode
      // could allow accidental external triggering of managed rows under
      // some URL-routing edge cases.
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'a' })]);
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'a-and-b' }), makeDef({ key: 'c' })]);
      const allPasscodes = db.select().from(automations).all().map((r) => r.passcode);
      // None should be the empty string.
      expect(allPasscodes.some((p) => p === '')).toBe(false);
      // And each should differ (random UUID per insert).
      expect(new Set(allPasscodes).size).toBe(allPasscodes.length);
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

    it('also refreshes the OTHER plugin-owned fields (description, emitFailureNotification, name, etc.) on an overridden row', () => {
      // Regression for PR #16 second-pass review: the preserve-override
      // branch was originally missing emitFailureNotification + description
      // from its update set. The operator only owns `code`; every other
      // plugin-authored field should refresh on every reconcile regardless
      // of override state, otherwise a plugin update can't fix typos in its
      // own metadata for any user who's ever forked the script.
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        code: 'v1\n',
        name: 'Old name',
        description: 'Old description',
        emitFailureNotification: false,
        timeoutMs: 60_000,
      })]);
      // operator forks
      db.update(automations).set({
        code: 'operator\n',
        baseDefaultCode: 'v1\n',
        isOverridden: true,
      }).where(eq(automations.managedKey, 'poller')).run();

      // plugin ships an update touching everything EXCEPT seed fields
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        code: 'v2\n',
        name: 'New name',
        description: 'New description',
        emitFailureNotification: true,
        timeoutMs: 120_000,
      })]);

      const row = getRow(db, 'plugin-x', 'poller');
      // operator code untouched
      expect(row.code).toBe('operator\n');
      // every plugin-owned field refreshes
      expect(row.name).toBe('New name');
      expect(row.description).toBe('New description');
      expect(row.emitFailureNotification).toBe(true);
      expect(row.timeoutMs).toBe(120_000);
      expect(row.currentDefaultCode).toBe('v2\n');
    });

    it('keeps current_default_schedule and current_default_enabled in sync with the plugin without touching the operator-owned schedule/enabled', () => {
      // These two columns are the "revert to default" targets the SDK IDE
      // offers. They must refresh on every reconcile pass (including the
      // preserve-override branch) so the revert button always restores to
      // what the plugin currently ships — not what it shipped at the row's
      // first insert. The operator-owned `schedule` and `enabled` columns
      // are NEVER touched here.
      const sched1 = JSON.stringify({ type: 'interval', intervalMs: 60_000 });
      const sched2 = JSON.stringify({ type: 'cron', expressions: ['0 9 * * *'] });

      // First load with interval schedule + enabled
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        defaultSchedule: sched1,
        enabledByDefault: true,
      })]);
      let row = getRow(db, 'plugin-x', 'poller');
      expect(row.schedule).toBe(sched1);            // seed
      expect(row.enabled).toBe(true);                // seed
      expect(row.currentDefaultSchedule).toBe(sched1);
      expect(row.currentDefaultEnabled).toBe(true);

      // Operator overrides BOTH the schedule and the enabled flag.
      db.update(automations).set({
        schedule: JSON.stringify({ type: 'cron', expressions: ['0 0 * * 0'] }),
        enabled: false,
      }).where(eq(automations.id, row.id)).run();

      // Plugin ships an updated default — schedule changes, enabled now false.
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({
        defaultSchedule: sched2,
        enabledByDefault: false,
      })]);
      row = getRow(db, 'plugin-x', 'poller');

      // Operator overrides untouched — the scheduler keeps running THEIR
      // schedule, not the plugin's new default.
      expect(row.schedule).toBe(JSON.stringify({ type: 'cron', expressions: ['0 0 * * 0'] }));
      expect(row.enabled).toBe(false);

      // current_default_* tracks the plugin's latest declaration — the
      // SDK Revert button targets these.
      expect(row.currentDefaultSchedule).toBe(sched2);
      expect(row.currentDefaultEnabled).toBe(false);
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

  describe('case 11: transactional atomicity', () => {
    // Regression for PR #16 fifth-pass review: the reconciler's multi-step
    // state machine (insert / update / orphan / delete + session backfill)
    // ran without a transaction. A mid-flight failure (disk full, SQLITE_BUSY,
    // unexpected constraint) could leave a plugin half-stamped — really hard
    // to reason about. We now wrap the whole body in a transaction so any
    // throw rolls back to the entry state.
    it('rolls back inserts when a later statement throws', () => {
      // Seed an existing orphaned-shape row that will collide with the second
      // declared key: it has managedBy NULL but a unique constraint on
      // some other column we can hit. Simulate the failure by stubbing
      // `db.insert(...).values(...).run()` after the first call to throw.
      let runCount = 0;
      const origRun = (db as any).$client.prepare;
      // Inject a synthetic throw: monkey-patch better-sqlite3's exec to throw
      // after the FIRST insert into automations. Simulates a transient
      // SQLITE_BUSY mid-reconcile.
      const sqlite = (db as any).$client;
      const origExec = sqlite.exec.bind(sqlite);
      sqlite.exec = (sql: string) => origExec(sql);  // no change yet
      // The cleanest way to inject is to wrap the drizzle insert helper —
      // but that's invasive. Easier: declare two defs, then point one of
      // them at code that's too long for a CHECK constraint. SQLite has
      // no CHECK on automations, so simpler still: directly throw from a
      // wrapper around the second insert by counting calls.
      void origRun;
      void runCount;

      // Concrete approach: pre-create a row that uses a synthetic UNIQUE-
      // violating combination. The partial unique index on
      // (managed_by, managed_key) WHERE managed_by IS NOT NULL fires if
      // we try to insert (plugin-x, 'b') when one already exists. Insert it
      // by hand, then call reconcile with defs that try to insert 'a' AND 'b'.
      // The 'a' insert succeeds; the 'b' insert throws on the unique index.
      // Inside the transaction, the 'a' insert should roll back.
      reconcileManagedAutomations(db, 'plugin-x', [makeDef({ key: 'b' })]);
      // Now plugin-x already has a row for 'b'. Re-reconcile claiming both
      // 'a' (new) and 'b' (existing — silent adopt). Then forcibly create
      // a colliding plugin-x/'a' row from a different `plugin-x` invocation
      // — actually, simplest: just monkey-patch `db.insert` to throw on the
      // 2nd call.
      let calls = 0;
      const origInsert = (db as any).insert.bind(db);
      (db as any).insert = (...args: any[]) => {
        const builder = origInsert(...args);
        const origValues = builder.values.bind(builder);
        builder.values = (...vargs: any[]) => {
          const stmt = origValues(...vargs);
          const origStmtRun = stmt.run.bind(stmt);
          stmt.run = (...rargs: any[]) => {
            calls += 1;
            if (calls === 2) throw new Error('simulated SQLITE_BUSY mid-reconcile');
            return origStmtRun(...rargs);
          };
          return stmt;
        };
        return builder;
      };
      try {
        expect(() => reconcileManagedAutomations(db, 'plugin-y', [
          makeDef({ key: 'first' }),
          makeDef({ key: 'second' }),
        ])).toThrow(/simulated/);
      } finally {
        (db as any).insert = origInsert;
      }
      // First insert for plugin-y MUST have been rolled back.
      const yRows = db.select().from(automations)
        .where(eq(automations.managedBy, 'plugin-y')).all();
      expect(yRows).toHaveLength(0);
    });
  });

  describe('case 10: duplicate keys in defs', () => {
    // Regression for PR #16 review: the partial unique index on
    // (managed_by, managed_key) would catch this anyway, but the resulting
    // SqliteError loses the structural meaning. Fail fast with a plain
    // error naming the plugin + duplicated keys so the author sees what
    // to fix.
    it('throws a clear error with the plugin name + duplicated keys', () => {
      expect(() => reconcileManagedAutomations(db, 'plugin-x', [
        makeDef({ key: 'poller' }),
        makeDef({ key: 'poller' }),
      ])).toThrow(/plugin-x.*poller.*unique/i);
    });

    it('does not partially apply when duplicates are present', () => {
      try {
        reconcileManagedAutomations(db, 'plugin-x', [
          makeDef({ key: 'a' }),
          makeDef({ key: 'a' }),
        ]);
      } catch { /* expected */ }
      // No row should have been inserted — validation happens before any write.
      const rows = db.select().from(automations).all();
      expect(rows).toHaveLength(0);
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
