import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { automations, automationSessions } from '../db/schema';
import type { AppDatabase } from '../db';
import type { ManagedAutomationDef } from '@darkrideapp/plugin-sdk';
import { createLoggers } from '../logs';

// The Logger interface exposes log + error only — no dedicated `warn`. Treat
// the rename heuristic as an error-level event so it surfaces in the same
// stream operators already watch. Test callers can override via options.warn.
const { log, error: defaultWarn } = createLoggers('managed-automation-reconciler');

/**
 * Reconcile the declared set of managed automations for `pluginName` against
 * the `automations` table. Runs after the plugin's migrations land and BEFORE
 * its `start()` is called, so by the time `start()` (and the scheduler)
 * observes the table, every declared script has a row and every undeclared
 * row has been orphaned-or-deleted.
 *
 * State machine (per declared entry, plus a tail pass for "managed row in DB
 * but no longer declared"):
 *
 *   no row exists                  → INSERT, seeded
 *   row exists, !isOverridden      → silently adopt new defaults (code +
 *                                    display metadata refreshed; the
 *                                    operator-owned schedule / enabled /
 *                                    device_filter columns are NEVER touched)
 *   row exists,  isOverridden      → preserve `code`, refresh
 *                                    `current_default_code` so the drift
 *                                    boolean lights up the operator banner
 *   declared earlier, not now      → orphan (overridden) or delete
 *
 * LF normalisation: the plugin author may save the script as CRLF on Windows
 * and ship it on a Linux-hosted host, which would otherwise drift-banner
 * every load. We normalise CRLF→LF on the way IN (so `current_default_code`
 * is always LF in storage); comparison against `base_default_code` (also
 * stored LF) is then exact-equality, honest.
 */
export interface ReconcileOptions {
  /** Called when the heuristic detects a likely managed_key rename. */
  warn?: (msg: string) => void;
}

