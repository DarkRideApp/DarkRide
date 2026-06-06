/**
 * Mirror of the host's DeviceFilter shape. Duplicated rather than imported
 * because the SDK and the `shared/` types live in separate packages with no
 * runtime dependency on each other. Keep in sync with shared/types/api.ts
 * (DeviceFilter / DeviceFilterRule) — the host validates the runtime JSON
 * against its own type, so the SDK shape is the contract a plugin author
 * writes against and any drift between the two will surface at the host
 * boundary, not silently.
 */
export interface ManagedDeviceFilterRule {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: unknown;
}

export interface ManagedDeviceFilter {
  rules: ManagedDeviceFilterRule[];
  deviceIds?: string[];
}

/**
 * Declarative registration of an automation a plugin owns. Passed to
 * `ctx.managedAutomations(defs)` from `register()`. The host stamps
 * provenance + a 3-way merge state machine on the row, but execution,
 * scheduling, sessions, and device binding are unchanged — managed is
 * just "this automation row's `managed_by` is set".
 *
 * Spec:
 *   docs/superpowers/specs/2026-06-06-managed-automations-framework-design.md
 *   (in plugin-disney-auth — the framework's first consumer)
 *
 * Lifecycle terms:
 *   - `code` (existing automation column) — what actually runs.
 *   - `currentDefaultCode` — the default the plugin currently ships;
 *     refreshed on every plugin load.
 *   - `baseDefaultCode` — the default the operator's override was forked
 *     from (merge ancestor). NULL when not overridden.
 *   - `isOverridden` — the switch.
 *   - Drift = isOverridden && (baseDefaultCode != currentDefaultCode).
 *     i.e. the operator has local edits AND the plugin has since shipped
 *     a new default. That single boolean drives the drift banner in the IDE.
 *
 * Seeds vs tracked properties:
 *   - `code` is the only 3-way tracked field.
 *   - `defaultSchedule`, `enabledByDefault`, `defaultDeviceFilter` are
 *     SEEDS only — written once on insert from this declaration, then
 *     OPERATOR-OWNED (last-write-wins, never re-touched by reconcile).
 *     The mental model: the plugin owns the logic; the operator owns
 *     the cadence.
 */
export interface ManagedAutomationDef {
  /**
   * Stable identity for this script within the owning plugin. **Immutable
   * across plugin versions** — renaming a key is a delete + insert and
   * loses any operator override. If you need to evolve, use a versioned
   * key (e.g. `example-poller@v2`) rather than renaming.
   */
  key: string;

  /** Display name shown to the operator in the automations list. */
  name: string;

  /** One-line description for the operator. */
  description?: string;

  /**
   * The default script source. Convention: import from a bundled asset
   * resolved via `ctx.pluginDir`, not inline in TypeScript, so it stays
   * readable, lintable, and diffable. The framework treats this as an
   * opaque string and does exact-equality comparison for drift
   * detection (after LF-normalisation on both sides).
   */
  code: string;

  /**
   * SEED only — the schedule the host writes on first insert.
   * Operator-owned thereafter and never re-touched by reconcile.
   * Accepts the same shape as a hand-authored automation's
   * `schedule` column.
   */
  defaultSchedule?: string;

  /** SEED only — initial `enabled` value on insert. Default: true. */
  enabledByDefault?: boolean;

  /** SEED only — initial `device_filter` value on insert. */
  defaultDeviceFilter?: ManagedDeviceFilter;

  /**
   * Does the automation require a device to run? Maps directly onto the
   * existing `automations.requires_device` column. When false the script
   * runs headless (tools + docstore + egress, but no device handle).
   * Default: true.
   */
  requiresDevice?: boolean;

  /**
   * Per-run timeout. Maps onto `automations.timeout_ms`. Default: the
   * existing runner default (5 min).
   */
  timeoutMs?: number;

  /**
   * Can the operator fork this script in the IDE? When false, the IDE
   * component renders read-only (or the plugin omits it) and the
   * override paths return 409. Default: true.
   *
   * Edge case: if a plugin update flips this to false while an
   * override already exists, the host keeps running the operator's
   * `code` and surfaces a one-time notice rather than silently
   * clobbering operator work.
   */
  allowUserOverride?: boolean;

  /**
   * When this automation's run fails, should the host emit the normal
   * `automation:failure` notification event (the one a hand-authored
   * automation would emit)? Defaults to **false** for managed runs:
   * the operator didn't author this script and most plugins surface
   * health in their own UI by reading session rows. Plugins that want
   * the standard failure-notification pipeline opt in by setting this
   * to true.
   */
  emitFailureNotification?: boolean;
}
