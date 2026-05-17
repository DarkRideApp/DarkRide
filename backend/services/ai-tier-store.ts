import { eq, asc, sql, and, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { aiTiers, aiModels, settings } from '../db/schema';

export interface TierRow {
  id: number;
  name: string;
  sortOrder: number;
  isHardcoded: boolean;
  enabledModelCount: number;
  createdAt: number;
  updatedAt: number;
}

export class AiTierStore {
  constructor(private db: BetterSQLite3Database<any>) {}

  list(): TierRow[] {
    // Two cheap queries + a JS count, instead of a correlated subquery.
    // The subquery version (Drizzle's ${aiModels.enabled} = 1 templating)
    // returned 0 for every tier in prod on 2026-05-13 despite the same SQL
    // run via sqlite3 CLI returning the correct counts. Whatever Drizzle's
    // raw-SQL emission was doing, it was broken in a way our in-memory
    // test setup didn't catch. JS-side aggregation avoids the whole class.
    const tiers = this.db
      .select({
        id: aiTiers.id,
        name: aiTiers.name,
        sortOrder: aiTiers.sortOrder,
        isHardcoded: aiTiers.isHardcoded,
        createdAt: aiTiers.createdAt,
        updatedAt: aiTiers.updatedAt,
      })
      .from(aiTiers)
      .orderBy(asc(aiTiers.sortOrder))
      .all();
    const models = this.db
      .select({ tierId: aiModels.tierId, enabled: aiModels.enabled })
      .from(aiModels)
      .all();
    return tiers.map(t => ({
      ...t,
      enabledModelCount: models.filter(m => m.tierId === t.id && m.enabled).length,
    }));
  }

  getByName(name: string): TierRow | null {
    const list = this.list();
    return list.find(t => t.name === name) ?? null;
  }

  getById(id: number): TierRow | null {
    const list = this.list();
    return list.find(t => t.id === id) ?? null;
  }

  create(name: string): TierRow {
    const existing = this.getByName(name);
    if (existing) throw new Error(`Tier "${name}" already exists`);
    const maxOrder = this.db
      .select({ max: sql<number>`COALESCE(MAX(${aiTiers.sortOrder}), -1)` })
      .from(aiTiers)
      .get()?.max ?? -1;
    const now = Date.now();
    this.db.insert(aiTiers).values({
      name, sortOrder: Number(maxOrder) + 1, isHardcoded: false,
      createdAt: now, updatedAt: now,
    }).run();
    return this.getByName(name)!;
  }

  rename(id: number, newName: string): TierRow {
    const current = this.getById(id);
    if (!current) throw new Error(`Tier ${id} not found`);
    if (current.isHardcoded) throw new Error('Cannot rename a hardcoded tier');
    if (newName !== current.name && this.getByName(newName)) {
      throw new Error(`Tier "${newName}" already exists`);
    }
    this.db.update(aiTiers).set({ name: newName, updatedAt: Date.now() })
      .where(eq(aiTiers.id, id)).run();
    return this.getById(id)!;
  }

  reorder(orderedIds: number[]): void {
    const all = this.list();
    if (orderedIds.length !== all.length) {
      throw new Error(`Reorder must include every tier (expected ${all.length}, got ${orderedIds.length})`);
    }
    const knownIds = new Set(all.map(t => t.id));
    for (const id of orderedIds) {
      if (!knownIds.has(id)) throw new Error(`Unknown tier id ${id}`);
    }
    const now = Date.now();
    for (let i = 0; i < orderedIds.length; i++) {
      this.db.update(aiTiers).set({ sortOrder: i, updatedAt: now })
        .where(eq(aiTiers.id, orderedIds[i])).run();
    }
  }

  delete(id: number): void {
    const current = this.getById(id);
    if (!current) throw new Error(`Tier ${id} not found`);
    if (current.isHardcoded) throw new Error('Cannot delete a hardcoded tier');

    const modelCount = this.db
      .select({ n: sql<number>`COUNT(*)` }).from(aiModels)
      .where(eq(aiModels.tierId, id)).get();
    if (Number(modelCount?.n ?? 0) > 0) {
      throw new Error('Cannot delete a tier that still has models assigned to it');
    }

    // Scope to settings whose key looks like a tier reference (contains "tier").
    // This avoids false positives on unrelated settings whose value happens to
    // equal a tier name (e.g. a username literally "Low").
    const settingsRefs = this.db
      .select({ n: sql<number>`COUNT(*)` }).from(settings)
      .where(and(eq(settings.value, current.name), like(settings.key, '%tier%'))).get();
    if (Number(settingsRefs?.n ?? 0) > 0) {
      throw new Error(`Cannot delete tier "${current.name}" — one or more settings still reference it`);
    }

    this.db.delete(aiTiers).where(eq(aiTiers.id, id)).run();
  }
}
