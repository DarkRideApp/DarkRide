import type { ScheduleValue, ScheduleMode } from '../components/ScheduleEditor';

/**
 * Local duplicate of `ScheduleConfig` from `../../types/schedule` so the
 * react/ tsconfig (rootDir: ./src/react) can typecheck without reaching
 * across into the types/ tree. Source of truth is `src/types/schedule.ts`
 * — they re-export the same shape from `@darkrideapp/plugin-sdk`. Keep
 * in sync; the underlying SDK index exports the canonical one for the
 * host backend.
 */
type CronSchedule = { type: 'cron'; expressions: string[] };
type IntervalSchedule = { type: 'interval'; intervalMs: number };
type WindowedIntervalSchedule = {
  type: 'windowed_interval';
  intervalMinutes: number;
  windowStart: string;
  windowEnd: string;
};
type ScheduleConfig = CronSchedule | IntervalSchedule | WindowedIntervalSchedule;

/**
 * Convert a stored `ScheduleConfig` (the JSON the host writes into
 * `automations.schedule`) into the working form ScheduleEditor takes —
 * a cron string + a default `ScheduleValue.mode` hint so the editor opens
 * in the right tab.
 *
 * Returns `null` when the config is null / unparseable / not a recognised
 * shape — the SDK IDE treats that as "no schedule, edit to add one".
 *
 * Mirrors the bridge inside the host's AutomationEditor.tsx so plugins
 * don't have to reinvent it.
 */
export function scheduleConfigToEditor(
  config: ScheduleConfig | null | undefined,
): { cronString: string; mode: ScheduleMode } | null {
  if (!config) return null;
  if (config.type === 'cron') {
    return { cronString: config.expressions[0] ?? '* * * * *', mode: 'cron' };
  }
  if (config.type === 'interval') {
    const mins = Math.round(config.intervalMs / 60_000);
    // Match what AutomationEditor does — express minute-multiples as `*/N`
    // and hour-multiples as `0 */N * * *` so the editor's "interval" tab
    // round-trips cleanly.
    const cronString = mins >= 60 && mins % 60 === 0
      ? `0 */${mins / 60} * * *`
      : `*/${mins} * * * *`;
    return { cronString, mode: 'interval' };
  }
  if (config.type === 'windowed_interval') {
    // The cron string is only a display approximation here; the windowed
    // schedule is stored as the structured shape and the editor builds
    // the real ScheduleConfig back from ScheduleValue on save.
    return {
      cronString: `Every ${config.intervalMinutes}m ${config.windowStart}-${config.windowEnd}`,
      mode: 'windowed',
    };
  }
  return null;
}

/**
 * Convert the editor's working form back into the storage `ScheduleConfig`
 * that the host's `automations.schedule` column expects. Pair with the
 * `onChange` payload from ScheduleEditor.
 *
 * Returns `null` when the value is not a usable schedule — e.g. an empty
 * cron string. Callers should treat null as "clear the schedule".
 */
export function editorValueToScheduleConfig(
  value: ScheduleValue,
  cronString: string,
): ScheduleConfig | null {
  switch (value.mode) {
    case 'interval':
      if (!value.intervalMinutes || value.intervalMinutes < 1) return null;
      return { type: 'interval', intervalMs: value.intervalMinutes * 60_000 };
    case 'daily':
    case 'cron': {
      const trimmed = cronString.trim();
      if (!trimmed) return null;
      return { type: 'cron', expressions: [trimmed] };
    }
    case 'windowed':
      if (!value.windowIntervalMinutes || value.windowIntervalMinutes < 1) return null;
      return {
        type: 'windowed_interval',
        intervalMinutes: value.windowIntervalMinutes,
        windowStart: value.windowStart,
        windowEnd: value.windowEnd,
      };
    default:
      return null;
  }
}

/**
 * Cheap equality check for two `ScheduleConfig | null` values. Used by the
 * IDE to decide whether the "Revert to default" button should be enabled.
 * Exact field-by-field compare; doesn't try to normalise semantically
 * equivalent cron strings (a `slash-2` step vs the `0-N/2` form would
 * register as different) — those would look different in the editor
 * too, so an exact compare matches operator intent.
 */
export function schedulesEqual(
  a: ScheduleConfig | null | undefined,
  b: ScheduleConfig | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'cron':
      return JSON.stringify(a.expressions) === JSON.stringify((b as typeof a).expressions);
    case 'interval':
      return a.intervalMs === (b as typeof a).intervalMs;
    case 'windowed_interval': {
      const bw = b as typeof a;
      return a.intervalMinutes === bw.intervalMinutes
        && a.windowStart === bw.windowStart
        && a.windowEnd === bw.windowEnd;
    }
  }
}
