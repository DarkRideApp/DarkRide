import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { users } from '../db/schema';

export const SERVICE_PROVIDER_ID = 'core.service';

type Db = BetterSQLite3Database<any>;

export class ServiceUserManager {
  constructor(private db: Db) {}

  ensurePluginServiceUser(pluginName: string, aiScopes: string[]): number {
    this.assertScopes(aiScopes);
    return this.upsert({
      kind: 'plugin-service',
      serviceOwner: pluginName,
      username: `plugin:${pluginName}:ai`,
      displayName: `Plugin ${pluginName} (AI)`,
      scopes: aiScopes,
    });
  }

  ensureCoreServiceUser(name: string, aiScopes: string[]): number {
    this.assertScopes(aiScopes);
    return this.upsert({
      kind: 'core-service',
      serviceOwner: name,
      username: `service:${name}:ai`,
      displayName: `Service ${name} (AI)`,
      scopes: aiScopes,
    });
  }

  removePluginServiceUser(pluginName: string): void {
    this.db.delete(users).where(
      and(eq(users.kind, 'plugin-service'), eq(users.serviceOwner, pluginName)),
    ).run();
  }

  getPluginServiceUser(pluginName: string) {
    return this.db.select().from(users).where(
      and(eq(users.kind, 'plugin-service'), eq(users.serviceOwner, pluginName)),
    ).get() ?? null;
  }

  getCoreServiceUser(name: string) {
    return this.db.select().from(users).where(
      and(eq(users.kind, 'core-service'), eq(users.serviceOwner, name)),
    ).get() ?? null;
  }

  private upsert(opts: {
    kind: 'plugin-service' | 'core-service';
    serviceOwner: string;
    username: string;
    displayName: string;
    scopes: string[];
  }): number {
    const existing = this.db.select().from(users).where(
      and(eq(users.kind, opts.kind), eq(users.serviceOwner, opts.serviceOwner)),
    ).get();
    const now = new Date();
    if (existing) {
      this.db.update(users).set({
        scopes: opts.scopes as any,
        updatedAt: now,
      }).where(eq(users.id, existing.id)).run();
      return existing.id;
    }
    const created = this.db.insert(users).values({
      username: opts.username,
      providerId: SERVICE_PROVIDER_ID,
      displayName: opts.displayName,
      passwordHash: null,
      kind: opts.kind,
      serviceOwner: opts.serviceOwner,
      scopes: opts.scopes as any,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as any).returning({ id: users.id }).get();
    return created.id;
  }

  private assertScopes(scopes: string[]): void {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new Error('aiScopes must be a non-empty array; check before calling');
    }
  }
}
