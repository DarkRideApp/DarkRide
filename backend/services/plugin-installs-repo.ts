import { existsSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { pluginInstalls } from '../db/schema';

export interface PluginInstallRecord {
  name: string;
  npmPackage: string;
  sourceUrl: string;
  resolvedRef: string | null;
  sourceId: number | null;
  /** Token used at install time. May be null for older rows. */
  authToken: string | null;
  installedAt: number;
}

export interface PluginInstallInput {
  name: string;
  npmPackage: string;
  sourceUrl: string;
  resolvedRef: string | null;
  sourceId: number | null;
  /**
   * Token used at install time. Persisted so replay-on-boot can authenticate
   * against private repos even when the originating source row has been
   * deleted (or the install was via raw URL with no sourceId). Pass null when
   * the install needed no authentication.
   */
  authToken: string | null;
}

export class PluginInstallsRepo {
  constructor(private db: AppDatabase) {}

  record(input: PluginInstallInput): void {
    const installedAt = Math.floor(Date.now() / 1000);
    this.db
      .insert(pluginInstalls)
      .values({ ...input, installedAt })
      .onConflictDoUpdate({
        target: pluginInstalls.name,
        set: {
          npmPackage: input.npmPackage,
          sourceUrl: input.sourceUrl,
          resolvedRef: input.resolvedRef,
          sourceId: input.sourceId,
          authToken: input.authToken,
          installedAt,
        },
      })
      .run();
  }

  remove(name: string): void {
    this.db.delete(pluginInstalls).where(eq(pluginInstalls.name, name)).run();
  }

  getAll(): PluginInstallRecord[] {
    return this.db.select().from(pluginInstalls).all() as PluginInstallRecord[];
  }

  getMissingDirs(nodeModulesRoot: string): PluginInstallRecord[] {
    return this.getAll().filter(row => !existsSync(join(nodeModulesRoot, row.npmPackage)));
  }
}
