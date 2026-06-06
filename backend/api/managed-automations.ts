import { eq, and, isNotNull } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { automations } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { AutomationScheduler } from '../services/automation-scheduler';
import { validateScheduleConfig } from '../services/schedule-validator';
import type { ScheduleConfig } from '../../shared/types/api';

/**
 * Host REST endpoints for the managed-automations IDE. All endpoints are
 * keyed by (`managed_by`, `managed_key`) — no plugin-specific identifiers
 * appear in the path or body. Same set of endpoints serves every plugin's
 * <ManagedAutomationScriptIDE> component; the component just supplies its
 * own pluginKey/scriptKey as path params.
 *
 * Auth: read endpoints require `core.automations:read`; mutating ones
 * require `core.automations:edit`. Same scopes as ordinary automations
 * because the underlying row IS an automation.
 */

interface ManagedAutomationView {
  pluginKey: string;
  scriptKey: string;
  name: string;
  /** Plugin-authored one-liner; undefined when not set. */
  description?: string;
  /** The script that actually runs. */
  code: string;
  /**
   * The default the plugin currently ships. Null when the plugin no longer
   * declares this script (rare; happens between an uninstall and the
   * boot-time orphan sweep). Distinct from empty-string default.
   */
  currentDefaultCode: string | null;
  /** The default the operator's override was forked from (merge ancestor). */
  baseDefaultCode: string | null;
  isOverridden: boolean;
  allowUserOverride: boolean;
  /** isOverridden && baseDefaultCode !== currentDefaultCode */
  hasDrift: boolean;
  requiresDevice: boolean;
  timeoutMs: number;
  /** Operator-owned (defaults to plugin's enabledByDefault on first insert). */
  enabled: boolean;
  /** Operator-owned schedule JSON. Mirror of `automations.schedule`. */
  schedule: string | null;
  deviceFilter: string | null;
  /**
   * Snapshot of the plugin's currently-shipped `enabledByDefault` —
   * refreshed every plugin load. The IDE's "Revert to default" button on
   * the enabled toggle restores `enabled` to this value.
   */
  currentDefaultEnabled: boolean | null;
  /**
   * Snapshot of the plugin's currently-shipped `defaultSchedule` —
   * refreshed every plugin load. The IDE's "Revert to default" on the
   * schedule editor restores `schedule` to this string.
   */
  currentDefaultSchedule: string | null;
}

function loadManaged(db: AppDatabase, pluginKey: string, scriptKey: string) {
  return db
    .select()
    .from(automations)
    .where(and(eq(automations.managedBy, pluginKey), eq(automations.managedKey, scriptKey)))
    .all()[0];
}

function buildView(row: NonNullable<ReturnType<typeof loadManaged>>): ManagedAutomationView {
  const hasDrift =
    row.isOverridden &&
    row.baseDefaultCode != null &&
    row.currentDefaultCode != null &&
    row.baseDefaultCode !== row.currentDefaultCode;
  return {
    pluginKey: row.managedBy!,
    scriptKey: row.managedKey!,
    name: row.name,
    description: row.description ?? undefined,
    code: row.code,
    currentDefaultCode: row.currentDefaultCode,
    baseDefaultCode: row.baseDefaultCode,
    isOverridden: row.isOverridden,
    allowUserOverride: row.allowUserOverride,
    hasDrift,
    requiresDevice: row.requiresDevice,
    timeoutMs: row.timeoutMs ?? 300_000,
    enabled: row.enabled ?? true,
    schedule: row.schedule,
    deviceFilter: row.deviceFilter,
    currentDefaultEnabled: row.currentDefaultEnabled,
    currentDefaultSchedule: row.currentDefaultSchedule,
  };
}

