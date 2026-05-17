import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { LIBRARY_SCRIPTS, CATEGORY_ORDER, CATEGORY_LABELS, seedFridaScriptLibrary } from './frida-script-library';
import { eq, and } from 'drizzle-orm';
import { createTestDb } from '../test-utils/create-test-db';

describe('Frida Script Library', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('LIBRARY_SCRIPTS constant', () => {
    it('should have 28 scripts', () => {
      expect(LIBRARY_SCRIPTS).toHaveLength(30);
    });

    it('should have no duplicate names', () => {
      const names = LIBRARY_SCRIPTS.map(s => s.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should have all required fields', () => {
      for (const script of LIBRARY_SCRIPTS) {
        expect(script.name).toBeTruthy();
        expect(script.code).toBeTruthy();
        expect(script.category).toBeTruthy();
        expect(script.description).toBeTruthy();
      }
    });

    it('should only use known categories', () => {
      for (const script of LIBRARY_SCRIPTS) {
        expect(CATEGORY_ORDER).toContain(script.category);
      }
    });

    it('should have correct script counts per category', () => {
      const counts: Record<string, number> = {};
      for (const s of LIBRARY_SCRIPTS) {
        counts[s.category] = (counts[s.category] || 0) + 1;
      }
      expect(counts['cert-pinning']).toBe(5);
      expect(counts['root-detection']).toBe(7);
      expect(counts['integrity']).toBe(3);
      expect(counts['anti-debug']).toBe(3);
      expect(counts['emulator-detection']).toBe(3);
      expect(counts['utility']).toBe(6);
      expect(counts['analytics-bypass']).toBe(3);
    });
  });

  describe('CATEGORY_LABELS', () => {
    it('should have labels for all categories in CATEGORY_ORDER', () => {
      for (const slug of CATEGORY_ORDER) {
        expect(CATEGORY_LABELS[slug]).toBeTruthy();
      }
    });
  });

  describe('seedFridaScriptLibrary', () => {
    it('should insert all 28 scripts into empty DB', () => {
      seedFridaScriptLibrary(db as any);
      const all = db.select().from(schema.fridaScripts).all();
      expect(all).toHaveLength(30);
      expect(all.every(s => s.isBuiltin === true)).toBe(true);
    });

    it('should set category on all seeded scripts', () => {
      seedFridaScriptLibrary(db as any);
      const all = db.select().from(schema.fridaScripts).all();
      expect(all.every(s => s.category !== null)).toBe(true);
    });

    it('should be idempotent — re-seed does not duplicate', () => {
      seedFridaScriptLibrary(db as any);
      seedFridaScriptLibrary(db as any);
      const all = db.select().from(schema.fridaScripts).all();
      expect(all).toHaveLength(30);
    });

    it('should update existing builtins when code changes', () => {
      seedFridaScriptLibrary(db as any);
      // Manually change code of first script
      const first = db.select().from(schema.fridaScripts).where(eq(schema.fridaScripts.isBuiltin, true)).all()[0];
      db.update(schema.fridaScripts).set({ code: 'old code' }).where(eq(schema.fridaScripts.id, first.id)).run();

      seedFridaScriptLibrary(db as any);

      const updated = db.select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, first.id)).all()[0];
      expect(updated.code).not.toBe('old code');
    });

    it('should not touch user scripts with same name', () => {
      // Insert a user script with same name as a library script
      const now = new Date();
      db.insert(schema.fridaScripts).values({
        name: LIBRARY_SCRIPTS[0].name,
        code: 'user custom code',
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      }).run();

      seedFridaScriptLibrary(db as any);

      const all = db.select().from(schema.fridaScripts).all();
      // Should have 30 builtins + 1 user script
      expect(all).toHaveLength(31);
      const userScript = all.find(s => !s.isBuiltin);
      expect(userScript).toBeDefined();
      expect(userScript!.code).toBe('user custom code');
    });
  });
});
