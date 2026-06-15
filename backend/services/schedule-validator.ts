import type { ScheduleConfig } from '../../shared/types/api';

/**
 * Shape validation for the `ScheduleConfig` payload persisted into
 * `automations.schedule`. Shared between the ordinary automations API,
 * the managed-automations API, and the AI tool surface so all three
 * routes reject the same invalid inputs.
 *
 * The scheduler treats an unparseable schedule as "skip this row"
 * (see `automation-scheduler.ts:loadSchedules`), so validating up-front
 * is the only way to surface the failure to the caller — without it,
 * a bad `{schedule}` body silently breaks scheduling until the operator
 * notices the automation hasn't fired.
 */
export function validateScheduleConfig(config: unknown): { valid: boolean; error?: string } {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'schedule must be an object' };
  }
  const c = config as Partial<ScheduleConfig> & { type?: string };
  if (c.type === 'cron') {
    const expressions = (c as { expressions?: unknown }).expressions;
    if (!Array.isArray(expressions) || expressions.length === 0) {
      return { valid: false, error: 'cron schedule requires non-empty expressions array' };
    }
    for (const expr of expressions) {
      if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) {
        return { valid: false, error: `invalid cron expression: ${expr}` };
      }
    }
    return { valid: true };
  }
  if (c.type === 'interval') {
    const intervalMs = (c as { intervalMs?: unknown }).intervalMs;
    // `typeof NaN === 'number'` and `NaN < 60000` is false, so plain
    // < / >= comparisons let NaN/Infinity through and produce a schedule
    // that never fires. `Number.isFinite` rejects both.
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 60000) {
      return { valid: false, error: 'interval schedule requires finite intervalMs >= 60000' };
    }
    return { valid: true };
  }
  if (c.type === 'windowed_interval') {
    const w = c as { intervalMinutes?: unknown; windowStart?: unknown; windowEnd?: unknown };
    if (typeof w.intervalMinutes !== 'number' || !Number.isFinite(w.intervalMinutes) || w.intervalMinutes < 1) {
      return { valid: false, error: 'windowed_interval schedule requires finite intervalMinutes >= 1' };
    }
    // The earlier /^\d{2}:\d{2}$/ accepted strings like "99:99" — match
    // a real clock time so isInWindow can rely on the values.
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof w.windowStart !== 'string' || !hhmm.test(w.windowStart)) {
      return { valid: false, error: 'windowed_interval schedule requires windowStart as HH:MM (00:00 – 23:59)' };
    }
    if (typeof w.windowEnd !== 'string' || !hhmm.test(w.windowEnd)) {
      return { valid: false, error: 'windowed_interval schedule requires windowEnd as HH:MM (00:00 – 23:59)' };
    }
    return { valid: true };
  }
  return { valid: false, error: 'schedule type must be "cron", "interval", or "windowed_interval"' };
}
