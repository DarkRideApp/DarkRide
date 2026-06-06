import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { AutomationScheduler } from './automation-scheduler';
import { AutomationRunner } from './automation-runner';
import { PythonBridgeManager } from './python-bridge';
import type { AppDatabase } from '../db/index';
import type { ScheduleConfig } from '../../shared/types/api';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

describe('AutomationScheduler', () => {
  let db: AppDatabase;
  let runner: AutomationRunner;
  let scheduler: AutomationScheduler;

  beforeEach(() => {
    db = createTestDb();
    const bridgeManager = new PythonBridgeManager(db);
    runner = new AutomationRunner(db, bridgeManager);
    scheduler = new AutomationScheduler(db, runner);
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  function insertAutomation(name: string, scheduleJson?: string, enabled = true): number {
    const now = Date.now();
    db.insert(schema.automations).values({
      name,
      code: 'code',
      passcode: 'pass',
      createdAt: new Date(now),
      updatedAt: new Date(now),
      schedule: scheduleJson ?? null,
      enabled,
    }).run();
    const rows = db.select().from(schema.automations).all();
    return rows[rows.length - 1].id;
  }

  describe('loadSchedules()', () => {
    it('reads schedules from DB', () => {
      const cronConfig: ScheduleConfig = { type: 'cron', expressions: ['0 9 * * *'] };
      const intervalConfig: ScheduleConfig = { type: 'interval', intervalMs: 120000 };

      insertAutomation('CronAuto', JSON.stringify(cronConfig));
      insertAutomation('IntervalAuto', JSON.stringify(intervalConfig));
      insertAutomation('NoSchedule');

      scheduler.loadSchedules();

      const schedules = scheduler.getSchedules();
      expect(schedules.size).toBe(2);
    });

    it('skips invalid JSON', () => {
      insertAutomation('BadJson', 'not-json');

      scheduler.loadSchedules();

      expect(scheduler.getSchedules().size).toBe(0);
    });

    it('loads cron config correctly', () => {
      const config: ScheduleConfig = { type: 'cron', expressions: ['0 9 * * *', '0 17 * * *'] };
      const id = insertAutomation('Cron', JSON.stringify(config));

      scheduler.loadSchedules();

      const loaded = scheduler.getSchedule(id);
      expect(loaded).toEqual(config);
    });

    it('loads interval config correctly', () => {
      const config: ScheduleConfig = { type: 'interval', intervalMs: 300000 };
      const id = insertAutomation('Interval', JSON.stringify(config));

      scheduler.loadSchedules();

      const loaded = scheduler.getSchedule(id);
      expect(loaded).toEqual(config);
    });

    it('skips disabled automations', () => {
      const config: ScheduleConfig = { type: 'cron', expressions: ['0 9 * * *'] };
      insertAutomation('EnabledAuto', JSON.stringify(config), true);
      insertAutomation('DisabledAuto', JSON.stringify(config), false);

      scheduler.loadSchedules();

      expect(scheduler.getSchedules().size).toBe(1);
    });
  });

  describe('checkSchedules() re-checks enabled', () => {
    it('removes schedule when automation is disabled between checks', async () => {
      const config: ScheduleConfig = { type: 'interval', intervalMs: 1 };
      const id = insertAutomation('Test', JSON.stringify(config));
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      scheduler.loadSchedules();
      expect(scheduler.getSchedules().size).toBe(1);

      // Disable the automation
      const { eq } = await import('drizzle-orm');
      db.update(schema.automations).set({ enabled: false }).where(eq(schema.automations.id, id)).run();

      // Trigger schedule check via enqueue + processQueue (checkSchedules is private,
      // but we can call start() which runs checkSchedules internally)
      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      // Access private method for testing
      (scheduler as any).checkSchedules();
      await new Promise(r => setTimeout(r, 50));

      // Schedule should be removed and no automation should run
      expect(scheduler.getSchedules().size).toBe(0);
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  describe('setSchedule()', () => {
    it('persists to DB and in-memory', () => {
      const id = insertAutomation('Test');
      const config: ScheduleConfig = { type: 'cron', expressions: ['30 8 * * 1-5'] };

      scheduler.setSchedule(id, config);

      // Check in-memory
      expect(scheduler.getSchedule(id)).toEqual(config);

      // Check DB
      const row = db.select().from(schema.automations).all().find(a => a.id === id);
      expect(row?.schedule).toBe(JSON.stringify(config));
    });

    it('overwrites existing schedule', () => {
      const config1: ScheduleConfig = { type: 'cron', expressions: ['0 9 * * *'] };
      const id = insertAutomation('Test', JSON.stringify(config1));
      scheduler.loadSchedules();

      const config2: ScheduleConfig = { type: 'interval', intervalMs: 60000 };
      scheduler.setSchedule(id, config2);

      expect(scheduler.getSchedule(id)).toEqual(config2);
    });
  });

  describe('removeSchedule()', () => {
    it('clears from DB and in-memory', () => {
      const config: ScheduleConfig = { type: 'cron', expressions: ['0 * * * *'] };
      const id = insertAutomation('Test', JSON.stringify(config));
      scheduler.loadSchedules();

      scheduler.removeSchedule(id);

      expect(scheduler.getSchedule(id)).toBeNull();

      const row = db.select().from(schema.automations).all().find(a => a.id === id);
      expect(row?.schedule).toBeNull();
    });
  });

  describe('getSchedule()', () => {
    it('returns config for existing schedule', () => {
      const config: ScheduleConfig = { type: 'interval', intervalMs: 120000 };
      const id = insertAutomation('Test', JSON.stringify(config));
      scheduler.loadSchedules();

      expect(scheduler.getSchedule(id)).toEqual(config);
    });

    it('returns null for non-existent schedule', () => {
      expect(scheduler.getSchedule(999)).toBeNull();
    });
  });

  describe('enqueue() with triggerType', () => {
    it('carries schedule trigger type by default', () => {
      scheduler.enqueue(1);
      const queue = scheduler.getQueue();
      expect(queue[0].triggerType).toBe('schedule');
    });

    it('carries api trigger type when specified', () => {
      scheduler.enqueue(1, 'api');
      const queue = scheduler.getQueue();
      expect(queue[0].triggerType).toBe('api');
    });

    it('does not duplicate queue entries', () => {
      scheduler.enqueue(1, 'schedule');
      scheduler.enqueue(1, 'api');
      expect(scheduler.getQueue()).toHaveLength(1);
    });
  });

  describe('queue processing passes trigger type to runner', () => {
    it('passes api trigger type from queue entry', async () => {
      const id = insertAutomation('Test');
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(id, 'api');

      // Wait for async processQueue
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(id, 'dev1', 'api');
    });

    it('passes schedule trigger type from queue entry', async () => {
      const id = insertAutomation('Test');
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(id, 'schedule');

      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(id, 'dev1', 'schedule');
    });

    // Regression for the "deviceless scheduled run shows a device in session
    // history" bug. Pre-fix, processQueue() called findAvailableDevice()
    // unconditionally and assigned whichever device happened to be idle —
    // even when the automation declared requiresDevice: false. The runner
    // then recorded that device on the session row.
    it('does NOT assign a device to a deviceless automation', async () => {
      const now = Date.now();
      db.insert(schema.automations).values({
        name: 'Deviceless',
        code: 'code', passcode: 'pass',
        createdAt: new Date(now), updatedAt: new Date(now),
        requiresDevice: false, enabled: true,
      }).run();
      const rows = db.select().from(schema.automations).all();
      const id = rows[rows.length - 1].id;
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(id, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(id, undefined, 'schedule');
    });
  });

  describe('isInWindow()', () => {
    it('returns true when time is within a same-day window', () => {
      const noon = new Date(2026, 1, 13, 12, 0, 0);
      expect(scheduler.isInWindow('09:00', '17:00', noon)).toBe(true);
    });

    it('returns false when time is before a same-day window', () => {
      const early = new Date(2026, 1, 13, 8, 59, 0);
      expect(scheduler.isInWindow('09:00', '17:00', early)).toBe(false);
    });

    it('returns false when time is after a same-day window', () => {
      const late = new Date(2026, 1, 13, 17, 1, 0);
      expect(scheduler.isInWindow('09:00', '17:00', late)).toBe(false);
    });

    it('returns true at window start boundary', () => {
      const atStart = new Date(2026, 1, 13, 9, 0, 0);
      expect(scheduler.isInWindow('09:00', '17:00', atStart)).toBe(true);
    });

    it('returns true at window end boundary', () => {
      const atEnd = new Date(2026, 1, 13, 17, 0, 0);
      expect(scheduler.isInWindow('09:00', '17:00', atEnd)).toBe(true);
    });

    it('returns true before midnight for a midnight-crossing window', () => {
      const beforeMidnight = new Date(2026, 1, 13, 23, 45, 0);
      expect(scheduler.isInWindow('23:30', '16:30', beforeMidnight)).toBe(true);
    });

    it('returns true just after midnight for a midnight-crossing window', () => {
      const afterMidnight = new Date(2026, 1, 14, 0, 15, 0);
      expect(scheduler.isInWindow('23:30', '16:30', afterMidnight)).toBe(true);
    });

    it('returns true at end boundary of a midnight-crossing window', () => {
      const atEnd = new Date(2026, 1, 14, 16, 30, 0);
      expect(scheduler.isInWindow('23:30', '16:30', atEnd)).toBe(true);
    });

    it('returns false in the gap of a midnight-crossing window', () => {
      const inGap = new Date(2026, 1, 13, 18, 0, 0);
      expect(scheduler.isInWindow('23:30', '16:30', inGap)).toBe(false);
    });

    it('returns false just before the start of a midnight-crossing window', () => {
      const justBefore = new Date(2026, 1, 13, 23, 29, 0);
      expect(scheduler.isInWindow('23:30', '16:30', justBefore)).toBe(false);
    });

    it('returns false just after the end of a midnight-crossing window', () => {
      const justAfter = new Date(2026, 1, 14, 16, 31, 0);
      expect(scheduler.isInWindow('23:30', '16:30', justAfter)).toBe(false);
    });
  });

  describe('windowed_interval scheduling', () => {
    it('loads windowed_interval config correctly', () => {
      const config: ScheduleConfig = { type: 'windowed_interval', intervalMinutes: 5, windowStart: '23:30', windowEnd: '16:30' };
      const id = insertAutomation('Windowed', JSON.stringify(config));

      scheduler.loadSchedules();

      expect(scheduler.getSchedule(id)).toEqual(config);
    });

    it('fires when inside window and interval has elapsed', async () => {
      const config: ScheduleConfig = { type: 'windowed_interval', intervalMinutes: 5, windowStart: '23:30', windowEnd: '16:30' };
      const id = insertAutomation('Windowed', JSON.stringify(config));
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      scheduler.loadSchedules();

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({ sessionId: 1, success: true });

      // 01:00 is inside the midnight-crossing 23:30→16:30 window
      const now = new Date(2026, 1, 14, 1, 0, 0);
      const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
      (scheduler as any).lastIntervalFired.set(id, tenMinAgo);

      (scheduler as any).checkSchedules(now);

      await new Promise(r => setTimeout(r, 50));
      expect(mockRun).toHaveBeenCalledWith(id, 'dev1', 'schedule');
    });

    it('does not fire when outside window even if interval elapsed', () => {
      const config: ScheduleConfig = { type: 'windowed_interval', intervalMinutes: 5, windowStart: '23:30', windowEnd: '16:30' };
      const id = insertAutomation('Windowed', JSON.stringify(config));

      scheduler.loadSchedules();

      // 18:00 is in the gap of a 23:30→16:30 midnight-crossing window
      const now = new Date(2026, 1, 13, 18, 0, 0);
      const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
      (scheduler as any).lastIntervalFired.set(id, tenMinAgo);

      (scheduler as any).checkSchedules(now);

      expect(scheduler.getQueue()).toHaveLength(0);
    });

    it('does not fire when inside window but interval has not elapsed', () => {
      const config: ScheduleConfig = { type: 'windowed_interval', intervalMinutes: 5, windowStart: '23:30', windowEnd: '16:30' };
      const id = insertAutomation('Windowed', JSON.stringify(config));

      scheduler.loadSchedules();

      const now = new Date(2026, 1, 14, 1, 0, 0);
      const twoMinAgo = new Date(now.getTime() - 2 * 60_000);
      (scheduler as any).lastIntervalFired.set(id, twoMinAgo);

      (scheduler as any).checkSchedules(now);

      expect(scheduler.getQueue()).toHaveLength(0);
    });
  });

  describe('cron matching', () => {
    it('matches exact minute and hour', () => {
      const date = new Date(2026, 1, 13, 9, 30, 0);
      expect(scheduler.matchesCrontab('30 9 * * *', date)).toBe(true);
    });

    it('does not match wrong minute', () => {
      const date = new Date(2026, 1, 13, 9, 31, 0);
      expect(scheduler.matchesCrontab('30 9 * * *', date)).toBe(false);
    });

    it('matches wildcard', () => {
      const date = new Date(2026, 1, 13, 9, 0, 0);
      expect(scheduler.matchesCrontab('0 * * * *', date)).toBe(true);
    });

    it('matches step values', () => {
      const date = new Date(2026, 1, 13, 9, 15, 0);
      expect(scheduler.matchesCrontab('*/15 * * * *', date)).toBe(true);
      expect(scheduler.matchesCrontab('*/15 * * * *', new Date(2026, 1, 13, 9, 16, 0))).toBe(false);
    });

    it('matches day of week range', () => {
      // 2026-02-13 is a Friday (day 5)
      const friday = new Date(2026, 1, 13, 9, 0, 0);
      expect(scheduler.matchesCrontab('0 9 * * 1-5', friday)).toBe(true);
      expect(scheduler.matchesCrontab('0 9 * * 0', friday)).toBe(false);
    });
  });

  describe('start() loads schedules', () => {
    it('loads schedules on start', () => {
      const config: ScheduleConfig = { type: 'cron', expressions: ['0 9 * * *'] };
      insertAutomation('Auto', JSON.stringify(config));

      scheduler.start();

      expect(scheduler.getSchedules().size).toBe(1);
    });
  });

  describe('findAvailableDevice with device filter', () => {
    function insertAutomationWithFilter(name: string, deviceFilter: string | null): number {
      const now = Date.now();
      db.insert(schema.automations).values({
        name,
        code: 'code',
        passcode: 'pass',
        deviceFilter,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }).run();
      const rows = db.select().from(schema.automations).all();
      return rows[rows.length - 1].id;
    }

    it('picks device matching deviceIds filter', async () => {
      db.insert(schema.devices).values({ id: 'dev1' }).run();
      db.insert(schema.devices).values({ id: 'dev2' }).run();

      const autoId = insertAutomationWithFilter('Filtered', JSON.stringify({ rules: [], deviceIds: ['dev2'] }));

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(autoId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(autoId, 'dev2', 'schedule');
    });

    it('returns no device when deviceIds filter excludes all devices', async () => {
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      const autoId = insertAutomationWithFilter('Filtered', JSON.stringify({ rules: [], deviceIds: ['dev99'] }));

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(autoId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).not.toHaveBeenCalled();
      // Entry should still be in queue since no device available
      expect(scheduler.getQueue()).toHaveLength(1);
    });

    it('works with no device filter', async () => {
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      const autoId = insertAutomationWithFilter('NoFilter', null);

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(autoId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(autoId, 'dev1', 'schedule');
    });

    it('applies rule-based filter (isRooted)', async () => {
      db.insert(schema.devices).values({ id: 'dev1', isRooted: false }).run();
      db.insert(schema.devices).values({ id: 'dev2', isRooted: true }).run();

      const autoId = insertAutomationWithFilter('Filtered', JSON.stringify({
        rules: [{ field: 'isRooted', operator: 'eq', value: true }],
      }));

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(autoId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(autoId, 'dev2', 'schedule');
    });

    it('migrates old-format filter on the fly', async () => {
      db.insert(schema.devices).values({ id: 'dev1', isRooted: false }).run();
      db.insert(schema.devices).values({ id: 'dev2', isRooted: true }).run();

      // Old format: { rooted: true }
      const autoId = insertAutomationWithFilter('Filtered', JSON.stringify({ rooted: true }));

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(autoId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      expect(mockRun).toHaveBeenCalledWith(autoId, 'dev2', 'schedule');
    });

    it('ignores invalid device filter JSON', async () => {
      db.insert(schema.devices).values({ id: 'dev1' }).run();

      const autoId = insertAutomationWithFilter('BadFilter', 'not-json');

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(autoId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      // Should fall back to any device
      expect(mockRun).toHaveBeenCalledWith(autoId, 'dev1', 'schedule');
    });
  });

  describe('queue resilience: head should not block runnable entries', () => {
    // Real-world incident 2026-06-05: a deviceless automation was queued
    // behind a device-requiring one. All devices were offline overnight, so
    // the head sat unrunnable at position [0] forever, blocking the
    // deviceless entry (and every other deviceless or available-device
    // automation) from running. The user noticed because their morning
    // scheduled runs never happened.
    //
    // Pre-fix: processQueue() returned at the first unrunnable head — single
    // head-of-line block holds the entire queue. These tests cover the
    // remediation: skip to the next runnable entry, and time-out entries that
    // can never become runnable so the operator sees them as failed runs.

    function insertDevicelessAutomation(name: string): number {
      const now = Date.now();
      db.insert(schema.automations).values({
        name,
        code: 'code',
        passcode: 'pass',
        requiresDevice: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }).run();
      const rows = db.select().from(schema.automations).all();
      return rows[rows.length - 1].id;
    }

    function insertDeviceRequiringAutomation(name: string, deviceFilter?: string): number {
      const now = Date.now();
      db.insert(schema.automations).values({
        name,
        code: 'code',
        passcode: 'pass',
        requiresDevice: true,
        deviceFilter: deviceFilter ?? null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }).run();
      const rows = db.select().from(schema.automations).all();
      return rows[rows.length - 1].id;
    }

    it('runs a deviceless entry when a device-requiring entry ahead of it has no device available', async () => {
      // No devices configured at all — so the head entry definitely can't run
      const blockerId = insertDeviceRequiringAutomation('Blocker');
      const devicelessId = insertDevicelessAutomation('DevicelessAutomation');

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      scheduler.enqueue(blockerId, 'schedule');
      scheduler.enqueue(devicelessId, 'schedule');
      await new Promise(r => setTimeout(r, 50));

      // The deviceless entry should run; the blocker stays parked in the queue.
      expect(mockRun).toHaveBeenCalledWith(devicelessId, undefined, 'schedule');
      expect(mockRun).not.toHaveBeenCalledWith(blockerId, expect.anything(), expect.anything());
      const remaining = scheduler.getQueue();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].automationId).toBe(blockerId);
    });

    it('drops a queue entry whose deadline has passed and writes a failed automation_session row', async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      // Use a fresh scheduler with a tiny deadline so we can race past it
      const fastScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 100,
      });

      const blockerId = insertDeviceRequiringAutomation('Blocker');

      // Spy so a real runAutomation call would fail loudly — we expect it NOT to be called
      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 999, success: true,
      });

      fastScheduler.enqueue(blockerId, 'schedule');
      // Advance past the 100ms deadline. In production the 60s checkInterval
      // re-fires processQueue and triggers the eviction; here we call it
      // directly since fake timers don't auto-advance setInterval inside
      // this advanceTimersByTimeAsync window.
      await vi.advanceTimersByTimeAsync(500);
      await (fastScheduler as any).processQueue();

      // runAutomation should never have been called for the blocker — there's no device.
      expect(mockRun).not.toHaveBeenCalled();

      // A failed automation_sessions row should have been written so the
      // operator sees it in the normal session history list, not just buried
      // in the scheduler log.
      const sessions = db.select().from(schema.automationSessions).all();
      const failed = sessions.filter((s) => s.status === 'failed' && s.automationId === blockerId);
      expect(failed).toHaveLength(1);
      expect(failed[0].triggerType).toBe('schedule');
      // Schema uses `logs` for both success traces and failure reasons.
      expect(failed[0].logs ?? '').toMatch(/queue/i);
      expect(failed[0].logs ?? '').toMatch(/no device|all devices/i);

      // The expired entry should be gone from the queue.
      expect(fastScheduler.getQueue()).toHaveLength(0);

      vi.useRealTimers();
      fastScheduler.stop();
    });

    it('clears the queue-health-alert timer after eviction empties the queue', async () => {
      // Regression test for PR #14 review (Copilot, comment 3360696236):
      // if every queued entry hits its deadline at once and they all get
      // dropped, the earlier code path that cleared queueAlertTimer was only
      // reached after a successful splice. So a queue that drained via
      // eviction would still fire a stale "Queue health alert" minutes later.
      vi.useFakeTimers({ now: 1_000_000 });
      const fastScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 100,
      });

      const blockerId = insertDeviceRequiringAutomation('Blocker');
      vi.spyOn(runner, 'runAutomation').mockResolvedValue({ sessionId: 1, success: true });

      fastScheduler.enqueue(blockerId, 'schedule');
      // The enqueue arms a 5-minute alert timer. We confirm it's cleared once
      // the eviction sweep empties the queue, NOT after 5 real minutes.
      expect(fastScheduler.hasPendingQueueAlertTimer()).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      await (fastScheduler as any).processQueue();

      expect(fastScheduler.getQueue()).toHaveLength(0);
      expect(fastScheduler.hasPendingQueueAlertTimer()).toBe(false);

      vi.useRealTimers();
      fastScheduler.stop();
    });

    it('does not tight-loop processQueue when nothing is runnable and nothing has timed out', async () => {
      // Regression test for PR #14 review (Copilot, 3360745376): the finally
      // block used to schedule setTimeout(processQueue, 0) whenever the
      // queue was non-empty. With the new iterating processQueue, an
      // all-blocked queue (e.g. every entry waiting for a device, none yet
      // past deadline) would re-fire immediately and spin.
      vi.useFakeTimers({ now: 1_000_000 });
      const fastScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 60_000,  // well past anything advanceTimersByTimeAsync hits
      });

      const blockerId = insertDeviceRequiringAutomation('Blocker');

      // No devices configured → blocker can't ever resolve.
      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      // Spy on global setTimeout so we can count immediate re-fires.
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      fastScheduler.enqueue(blockerId, 'schedule');
      // The enqueue call itself triggers one processQueue. Reset the spy
      // AFTER enqueue so we only measure post-enqueue setTimeout calls.
      // (enqueue uses setTimeout to arm the queue-health alert, plus the
      // initial processQueue call might also schedule. We're checking
      // that further processQueue() calls don't add MORE.)
      await vi.advanceTimersByTimeAsync(0);
      setTimeoutSpy.mockClear();

      // Now kick processQueue manually a few times — each should be a
      // no-op since nothing's runnable and nothing's past deadline.
      await (fastScheduler as any).processQueue();
      await (fastScheduler as any).processQueue();
      await (fastScheduler as any).processQueue();

      // No runner calls, no immediate re-fires queued.
      expect(mockRun).not.toHaveBeenCalled();
      // setTimeout from processQueue's finally is the one we care about.
      // The queue-health-alert timer was already armed before mockClear,
      // so any new setTimeout here would be the bug.
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
      fastScheduler.stop();
    });

    it('records queue timeout for an automation that was deleted while queued (no FK violation)', async () => {
      // Regression test for PR #14 review (Copilot, 3360745443):
      // automation_sessions.automation_id has a FK to automations.id; if
      // the row gets deleted while the entry sits in the queue, the
      // insert in recordQueueTimeout would fail with foreign_keys=ON and
      // the timeout would never get surfaced. Defensive fall back to a
      // null automationId in that case.
      vi.useFakeTimers({ now: 1_000_000 });
      const fastScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 100,
      });

      const blockerId = insertDeviceRequiringAutomation('AboutToBeDeleted');
      fastScheduler.enqueue(blockerId, 'schedule');

      // Delete the automation row while it's still queued.
      db.delete(schema.automations).where(eq(schema.automations.id, blockerId)).run();

      // Advance past deadline + trigger processQueue (in prod the 60s
      // checkInterval would do this).
      await vi.advanceTimersByTimeAsync(500);
      await (fastScheduler as any).processQueue();

      // The failed session row should have been written, with automationId
      // = null (because the automation was deleted) but the captured name
      // preserved.
      const sessions = db.select().from(schema.automationSessions).all();
      const failed = sessions.filter((s) => s.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].automationId).toBeNull();
      expect(failed[0].name).toMatch(/Automation #\d+/);
      expect(failed[0].logs ?? '').toMatch(/queue/i);

      vi.useRealTimers();
      fastScheduler.stop();
    });

    it('skips a managed automation whose owning plugin is not currently loaded', async () => {
      // Spec §7.1: scheduler must not fire managed automations for plugins
      // that aren't loaded (disabled / restarting). Without the guard, a
      // stop()'d plugin's rows would still execute and likely error out.
      const now = Date.now();
      db.insert(schema.automations).values({
        name: 'managed-poller',
        code: 'noop',
        passcode: 'p',
        requiresDevice: false,
        managedBy: 'plugin-x',
        managedKey: 'poller',
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }).run();
      const autoId = db.select().from(schema.automations).all().pop()!.id;

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({ sessionId: 1, success: true });

      const loaded = new Set<string>();  // empty — plugin not loaded
      const gatedScheduler = new AutomationScheduler(db, runner, undefined, {
        isPluginLoaded: (name) => loaded.has(name),
      });

      gatedScheduler.enqueue(autoId, 'schedule');
      await (gatedScheduler as any).processQueue();

      expect(mockRun).not.toHaveBeenCalled();
      expect(gatedScheduler.getQueue()).toHaveLength(1);
      gatedScheduler.stop();
    });

    it('runs the managed entry once its plugin loads back', async () => {
      // Plugin restart scenario: enqueue → plugin unloads → tick → plugin
      // reloads → tick → runs.
      const now = Date.now();
      db.insert(schema.automations).values({
        name: 'managed-poller',
        code: 'noop',
        passcode: 'p',
        requiresDevice: false,
        managedBy: 'plugin-x',
        managedKey: 'poller',
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }).run();
      const autoId = db.select().from(schema.automations).all().pop()!.id;

      const mockRun = vi.spyOn(runner, 'runAutomation').mockResolvedValue({ sessionId: 1, success: true });
      const loaded = new Set<string>();
      const gatedScheduler = new AutomationScheduler(db, runner, undefined, {
        isPluginLoaded: (name) => loaded.has(name),
      });

      gatedScheduler.enqueue(autoId, 'schedule');
      await (gatedScheduler as any).processQueue();
      expect(mockRun).not.toHaveBeenCalled();

      // Plugin loads.
      loaded.add('plugin-x');
      await (gatedScheduler as any).processQueue();
      expect(mockRun).toHaveBeenCalledWith(autoId, undefined, 'schedule');
      gatedScheduler.stop();
    });

    it('does NOT count plugin-unloaded time toward the deadline', async () => {
      // Plugin-unloaded entries should not be evicted as queue timeouts;
      // their clock effectively pauses while the plugin is unloaded.
      // Without this, a 6-minute plugin restart would generate spurious
      // "Queue timeout: managed plugin not loaded" failures for every
      // managed automation that was queued at the time.
      vi.useFakeTimers({ now: 1_000_000 });
      const now = new Date();
      db.insert(schema.automations).values({
        name: 'managed-poller',
        code: 'noop',
        passcode: 'p',
        requiresDevice: false,
        managedBy: 'plugin-x',
        managedKey: 'poller',
        createdAt: now,
        updatedAt: now,
      }).run();
      const autoId = db.select().from(schema.automations).all().pop()!.id;

      vi.spyOn(runner, 'runAutomation').mockResolvedValue({ sessionId: 1, success: true });
      const loaded = new Set<string>();   // plugin stays unloaded
      const gatedScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 100,
        isPluginLoaded: (name) => loaded.has(name),
      });

      gatedScheduler.enqueue(autoId, 'schedule');
      // Advance WAY past the 100ms deadline + kick processQueue several
      // times, mimicking a many-minute plugin outage.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(500);
        await (gatedScheduler as any).processQueue();
      }

      // Entry should still be queued — no queue-timeout failure logged.
      expect(gatedScheduler.getQueue()).toHaveLength(1);
      const sessions = db.select().from(schema.automationSessions).all();
      expect(sessions.filter((s) => s.status === 'failed')).toHaveLength(0);

      vi.useRealTimers();
      gatedScheduler.stop();
    });

    it('rolls queuedAt forward during plugin outage so waitingSeconds does not include outage time', async () => {
      // Regression for PR #16 third-pass review: the pause originally only
      // rolled deadlineAt, leaving queuedAt at the original enqueue moment.
      // getQueueStatus's `waitingSeconds` (and the later queue-timeout log)
      // would then include the entire plugin-outage period in the
      // operator-facing "waiting" figure — misleading, because the operator
      // wasn't really waiting for a device, the plugin was just away.
      vi.useFakeTimers({ now: 1_000_000 });
      const now = new Date();
      db.insert(schema.automations).values({
        name: 'managed-poller',
        code: 'noop',
        passcode: 'p',
        requiresDevice: false,
        managedBy: 'plugin-x',
        managedKey: 'poller',
        createdAt: now,
        updatedAt: now,
      }).run();
      const autoId = db.select().from(schema.automations).all().pop()!.id;

      vi.spyOn(runner, 'runAutomation').mockResolvedValue({ sessionId: 1, success: true });
      const loaded = new Set<string>();
      const gatedScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 60_000,
        isPluginLoaded: (name) => loaded.has(name),
      });

      gatedScheduler.enqueue(autoId, 'schedule');

      // Plugin out for "many minutes" — advance 10 minutes total in
      // bumps with processQueue calls between (the prod-equivalent of
      // the checkInterval firing).
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        await (gatedScheduler as any).processQueue();
      }

      // waitingSeconds should reflect only the *most recent* tick, not the
      // full outage. Within the last 60s, so under ~120.
      const status = gatedScheduler.getQueueStatus();
      expect(status.queue).toHaveLength(1);
      expect(status.queue[0].waitingSeconds).toBeLessThan(120);

      vi.useRealTimers();
      gatedScheduler.stop();
    });

    it('does NOT drop an entry whose deadline has not yet passed', async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const fastScheduler = new AutomationScheduler(db, runner, undefined, {
        maxQueueWaitMs: 60_000,
      });

      const blockerId = insertDeviceRequiringAutomation('Blocker');

      vi.spyOn(runner, 'runAutomation').mockResolvedValue({
        sessionId: 1, success: true,
      });

      fastScheduler.enqueue(blockerId, 'schedule');
      // Well under the 60s deadline
      await vi.advanceTimersByTimeAsync(500);

      // Entry stays in queue, no failure recorded
      expect(fastScheduler.getQueue()).toHaveLength(1);
      const sessions = db.select().from(schema.automationSessions).all();
      expect(sessions.filter((s) => s.status === 'failed')).toHaveLength(0);

      vi.useRealTimers();
      fastScheduler.stop();
    });
  });
});
