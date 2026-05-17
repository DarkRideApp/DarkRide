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
  installedAt: number;
}

export interface PluginInstallInput {
  name: string;
  npmPackage: string;
  sourceUrl: string;
  resolvedRef: string | null;
  sourceId: number | null;
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
