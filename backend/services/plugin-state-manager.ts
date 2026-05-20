import { eq } from 'drizzle-orm';
import { pluginState } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('plugin-state-manager');

export interface DiscoveredPluginInfo {
  name: string;
  version: string;
  source: 'workspace' | 'npm' | 'managed' | 'manual';
  description?: string;
  author?: string;
  npmPackage?: string;
}

export class PluginStateManager {
  constructor(private db: AppDatabase) {}

  /**
   * Sync the DB with the currently discovered plugins on disk/npm.
   * - New plugins are inserted with enabled=true.
   * - Existing plugins have version/source updated, but enabled is preserved.
   * - Plugins no longer present get installedVia set to 'missing'.
   */
  reconcile(discovered: DiscoveredPluginInfo[]): void {
    const discoveredNames = new Set(discovered.map(d => d.name));
    const existing = this.getAll();
    const existingNames = new Set(existing.map(r => r.name));

    const now = new Date();

    for (const info of discovered) {
      if (existingNames.has(info.name)) {
        // Update version/source but preserve enabled
        this.db
          .update(pluginState)
          .set({
            version: info.version,
            installedVia: info.source,
            description: info.description ?? null,
            author: info.author ?? null,
            npmPackage: info.npmPackage ?? null,
            updatedAt: now,
          })
          .where(eq(pluginState.name, info.name))
          .run();
      } else {
        // New plugin — insert enabled by default. The user's options to opt
        // out are: don't install (managed), or remove from disk (workspace).
        // Once installed/present, defaulting to disabled adds friction with
        // little upside.
        this.db
          .insert(pluginState)
          .values({
            name: info.name,
            enabled: true,
            installedVia: info.source,
            version: info.version,
            description: info.description ?? null,
            author: info.author ?? null,
            npmPackage: info.npmPackage ?? null,
            installedAt: now,
            updatedAt: now,
          })
          .run();
        log(`Plugin registered: ${info.name} @ ${info.version} (${info.source})`);
      }
    }

    // Mark plugins that are no longer present as 'missing'
    for (const row of existing) {
      if (!discoveredNames.has(row.name) && row.installedVia !== 'missing') {
        this.db
          .update(pluginState)
          .set({ installedVia: 'missing', updatedAt: now })
          .where(eq(pluginState.name, row.name))
          .run();
        log(`Plugin marked as missing: ${row.name}`);
      }
    }
  }

  /** Return all plugin state rows. */
  getAll() {
    return this.db.select().from(pluginState).all();
  }

  /** Return a single plugin state row, or undefined if not found. */
  get(name: string) {
    return this.db
      .select()
      .from(pluginState)
      .where(eq(pluginState.name, name))
      .all()[0];
  }

  /** Returns true only if the plugin exists and is enabled. */
  isEnabled(name: string): boolean {
    const row = this.get(name);
    return row?.enabled === true;
  }

  /** Update the enabled flag for a plugin. */
  setEnabled(name: string, enabled: boolean): void {
    this.db
      .update(pluginState)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(pluginState.name, name))
      .run();
  }

  /**
   * Update the version field for a plugin. Called after a managed update
   * so the installed-plugins API reports the new version immediately,
   * without waiting for the next boot's reconcile.
   */
  setVersion(name: string, version: string): void {
    this.db
      .update(pluginState)
      .set({ version, updatedAt: new Date() })
      .where(eq(pluginState.name, name))
      .run();
  }

  /** Create or fully replace a plugin entry (enabled preserved if row already exists). */
  upsert(info: DiscoveredPluginInfo): void {
    const existing = this.get(info.name);
    const now = new Date();

    if (existing) {
      this.db
        .update(pluginState)
        .set({
          version: info.version,
          installedVia: info.source,
          description: info.description ?? null,
          author: info.author ?? null,
          npmPackage: info.npmPackage ?? null,
          updatedAt: now,
        })
        .where(eq(pluginState.name, info.name))
        .run();
    } else {
      this.db
        .insert(pluginState)
        .values({
          name: info.name,
          enabled: true,
          installedVia: info.source,
          version: info.version,
          description: info.description ?? null,
          author: info.author ?? null,
          npmPackage: info.npmPackage ?? null,
          installedAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  /**
   * Insert (or refresh) a plugin_state row for a managed install. Called by
   * the install endpoint immediately after a successful installManaged() so
   * the UI shows the installed plugin before the next boot's reconcile.
   *
   * - First-time: creates the row with `enabled=true`, installedVia='managed'.
   *   Auto-enable is intentional — the user explicitly clicked "Install",
   *   so requiring an additional "Enable" click adds friction without
   *   meaningful safety (the install itself was the consent gesture).
   * - Subsequent (re-install): preserves enabled state, just refreshes
   *   installedVia and updatedAt.
   *
   * Note: if you change this contract (e.g. default-disable for untrusted
   * sources), update the rationale in the inline comment below and the
   * memory file at plugin_architecture_overview.md.
   */
  upsertManagedPending(name: string, npmPackage: string, _sourceId?: number | null): void {
    const existing = this.get(name);
    const now = new Date();

    if (existing) {
      this.db
        .update(pluginState)
        .set({ installedVia: 'managed', npmPackage, updatedAt: now })
        .where(eq(pluginState.name, name))
        .run();
      return;
    }

    this.db
      .insert(pluginState)
      .values({
        name,
        // Marketplace installs auto-enable — the user explicitly clicked
        // "Install" so making them click "Enable" too is friction.
        enabled: true,
        installedVia: 'managed',
        version: '',
        npmPackage,
        installedAt: now,
        updatedAt: now,
      })
      .run();
    log(`Plugin registered (pending discovery): ${name} (managed, enabled)`);
  }

  /** Delete the plugin state entry. */
  remove(name: string): void {
    this.db.delete(pluginState).where(eq(pluginState.name, name)).run();
  }
}
