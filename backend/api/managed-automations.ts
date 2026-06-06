import { eq, and, isNotNull } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { automations } from '../db/schema';
import type { AppDatabase } from '../db/index';

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
  enabled: boolean;
  schedule: string | null;
  deviceFilter: string | null;
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
  };
}

export function registerManagedAutomationEndpoints(db: AppDatabase): void {
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
