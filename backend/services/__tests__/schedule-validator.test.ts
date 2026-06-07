import { describe, it, expect } from 'vitest';
import { validateScheduleConfig } from '../schedule-validator';

describe('validateScheduleConfig', () => {
  describe('cron', () => {
    it('accepts a single well-formed expression', () => {
      const r = validateScheduleConfig({ type: 'cron', expressions: ['*/5 * * * *'] });
      expect(r.valid).toBe(true);
    });

    it('accepts multiple expressions', () => {
      const r = validateScheduleConfig({
        type: 'cron',
        expressions: ['0 9 * * *', '0 17 * * *'],
      });
      expect(r.valid).toBe(true);
    });

    it('rejects empty expressions array', () => {
      const r = validateScheduleConfig({ type: 'cron', expressions: [] });
      expect(r.valid).toBe(false);
    });

    it('rejects expressions with the wrong field count', () => {
      const r = validateScheduleConfig({ type: 'cron', expressions: ['1 2 3 4'] });
      expect(r.valid).toBe(false);
    });
  });

  describe('interval', () => {
    it('accepts intervalMs of 60_000 (the minimum)', () => {
      const r = validateScheduleConfig({ type: 'interval', intervalMs: 60_000 });
      expect(r.valid).toBe(true);
    });

    it('rejects intervalMs < 60_000', () => {
      const r = validateScheduleConfig({ type: 'interval', intervalMs: 30_000 });
      expect(r.valid).toBe(false);
    });

    it('rejects NaN intervalMs', () => {
      // Regression: pre-fix, `typeof NaN === "number"` AND `NaN < 60000`
      // is false, so NaN slipped through and produced a never-firing
      // schedule.
      const r = validateScheduleConfig({ type: 'interval', intervalMs: NaN });
      expect(r.valid).toBe(false);
    });

    it('rejects Infinity intervalMs', () => {
      const r = validateScheduleConfig({ type: 'interval', intervalMs: Infinity });
      expect(r.valid).toBe(false);
    });
  });

  describe('windowed_interval', () => {
    it('accepts a valid windowed schedule', () => {
      const r = validateScheduleConfig({
        type: 'windowed_interval',
        intervalMinutes: 15,
        windowStart: '09:00',
        windowEnd: '17:00',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects NaN intervalMinutes', () => {
      const r = validateScheduleConfig({
        type: 'windowed_interval',
        intervalMinutes: NaN,
        windowStart: '09:00',
        windowEnd: '17:00',
      });
      expect(r.valid).toBe(false);
    });

    it('rejects out-of-range hours like 99:99', () => {
      // Regression: pre-fix, /^\d{2}:\d{2}$/ matched "99:99" so the
      // schedule passed validation but the in-window check could never
      // succeed.
      const r = validateScheduleConfig({
        type: 'windowed_interval',
        intervalMinutes: 5,
        windowStart: '99:99',
        windowEnd: '17:00',
      });
      expect(r.valid).toBe(false);
    });

    it('rejects minutes > 59', () => {
      const r = validateScheduleConfig({
        type: 'windowed_interval',
        intervalMinutes: 5,
        windowStart: '09:00',
        windowEnd: '23:60',
      });
      expect(r.valid).toBe(false);
    });

    it('accepts boundary times 00:00 and 23:59', () => {
      const r = validateScheduleConfig({
        type: 'windowed_interval',
        intervalMinutes: 5,
        windowStart: '00:00',
        windowEnd: '23:59',
      });
      expect(r.valid).toBe(true);
    });
  });

  it('rejects an unknown schedule type', () => {
    const r = validateScheduleConfig({ type: 'every_eclipse' });
    expect(r.valid).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateScheduleConfig(null).valid).toBe(false);
    expect(validateScheduleConfig('string').valid).toBe(false);
    expect(validateScheduleConfig(42).valid).toBe(false);
  });
});
