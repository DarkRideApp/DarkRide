/**
 * Schedule storage shapes for managed automations.
 *
 * Mirror of the host's `ScheduleConfig` union (shared/types/api.ts).
 * Duplicated rather than imported because the SDK and the `shared/` types
 * live in separate packages with no runtime dependency on each other; the
 * host validates the runtime JSON against its own type, so the SDK shape
 * is the contract a plugin author writes against. Any drift surfaces at
 * the host boundary, not silently.
 *
 * Plugins set `defaultSchedule` on a `ManagedAutomationDef` either as a
 * JSON-stringified `ScheduleConfig` (matching the storage shape on
 * `automations.schedule`) or omit it entirely. The reconciler writes the
 * string straight through.
 */

export interface CronSchedule {
  type: 'cron';
  /**
   * One or more cron expressions; fires on any match.
   *
   * NOTE on the IDE: the bundled `ScheduleEditor` (and the host's
   * AutomationEditor) only display + round-trip a single expression.
   * Plugins are free to ship a multi-expression `defaultSchedule`, but
   * the operator-facing IDE treats it as read-only and refuses to save
   * over it — the operator has to clear via Revert and re-create. If
   * you need an operator-editable multi-expression schedule, model it
   * as multiple managed automations instead.
   */
  expressions: string[];
}

export interface IntervalSchedule {
  type: 'interval';
  /** Fire every N milliseconds, starting at the next tick. */
  intervalMs: number;
}

export interface WindowedIntervalSchedule {
  type: 'windowed_interval';
  /** Fire every N minutes while inside the [windowStart, windowEnd] HH:MM window. */
  intervalMinutes: number;
  /** "HH:MM" 24-hour. */
  windowStart: string;
  /** "HH:MM" 24-hour. windowEnd before windowStart wraps midnight. */
  windowEnd: string;
}

export type ScheduleConfig = CronSchedule | IntervalSchedule | WindowedIntervalSchedule;
