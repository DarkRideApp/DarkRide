import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { AiTierStore } from '../ai-tier-store';

const SETUP = `
CREATE TABLE ai_providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE ai_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  is_hardcoded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE ai_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_id INTEGER,
  model TEXT,
  enabled INTEGER DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes INTEGER DEFAULT 10,
  tier_id INTEGER REFERENCES ai_tiers(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at) VALUES ('High', 0, 1, 1, 1);
INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at) VALUES ('Low', 1, 1, 1, 1);
`;

describe('AiTierStore', () => {
  let store: AiTierStore;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(SETUP);
    const db = drizzle(sqlite, { schema });
    store = new AiTierStore(db);
  });

  it('lists hardcoded tiers on a fresh DB', () => {
    const tiers = store.list();
    expect(tiers.map(t => t.name)).toEqual(['High', 'Low']);
    expect(tiers.every(t => t.isHardcoded)).toBe(true);
  });

  it('includes enabledModelCount per tier', () => {
    const highId = store.getByName('High')!.id;
    sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, enabled, created_at, updated_at) VALUES ('m1','p',?,1,1,1)`).run(highId);
    sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, enabled, created_at, updated_at) VALUES ('m2','p',?,0,1,1)`).run(highId);
    const tiers = store.list();
    const high = tiers.find(t => t.name === 'High')!;
    expect(high.enabledModelCount).toBe(1);
  });

  it('enabledModelCount tracks models across multiple tiers (prod 2026-05-13 regression)', () => {
    // Direct reproduction of the prod data when the bug surfaced: 3 tiers,
    // each with at least one enabled model. The correlated-subquery
    // implementation returned 0 for every tier despite identical raw-SQL
    // queries returning the correct counts. Pure-JS aggregation makes this
    // straightforward and easier to reason about.
    const highId = store.getByName('High')!.id;
    const lowId = store.getByName('Low')!.id;
    const testTier = store.create('Test Tier - Free');

    // High: 5 total, 3 enabled
    for (let i = 0; i < 3; i++) {
      sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, enabled, created_at, updated_at) VALUES (?,'p',?,1,1,1)`).run(`h-on-${i}`, highId);
    }
    for (let i = 0; i < 2; i++) {
      sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, enabled, created_at, updated_at) VALUES (?,'p',?,0,1,1)`).run(`h-off-${i}`, highId);
    }
    // Low: 1 enabled
    sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, enabled, created_at, updated_at) VALUES ('l1','p',?,1,1,1)`).run(lowId);
    // Test Tier - Free: 1 enabled
    sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, enabled, created_at, updated_at) VALUES ('t1','p',?,1,1,1)`).run(testTier.id);

    const tiers = store.list();
    const high = tiers.find(t => t.name === 'High')!;
    const low = tiers.find(t => t.name === 'Low')!;
    const ttf = tiers.find(t => t.name === 'Test Tier - Free')!;
    expect(high.enabledModelCount).toBe(3);
    expect(low.enabledModelCount).toBe(1);
    expect(ttf.enabledModelCount).toBe(1);
  });

  it('creates a user-added tier appended after existing tiers', () => {
    const t = store.create('Medium');
    expect(t.name).toBe('Medium');
    expect(t.isHardcoded).toBe(false);
    expect(t.sortOrder).toBe(2);
  });

  it('rejects creating a duplicate name', () => {
    expect(() => store.create('High')).toThrow(/already exists/);
  });

  it('renames a user-added tier', () => {
    const m = store.create('Medium');
    const renamed = store.rename(m.id, 'Mid');
    expect(renamed.name).toBe('Mid');
  });

  it('rejects renaming a hardcoded tier', () => {
    const high = store.getByName('High')!;
    expect(() => store.rename(high.id, 'Top')).toThrow(/hardcoded/);
  });

  it('reorders tiers', () => {
    store.create('Medium');
    const high = store.getByName('High')!;
    const medium = store.getByName('Medium')!;
    const low = store.getByName('Low')!;
    store.reorder([medium.id, high.id, low.id]);
    const tiers = store.list();
    expect(tiers.map(t => t.name)).toEqual(['Medium', 'High', 'Low']);
    expect(tiers.map(t => t.sortOrder)).toEqual([0, 1, 2]);
  });

  it('deletes an empty user-added tier', () => {
    const m = store.create('Medium');
    store.delete(m.id);
    expect(store.list().map(t => t.name)).toEqual(['High', 'Low']);
  });

  it('rejects deleting a hardcoded tier', () => {
    const high = store.getByName('High')!;
    expect(() => store.delete(high.id)).toThrow(/hardcoded/);
  });

  it('rejects deleting a tier that has models', () => {
    const m = store.create('Medium');
    sqlite.prepare(`INSERT INTO ai_models (name, provider, tier_id, created_at, updated_at) VALUES ('x','p',?,1,1)`).run(m.id);
    expect(() => store.delete(m.id)).toThrow(/models/);
  });

  it('rejects deleting a tier referenced by settings', () => {
    const m = store.create('Medium');
    sqlite.prepare(`INSERT INTO settings (key, value) VALUES ('foo_tier', 'Medium')`).run();
    expect(() => store.delete(m.id)).toThrow(/settings/);
  });
});
