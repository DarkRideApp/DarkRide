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
    if (typeof intervalMs !== 'number' || intervalMs < 60000) {
      return { valid: false, error: 'interval schedule requires intervalMs >= 60000' };
    }
    return { valid: true };
  }
  if (c.type === 'windowed_interval') {
    const w = c as { intervalMinutes?: unknown; windowStart?: unknown; windowEnd?: unknown };
    if (typeof w.intervalMinutes !== 'number' || w.intervalMinutes < 1) {
      return { valid: false, error: 'windowed_interval schedule requires intervalMinutes >= 1' };
    }
    if (typeof w.windowStart !== 'string' || !/^\d{2}:\d{2}$/.test(w.windowStart)) {
      return { valid: false, error: 'windowed_interval schedule requires windowStart in HH:MM format' };
    }
    if (typeof w.windowEnd !== 'string' || !/^\d{2}:\d{2}$/.test(w.windowEnd)) {
      return { valid: false, error: 'windowed_interval schedule requires windowEnd in HH:MM format' };
    }
    return { valid: true };
  }
  return { valid: false, error: 'schedule type must be "cron", "interval", or "windowed_interval"' };
}