export function reconcileManagedAutomations(
  db: AppDatabase,
  pluginName: string,
  defs: ManagedAutomationDef[],
  options: ReconcileOptions = {},
): void {
  const emitWarn = options.warn ?? defaultWarn;

  // Validate uniqueness of keys before touching the DB. The partial unique
  // index on (managed_by, managed_key) would catch this anyway, but the
  // resulting SqliteError loses the structural meaning ("plugin authored a
  // bad def list") in favour of a low-level constraint message. Fail fast
  // with the plugin name + the duplicated keys so it's obvious what to fix.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.key)) duplicates.add(d.key);
    seen.add(d.key);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Plugin "${pluginName}" declared duplicate managed-automation keys: ` +
      `${[...duplicates].join(', ')}. Each managed_key must be unique within a plugin.`,
    );
  }

  // Snapshot existing managed rows for this plugin so we can do the
  // "declared previously, not now" pass at the end. Drizzle's typed select
  // gives us back camelCase column names.
  const existingRows = db
    .select()
    .from(automations)
    .where(eq(automations.managedBy, pluginName))
    .all();
  const existingByKey = new Map(existingRows.map((r) => [r.managedKey!, r]));

  const declaredKeys = new Set(defs.map((d) => d.key));
  const now = new Date();

  // Per-declared-entry pass.
  for (const def of defs) {
    const declCode = normaliseLineEndings(def.code);
    const existing = existingByKey.get(def.key);

    if (!existing) {
      // ── INSERT ────────────────────────────────────────────────────
      db.insert(automations).values({
        name: def.name,
        // Old non-nullable columns we don't expose via the managed API —
        // pick sane defaults so the row is a valid ordinary automation
        // too (handy for the orphan-on-uninstall path).
        code: declCode,
        // `passcode` gates the unauthenticated /v1/automation/run/:id/:passcode
        // external-trigger endpoint. Managed rows aren't expected to be
        // externally triggered — plugins should drive their own runs through
        // the schedule + manual paths — but we generate a random UUID anyway
        // so an empty-passcode URL can't accidentally fire one of them.
        passcode: randomUUID(),
        requiresDevice: def.requiresDevice ?? true,
        timeoutMs: def.timeoutMs ?? 300_000,
        enabled: def.enabledByDefault ?? true,
        schedule: def.defaultSchedule ?? null,
        deviceFilter: def.defaultDeviceFilter
          ? JSON.stringify(def.defaultDeviceFilter)
          : null,
        // Managed provenance
        managedBy: pluginName,
        managedKey: def.key,
        currentDefaultCode: declCode,
        baseDefaultCode: null,
        isOverridden: false,
        allowUserOverride: def.allowUserOverride ?? true,
        emitFailureNotification: def.emitFailureNotification ?? false,
        description: def.description ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
      log(`Inserted managed automation ${pluginName}/${def.key}`);
      continue;
    }

    if (!existing.isOverridden) {
      // ── Adopt silently ────────────────────────────────────────────
      // Code + display metadata refresh; operator-owned seeds untouched.
      db.update(automations)
        .set({
          name: def.name,
          code: declCode,
          currentDefaultCode: declCode,
          requiresDevice: def.requiresDevice ?? true,
          timeoutMs: def.timeoutMs ?? 300_000,
          allowUserOverride: def.allowUserOverride ?? true,
          emitFailureNotification: def.emitFailureNotification ?? false,
          description: def.description ?? null,
          updatedAt: now,
        })
        .where(eq(automations.id, existing.id))
        .run();
      continue;
    }

    // ── Preserve operator code, refresh current_default_code ────────
    // `code` is intentionally NOT in the update set. `base_default_code`
    // stays at whatever the operator forked from, so the drift boolean
    // (is_overridden && base ≠ current) updates naturally.
    //
    // Display metadata still refreshes — the display name belongs to the
    // plugin author even when the script body belongs to the operator.
    // allow_user_override may flip here (§6.3); we honour it but never
    // clobber the operator's code, leaving them with a read-only IDE +
    // a one-time notice (host UI's responsibility).
    db.update(automations)
      .set({
        name: def.name,
        currentDefaultCode: declCode,
        requiresDevice: def.requiresDevice ?? true,
        timeoutMs: def.timeoutMs ?? 300_000,
        allowUserOverride: def.allowUserOverride ?? true,
        emitFailureNotification: def.emitFailureNotification ?? false,
        description: def.description ?? null,
        updatedAt: now,
      })
      .where(eq(automations.id, existing.id))
      .run();
  }

  // Tail pass: anything that was managed by us but isn't declared this load.
  // Orphan if overridden (preserve operator work as an ordinary disabled
  // automation), delete otherwise.
  const dropped: string[] = [];
  for (const row of existingRows) {
    if (row.managedKey == null) continue;
    if (declaredKeys.has(row.managedKey)) continue;
    dropped.push(row.managedKey);

    if (row.isOverridden) {
      db.update(automations).set({
        managedBy: null,
        managedKey: null,
        currentDefaultCode: null,
        baseDefaultCode: null,
        isOverridden: false,
        enabled: false,
        updatedAt: now,
      }).where(eq(automations.id, row.id)).run();
      // Back-fill historical sessions: the automation is now operator-owned,
      // so its history should be visible in the default "hide managed" view.
      // Without this, the operator sees the orphan in their automations list
      // but its sessions remain hidden — confusing.
      db.update(automationSessions)
        .set({ managed: false })
        .where(eq(automationSessions.automationId, row.id))
        .run();
      log(`Orphaned managed automation ${pluginName}/${row.managedKey} (operator override preserved)`);
    } else {
      // FK on automation_sessions.automation_id has no ON DELETE clause —
      // null it manually so the delete doesn't trip foreign_keys=ON.
      db.update(automationSessions)
        .set({ automationId: null })
        .where(eq(automationSessions.automationId, row.id))
        .run();
      db.delete(automations).where(eq(automations.id, row.id)).run();
      log(`Deleted managed automation ${pluginName}/${row.managedKey}`);
    }
  }

  // Rename heuristic: warn when a previously-known key disappears AND a new
  // key appears in the same load. Heuristic only — it could be a real
  // rename or two unrelated changes that happened to coincide. The framework
  // can't know which, so we surface a warn log and let the plugin author
  // confirm.
  const existingKeys = new Set(existingByKey.keys());
  const added = defs.filter((d) => !existingKeys.has(d.key)).map((d) => d.key);
  if (dropped.length > 0 && added.length > 0) {
    emitWarn(
      `Plugin "${pluginName}" managed-automation reconcile: key(s) [${dropped.join(', ')}] ` +
      `disappeared while [${added.join(', ')}] appeared — looks like a rename. ` +
      `managed_key is immutable; renaming loses any operator override on the old key. ` +
      `If this is intentional, ignore this. If not, restore the old key in the plugin ` +
      `or use a versioned key (e.g. \`${dropped[0]}@v2\`) so the override survives.`,
    );
  }
}

/**
 * Normalise CRLF and lone CR to LF so a Windows-authored script doesn't
 * drift-banner every plugin update on a Linux host. Persisted in normalised
 * form; comparison against base_default_code is then exact-equality, honest.
 */
function normaliseLineEndings(code: string): string {
  return code.replace(/\r\n?/g, '\n');
}