export function registerManagedAutomationEndpoints(
  db: AppDatabase,
  scheduler?: AutomationScheduler,
): void {
  /**
   * GET /v1/managed-automations/:pluginKey/:scriptKey
   * Returns the effective view: code, drift state, IDE-relevant flags.
   */
  registerEndpoint('GET', '/v1/managed-automations/:pluginKey/:scriptKey', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    res.json({ success: true, data: buildView(row) });
  }, { requires: ['core.automations:read'] });

  /**
   * PUT /v1/managed-automations/:pluginKey/:scriptKey/code
   * Save operator override. Body: { code: string }.
   * - Sets is_overridden = 1
   * - Sets base_default_code = current_default_code (the fork point)
   * - Writes code = body.code
   * Rejects with 409 when allow_user_override = false.
   */
  registerEndpoint('PUT', '/v1/managed-automations/:pluginKey/:scriptKey/code', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const { code } = req.body as { code?: string };
    if (typeof code !== 'string') {
      res.status(400).json({ success: false, error: 'code (string) is required' });
      return;
    }
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    if (!row.allowUserOverride) {
      res.status(409).json({ success: false, error: 'Override not permitted for this script' });
      return;
    }
    // Snapshot the merge ancestor ONLY when the operator first forks (i.e.
    // transitions from not-overridden to overridden). On subsequent saves we
    // must leave base_default_code alone, otherwise drift detection silently
    // breaks: an operator who edits twice after the plugin shipped a new
    // default would inadvertently advance the ancestor and clear the drift
    // banner without ever clicking "Keep mine".
    const baseUpdate = row.isOverridden
      ? {}
      : { baseDefaultCode: row.currentDefaultCode };
    db.update(automations).set({
      code,
      ...baseUpdate,
      isOverridden: true,
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * POST /v1/managed-automations/:pluginKey/:scriptKey/reset
   * Reset to plugin's current default. Drops override (code = current_default_code,
   * base_default_code = NULL, is_overridden = 0). Henceforth this row tracks
   * the default again — silent adoption on subsequent reconciles.
   */
  registerEndpoint('POST', '/v1/managed-automations/:pluginKey/:scriptKey/reset', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    if (row.currentDefaultCode == null) {
      res.status(409).json({ success: false, error: 'No default code available (plugin no longer declares this script)' });
      return;
    }
    db.update(automations).set({
      code: row.currentDefaultCode,
      baseDefaultCode: null,
      isOverridden: false,
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * POST /v1/managed-automations/:pluginKey/:scriptKey/keep-mine
   * Acknowledge drift: keep operator code, advance the merge ancestor so the
   * drift banner stops firing until the plugin ships *another* new default.
   * Equivalent to "git merge --ours" of the new default.
   */
  registerEndpoint('POST', '/v1/managed-automations/:pluginKey/:scriptKey/keep-mine', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    if (!row.isOverridden) {
      res.status(409).json({ success: false, error: 'Not overridden — nothing to keep' });
      return;
    }
    db.update(automations).set({
      baseDefaultCode: row.currentDefaultCode,   // advance ancestor → drift = false
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * GET /v1/managed-automations/:pluginKey/:scriptKey/diff
   * 3-way diff payload: ancestor (base) vs incoming (current default) vs
   * yours (code). The UI renders this however it likes — we just hand
   * back the strings so the IDE owns presentation.
   */
  registerEndpoint('GET', '/v1/managed-automations/:pluginKey/:scriptKey/diff', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    res.json({
      success: true,
      data: {
        ancestor: row.baseDefaultCode,    // may be null if not overridden
        incoming: row.currentDefaultCode, // may be null if plugin uninstalled mid-flight
        yours: row.code,
      },
    });
  }, { requires: ['core.automations:read'] });

  /**
   * PUT /v1/managed-automations/:pluginKey/:scriptKey/schedule
   * Update the operator's schedule (JSON string of `ScheduleConfig` or
   * `null` to disable). Plugin's `current_default_schedule` snapshot is
   * NOT touched — it's owned by the reconciler. Body: `{ schedule:
   * string | null }`.
   *
   * Validates the JSON shape up-front: the scheduler treats an
   * unparseable schedule as "skip this row" silently, so without the
   * pre-check a bad body would persist and the automation would simply
   * stop firing. Also notifies the running scheduler so the change takes
   * effect immediately, not at next host restart.
   */
  registerEndpoint('PUT', '/v1/managed-automations/:pluginKey/:scriptKey/schedule', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const { schedule } = req.body as { schedule?: string | null };
    if (schedule !== null && typeof schedule !== 'string') {
      res.status(400).json({ success: false, error: 'schedule must be a string (JSON) or null' });
      return;
    }
    let parsed: ScheduleConfig | null = null;
    if (schedule !== null) {
      try {
        parsed = JSON.parse(schedule) as ScheduleConfig;
      } catch {
        res.status(400).json({ success: false, error: 'schedule must be valid JSON' });
        return;
      }
      const validation = validateScheduleConfig(parsed);
      if (!validation.valid) {
        res.status(400).json({ success: false, error: validation.error ?? 'invalid schedule' });
        return;
      }
    }
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    db.update(automations).set({
      schedule: schedule ?? null,
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    // Keep the scheduler's in-memory map in sync — without this the change
    // wouldn't take effect until host restart (the scheduler only loads
    // schedules at boot via loadSchedules()).
    if (scheduler) {
      if (parsed) scheduler.setSchedule(row.id, parsed);
      else scheduler.removeSchedule(row.id);
    }
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * PUT /v1/managed-automations/:pluginKey/:scriptKey/enabled
   * Update the operator's enabled flag. Body: `{ enabled: boolean }`.
   * Scheduler skips disabled rows at runtime regardless of override state.
   */
  registerEndpoint('PUT', '/v1/managed-automations/:pluginKey/:scriptKey/enabled', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      return;
    }
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    db.update(automations).set({
      enabled,
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * POST /v1/managed-automations/:pluginKey/:scriptKey/revert/schedule
   * Reset the operator's schedule to the plugin's current default
   * snapshot. `current_default_schedule IS NULL` is a legitimate revert
   * target — it means the plugin ships no schedule, and reverting clears
   * the operator's schedule too. Returns 200 in that case (not 409).
   *
   * Notifies the running scheduler so the change takes effect immediately.
   */
  registerEndpoint('POST', '/v1/managed-automations/:pluginKey/:scriptKey/revert/schedule', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    db.update(automations).set({
      schedule: row.currentDefaultSchedule,
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    if (scheduler) {
      if (row.currentDefaultSchedule) {
        try {
          const parsed = JSON.parse(row.currentDefaultSchedule) as ScheduleConfig;
          scheduler.setSchedule(row.id, parsed);
        } catch {
          // current_default_schedule is plugin-authored and validated by
          // the reconciler before being stored, so a parse failure here
          // means an old row from a buggy plugin version. Fall through to
          // removeSchedule so the scheduler doesn't keep firing the old
          // operator schedule.
          scheduler.removeSchedule(row.id);
        }
      } else {
        scheduler.removeSchedule(row.id);
      }
    }
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * POST /v1/managed-automations/:pluginKey/:scriptKey/revert/enabled
   * Reset the operator's enabled flag to the plugin's current default.
   * 409 if the plugin's default is unknown (`current_default_enabled IS
   * NULL`, which only happens on legacy rows from before migration 0094
   * — newer inserts always seed the column).
   */
  registerEndpoint('POST', '/v1/managed-automations/:pluginKey/:scriptKey/revert/enabled', (req, res) => {
    const { pluginKey, scriptKey } = req.params;
    const row = loadManaged(db, pluginKey, scriptKey);
    if (!row) {
      res.status(404).json({ success: false, error: 'Managed automation not found' });
      return;
    }
    if (row.currentDefaultEnabled == null) {
      res.status(409).json({ success: false, error: 'Plugin default enabled state is not known for this row' });
      return;
    }
    db.update(automations).set({
      enabled: row.currentDefaultEnabled,
      updatedAt: new Date(),
    }).where(eq(automations.id, row.id)).run();
    res.json({ success: true, data: buildView(loadManaged(db, pluginKey, scriptKey)!) });
  }, { requires: ['core.automations:edit'] });

  /**
   * GET /v1/managed-automations
   * Lists every managed automation row across all plugins. Used by the
   * global "Show managed (N)" filter on the automations page so the
   * operator can find the IDE without having to navigate per-plugin.
   */
  registerEndpoint('GET', '/v1/managed-automations', (req, res) => {
    // Filter in SQL so we don't drag every ordinary automation through node;
    // also guards the buildView non-null assertion against a half-stamped row.
    // Project to summary columns only — the list view is for discovery, the
    // operator only needs name / description / drift state to decide where
    // to click. The full body (code, currentDefaultCode, baseDefaultCode,
    // schedule, deviceFilter, etc.) is fetched per-row via GET .../:plugin/:key
    // when the IDE actually opens, keeping the list payload tight even when
    // plugins ship multi-KB scripts.
    const rows = db.select({
      id: automations.id,
      managedBy: automations.managedBy,
      managedKey: automations.managedKey,
      name: automations.name,
      description: automations.description,
      enabled: automations.enabled,
      requiresDevice: automations.requiresDevice,
      isOverridden: automations.isOverridden,
      allowUserOverride: automations.allowUserOverride,
      currentDefaultCode: automations.currentDefaultCode,
      baseDefaultCode: automations.baseDefaultCode,
    }).from(automations)
      .where(and(isNotNull(automations.managedBy), isNotNull(automations.managedKey)))
      .all();
    res.json({
      success: true,
      data: {
        items: rows.map((r) => ({
          pluginKey: r.managedBy!,
          scriptKey: r.managedKey!,
          name: r.name,
          description: r.description ?? undefined,
          enabled: r.enabled ?? true,
          requiresDevice: r.requiresDevice,
          isOverridden: r.isOverridden,
          allowUserOverride: r.allowUserOverride,
          hasDrift:
            r.isOverridden &&
            r.baseDefaultCode != null &&
            r.currentDefaultCode != null &&
            r.baseDefaultCode !== r.currentDefaultCode,
        })),
      },
    });
  }, { requires: ['core.automations:read'] });
}
