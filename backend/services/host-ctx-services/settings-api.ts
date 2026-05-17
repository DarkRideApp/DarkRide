import { eq, like } from 'drizzle-orm';
import type { SettingsApi } from '@darkrideapp/plugin-sdk';
import type { AppDatabase } from '../../db/index';
import { settings } from '../../db/schema';

export function createSettingsApi(db: AppDatabase): SettingsApi {
  return {
    async get(key) {
      const row = db.select().from(settings).where(eq(settings.key, key)).all()[0];
      return row?.value ?? null;
    },

    async getJson<T>(key: string): Promise<T | null> {
      const value = await this.get(key);
      if (value === null) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    },

    async set(key, value) {
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value },
        })
        .run();
    },

    async setJson(key, value) {
      await this.set(key, JSON.stringify(value));
    },

    async delete(key) {
      db.delete(settings).where(eq(settings.key, key)).run();
    },

    async list(prefix) {
      if (prefix) {
        const rows = db.select().from(settings).where(like(settings.key, `${prefix}%`)).all();
        return rows.map(r => ({ key: r.key, value: r.value }));
      }
      const rows = db.select().from(settings).all();
      return rows.map(r => ({ key: r.key, value: r.value }));
    },
  };
}
