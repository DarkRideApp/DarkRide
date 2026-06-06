import { eq, and, isNotNull } from 'drizzle-orm';
import { automations, devices } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { AutomationRunner } from './automation-runner';
import type { DeviceManager } from './device-manager';
import { createLoggers } from '../logs';
import type { ScheduleConfig, DeviceFilter, TriggerType } from '../../shared/types/api';
import { matchesDeviceFilter, migrateDeviceFilter } from '../../shared/lib/device-filter';
import { matchesCrontab } from '@darkrideapp/plugin-sdk/utils';

const { log, error } = createLoggers('automation-scheduler');

const DEFAULT_MAX_QUEUE_WAIT_MS = 5 * 60_000;

interface QueueEntry {
  automationId: number;
  triggerType: TriggerType;
  queuedAt: Date;
  /**
   * When this entry should be dropped as "no device became available in time"
   * if it still can't run. Without this, an automation that requires a device
   * could sit at queue head forever when all devices are offline, blocking
   * every later (potentially deviceless) entry behind it. Incident 2026-06-05.
   */
  deadlineAt: Date;
}

export interface AutomationSchedulerOptions {
  /**
   * How long a queued entry waits for its preconditions (a matching available
   * device, etc.) before it's dropped and recorded as a failed automation
   * session. Default: 5 minutes. Note: the unrelated queueAlertTimer warning
   * log fires after a separate, hard-coded 5-minute window.
   */
  maxQueueWaitMs?: number;
  /**
   * Predicate the scheduler calls to check whether the plugin owning a
   * managed automation row is currently loaded. When false:
   *   - the entry is treated as not-runnable this tick (skip-and-try-next
   *     finds the next runnable entry instead), AND
   *   - the entry's deadline clock is paused (deadlineAt rolls forward by
   *     `maxQueueWaitMs` so a long plugin restart doesn't generate spurious
   *     queue-timeout failures).
   *
   * Wired to PluginManager.isPluginLoaded in production. When undefined,
   * the scheduler treats every plugin as loaded (legacy behaviour).
   */
  isPluginLoaded?: (pluginName: string) => boolean;
}

/**
 * Internal sentinel for "blocked because owning plugin isn't loaded".
 * processQueue() pauses the deadline clock for entries with this reason,
 * so a plugin restart doesn't generate spurious queue-timeout failures.
 * Exported only for tests that want to assert on the operator-facing
 * reason string from getQueueStatus().
 */
export const REASON_MANAGED_PLUGIN_NOT_LOADED = 'managed plugin not loaded';

export class AutomationScheduler {
  private schedules = new Map<number, ScheduleConfig>();
  private lastIntervalFired = new Map<number, Date>();
  private queue: QueueEntry[] = [];
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private queueAlertTimer: ReturnType<typeof setTimeout> | null = null;
  private processingQueue = false;
  private maxQueueWaitMs: number;
  private isPluginLoaded?: (pluginName: string) => boolean;

  constructor(
    private db: AppDatabase,
    private runner: AutomationRunner,
    private deviceManager?: DeviceManager,
    options: AutomationSchedulerOptions = {},
  ) {
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
    this.isPluginLoaded = options.isPluginLoaded;
  }

  /**
   * Wire the plugin-loaded predicate after construction. Useful because the
   * scheduler is constructed at module load (before pluginManager exists),
   * but managed-automation gating needs to consult pluginManager. Boot calls
   * this once pluginManager is ready, before scheduler.start().
   */
  setIsPluginLoaded(check: (pluginName: string) => boolean): void {
    this.isPluginLoaded = check;
  }

  start(): void {
    this.loadSchedules();
    // Check every minute
    this.checkInterval = setInterval(() => {
      this.checkSchedules();
      this.processQueue();
    }, 60_000);
    log('Scheduler started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.queueAlertTimer) {
      clearTimeout(this.queueAlertTimer);
      this.queueAlertTimer = null;
    }
    log('Scheduler stopped');
  }

  loadSchedules(): void {
    const rows = this.db
      .select()
      .from(automations)
      .where(and(isNotNull(automations.schedule), eq(automations.enabled, true)))
      .all();

    this.schedules.clear();
    this.lastIntervalFired.clear();

    const now = new Date();
    for (const row of rows) {
      if (!row.schedule) continue;
      try {
        const config = JSON.parse(row.schedule) as ScheduleConfig;
        this.schedules.set(row.id, config);
        if (config.type === 'interval' || config.type === 'windowed_interval') {
          // Init to now to prevent burst-on-restart
          this.lastIntervalFired.set(row.id, now);
        }
      } catch {
        error(`Invalid schedule JSON for automation ${row.id}`);
      }
    }

    log(`Loaded ${this.schedules.size} schedules from DB`);
  }

  setSchedule(automationId: number, config: ScheduleConfig): void {
    // Persist to DB
    this.db
      .update(automations)
      .set({ schedule: JSON.stringify(config) })
      .where(eq(automations.id, automationId))
      .run();

    // Update in-memory
    this.schedules.set(automationId, config);
    if (config.type === 'interval' || config.type === 'windowed_interval') {
      this.lastIntervalFired.set(automationId, new Date());
    } else {
      this.lastIntervalFired.delete(automationId);
    }

    log(`Schedule set for automation ${automationId}: ${JSON.stringify(config)}`);
  }

  removeSchedule(automationId: number): void {
    // Clear in DB
    this.db
      .update(automations)
      .set({ schedule: null })
      .where(eq(automations.id, automationId))
      .run();

    // Clear in-memory
    this.schedules.delete(automationId);
    this.lastIntervalFired.delete(automationId);

    log(`Schedule removed for automation ${automationId}`);
  }

  getSchedule(automationId: number): ScheduleConfig | null {
    return this.schedules.get(automationId) ?? null;
  }

  getSchedules(): Map<number, ScheduleConfig> {
    return this.schedules;
  }

  enqueue(automationId: number, triggerType: TriggerType = 'schedule'): boolean {
    // Skip duplicate queued entries
    if (this.queue.some((q) => q.automationId === automationId)) {
      log(`Automation ${automationId} already in queue, skipping`);
      return false;
    }

    const queuedAt = new Date();
    const deadlineAt = new Date(queuedAt.getTime() + this.maxQueueWaitMs);
    this.queue.push({ automationId, triggerType, queuedAt, deadlineAt });
    log(`Automation ${automationId} added to queue (trigger: ${triggerType})`);

    // Start queue health alert timer if not already running
    if (!this.queueAlertTimer && this.queue.length > 0) {
      this.queueAlertTimer = setTimeout(() => {
        if (this.queue.length > 0) {
          error(`Queue health alert: ${this.queue.length} items pending for 5+ minutes`);
        }
        this.queueAlertTimer = null;
      }, 5 * 60_000);
    }

    // Process immediately instead of waiting for next interval tick
    this.processQueue();

    return true;
  }

  getQueue(): QueueEntry[] {
    return [...this.queue];
  }

  getQueueStatus(): {
    queue: Array<{
      automationId: number;
      automationName: string | null;
      triggerType: TriggerType;
      queuedAt: Date;
      waitingSeconds: number;
      reason: string | null;
    }>;
    processingQueue: boolean;
    devices: Array<{
      id: string;
      online: boolean;
      busy: boolean;
    }>;
  } {
    const now = Date.now();
    const allDevices = this.db.select().from(devices).all();

    const deviceStatuses = allDevices.map((d) => ({
      id: d.id,
      online: this.deviceManager?.isOnline(d.id) ?? true,
      busy: this.deviceManager?.isBusy(d.id) ?? false,
    }));

    const queueDetails = this.queue.map((entry) => {
      const auto = this.db.select().from(automations).where(eq(automations.id, entry.automationId)).all()[0];

      // Determine why the entry can't run. tryResolveEntry is the same logic
      // processQueue() uses to pick the next runnable item, so the operator-
      // visible reason here matches what the scheduler is actually checking.
      let reason: string | null = null;
      if (this.processingQueue) {
        reason = 'waiting for current automation to finish';
      } else {
        const resolved = this.tryResolveEntry(entry);
        if (!resolved.ok) reason = resolved.reason;
      }

      return {
        automationId: entry.automationId,
        automationName: auto?.name ?? null,
        triggerType: entry.triggerType,
        queuedAt: entry.queuedAt,
        waitingSeconds: Math.round((now - entry.queuedAt.getTime()) / 1000),
        reason,
      };
    });

    return {
      queue: queueDetails,
      processingQueue: this.processingQueue,
      devices: deviceStatuses,
    };
  }

  /**
   * Test seam: returns true when a queue-health-alert timer is pending.
   * Used by tests to verify the timer is cleared when the queue drains via
   * either successful execution OR deadline-eviction.
   */
  hasPendingQueueAlertTimer(): boolean {
    return this.queueAlertTimer !== null;
  }

  clearQueue(): number {
    const count = this.queue.length;
    this.queue.length = 0;
    if (this.queueAlertTimer) {
      clearTimeout(this.queueAlertTimer);
      this.queueAlertTimer = null;
    }
    if (count > 0) {
      log(`Queue cleared (${count} item(s) removed)`);
    }
    return count;
  }

  private checkSchedules(now = new Date()): void {

    for (const [automationId, config] of this.schedules) {
      // Re-check enabled status in case it was toggled since loadSchedules()
      const row = this.db.select({ enabled: automations.enabled }).from(automations).where(eq(automations.id, automationId)).all()[0];
      if (!row || !row.enabled) {
        this.schedules.delete(automationId);
        this.lastIntervalFired.delete(automationId);
        continue;
      }
      if (config.type === 'cron') {
        for (const expression of config.expressions) {
          if (this.matchesCrontab(expression, now)) {
            log(`Cron schedule triggered for automation ${automationId}`);
            this.enqueue(automationId, 'schedule');
            break; // Only enqueue once even if multiple expressions match
          }
        }
      } else if (config.type === 'interval') {
        const lastFired = this.lastIntervalFired.get(automationId);
        const elapsed = lastFired ? now.getTime() - lastFired.getTime() : Infinity;
        if (elapsed >= config.intervalMs) {
          log(`Interval schedule triggered for automation ${automationId}`);
          this.lastIntervalFired.set(automationId, now);
          this.enqueue(automationId, 'schedule');
        }
      } else if (config.type === 'windowed_interval') {
        if (!this.isInWindow(config.windowStart, config.windowEnd, now)) continue;
        const lastFired = this.lastIntervalFired.get(automationId);
        const elapsed = lastFired ? now.getTime() - lastFired.getTime() : Infinity;
        if (elapsed >= config.intervalMinutes * 60_000) {
          log(`Windowed interval triggered for automation ${automationId}`);
          this.lastIntervalFired.set(automationId, now);
          this.enqueue(automationId, 'schedule');
        }
      }
    }
  }

  /**
   * Returns true if the current time falls within the [windowStart, windowEnd] window.
   * If windowEnd is earlier than windowStart (in minutes-since-midnight), the window
   * is treated as crossing midnight: active from windowStart until end-of-day AND from
   * start-of-day until windowEnd.
   */
  isInWindow(windowStart: string, windowEnd: string, now: Date): boolean {
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = windowStart.split(':').map(Number);
    const [endH, endM] = windowEnd.split(':').map(Number);
    const startMins = startH * 60 + startM;
    const endMins = endH * 60 + endM;
    if (endMins < startMins) {
      // Wraps midnight: active if nowMins is on the "start" side or the "end" side
      return nowMins >= startMins || nowMins <= endMins;
    }
    return nowMins >= startMins && nowMins <= endMins;
  }

  /**
   * Decide whether a queued entry can run right now. On success returns
   * `{ ok: true, deviceForRun }` where `deviceForRun` is the device id to run
   * against, or `undefined` when the automation is configured as deviceless.
   * On failure returns `{ ok: false, reason }` with a human-readable reason
   * (e.g. "all devices offline", "automation no longer exists"). Shared
   * between processQueue() (which acts on it) and getQueueStatus() (which
   * surfaces it to the operator) so they always agree.
   */
  private tryResolveEntry(
    entry: QueueEntry,
  ): { ok: true; deviceForRun: string | undefined } | { ok: false; reason: string } {
    const automation = this.db
      .select({
        requiresDevice: automations.requiresDevice,
        managedBy: automations.managedBy,
      })
      .from(automations)
      .where(eq(automations.id, entry.automationId))
      .all()[0];

    if (!automation) {
      return { ok: false, reason: 'automation no longer exists' };
    }
    // Managed-automations guard: if the owning plugin isn't currently loaded,
    // don't fire its rows. processQueue() pauses the deadline clock for this
    // specific reason so a plugin restart doesn't generate spurious queue-
    // timeout failures.
    if (automation.managedBy && this.isPluginLoaded && !this.isPluginLoaded(automation.managedBy)) {
      return { ok: false, reason: REASON_MANAGED_PLUGIN_NOT_LOADED };
    }
    if (automation.requiresDevice === false) {
      return { ok: true, deviceForRun: undefined };
    }

    const availableDevice = this.findAvailableDevice(entry.automationId);
    if (availableDevice) {
      return { ok: true, deviceForRun: availableDevice };
    }

    // No device — diagnose why so the operator sees something useful.
    const allDevices = this.db.select().from(devices).all();
    if (allDevices.length === 0) return { ok: false, reason: 'no devices configured' };
    if (this.deviceManager) {
      const onlineCount = allDevices.filter((d) => this.deviceManager!.isOnline(d.id)).length;
      const busyCount = allDevices.filter(
        (d) => this.deviceManager!.isOnline(d.id) && this.deviceManager!.isBusy(d.id),
      ).length;
      if (onlineCount === 0) return { ok: false, reason: 'all devices offline' };
      if (busyCount === onlineCount) return { ok: false, reason: 'all online devices busy' };
    }
    return { ok: false, reason: 'no device matches filter' };
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    // Guard against concurrent processQueue() calls (async gap between
    // findAvailableDevice check and runAutomation's tryAcquireBusy)
    if (this.processingQueue) return;
    this.processingQueue = true;
    // Tracks whether this pass actually made forward progress (ran an
    // automation or evicted a timed-out entry). Only when something
    // changed do we re-fire processQueue immediately to drain a backlog
    // — otherwise the 60s checkInterval is the right cadence to retry,
    // and a setTimeout(..., 0) chain on a fully-blocked queue would just
    // burn CPU.
    let madeProgress = false;

    try {
      const now = new Date();

      // 1. Drop any entries past their deadline that still can't run, and
      // record them as failed sessions so the operator sees them in the
      // normal automation history rather than just buried in a log line.
      const survivors: QueueEntry[] = [];
      for (const entry of this.queue) {
        const resolved = this.tryResolveEntry(entry);
        if (resolved.ok || now.getTime() < entry.deadlineAt.getTime()) {
          survivors.push(entry);
          continue;
        }
        // Pause the deadline clock for managed entries whose owning plugin
        // is currently unloaded. A plugin restart or temporary disable
        // shouldn't show up as a wave of "Queue timeout" failures for
        // every queued managed automation — the operator didn't ask for
        // those runs to time out, the plugin just happens to be away.
        // Roll BOTH the deadline AND `queuedAt` forward so the entry
        // effectively starts fresh whenever the plugin's back. Rolling
        // queuedAt too keeps `waitingSeconds` (in getQueueStatus) and the
        // eventual queue-timeout log message reflecting only the real
        // waiting period — i.e. time the entry has actually been
        // resolvable-but-not-runnable, not plugin-outage time the
        // operator can't act on.
        if (resolved.reason === REASON_MANAGED_PLUGIN_NOT_LOADED) {
          entry.queuedAt = now;
          entry.deadlineAt = new Date(now.getTime() + this.maxQueueWaitMs);
          survivors.push(entry);
          continue;
        }
        const waitedSeconds = Math.round((now.getTime() - entry.queuedAt.getTime()) / 1000);
        const errorMsg = `Queue timeout after ${waitedSeconds}s: ${resolved.reason}`;
        log(`Dropping automation ${entry.automationId} from queue — ${errorMsg}`);
        try {
          this.runner.recordQueueTimeout(entry.automationId, entry.triggerType, errorMsg);
        } catch (err: any) {
          error(`Failed to record queue timeout for automation ${entry.automationId}: ${err.message}`);
        }
        madeProgress = true;
      }
      this.queue = survivors;

      // If the deadline sweep just emptied the queue, clear the alert timer
      // here so it doesn't fire a false "Queue health alert" minutes later.
      // The other site for this is after the runnable splice below, which only
      // covers the "executed something" exit; this covers "evicted everything".
      if (this.queue.length === 0 && this.queueAlertTimer) {
        clearTimeout(this.queueAlertTimer);
        this.queueAlertTimer = null;
      }

      // 2. Find the first entry that can run right now. Skip-and-try-next
      // instead of FIFO blocking, so a head entry waiting for a device
      // doesn't park every later entry behind it.
      let runnableIdx = -1;
      let deviceForRun: string | undefined;
      for (let i = 0; i < this.queue.length; i++) {
        const resolved = this.tryResolveEntry(this.queue[i]);
        if (resolved.ok) {
          runnableIdx = i;
          deviceForRun = resolved.deviceForRun;
          break;
        }
      }
      if (runnableIdx === -1) return;

      const [entry] = this.queue.splice(runnableIdx, 1);
      madeProgress = true;

      // Clear alert timer if queue is empty
      if (this.queue.length === 0 && this.queueAlertTimer) {
        clearTimeout(this.queueAlertTimer);
        this.queueAlertTimer = null;
      }

      try {
        await this.runner.runAutomation(
          entry.automationId,
          deviceForRun,
          entry.triggerType,
        );
      } catch (err: any) {
        error(`Failed to run queued automation ${entry.automationId}: ${err.message}`);
      }
    } finally {
      this.processingQueue = false;
      // Immediately drain the next item only if THIS pass actually did
      // something (executed a runnable entry, or evicted a timed-out
      // one). If the queue is non-empty but nothing was runnable AND
      // nothing was past deadline, no state has changed since the call
      // that just finished — re-firing setTimeout(..., 0) would just
      // spin. Wait for the 60s checkInterval (or the next enqueue) to
      // try again.
      if (madeProgress && this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 0);
      }
    }
  }

  private findAvailableDevice(automationId: number): string | null {
    // Parse device filter from the automation row
    let deviceFilter: DeviceFilter | undefined;
    const row = this.db.select().from(automations).where(eq(automations.id, automationId)).all()[0];
    if (row?.deviceFilter) {
      try {
        const raw = JSON.parse(row.deviceFilter);
        deviceFilter = migrateDeviceFilter(raw);
      } catch {
        // Invalid JSON, ignore filter
      }
    }

    const allDevices = this.db.select().from(devices).all();
    if (allDevices.length === 0) return null;

    // Prefer an online, non-busy device matching filter
    if (this.deviceManager) {
      for (const device of allDevices) {
        if (!this.deviceManager.isOnline(device.id)) continue;
        if (this.deviceManager.isBusy(device.id)) continue;
        if (deviceFilter && !matchesDeviceFilter(device, deviceFilter)) continue;
        return device.id;
      }
      // No available device found
      return null;
    }

    // Fallback if no DeviceManager (tests) — still apply filter
    if (deviceFilter) {
      const match = allDevices.find(d => matchesDeviceFilter(d, deviceFilter!));
      return match?.id ?? null;
    }
    return allDevices[0].id;
  }

  /**
   * Parse and match a crontab expression against a date.
   * Delegates to shared cron utility.
   */
  matchesCrontab(expression: string, date: Date): boolean {
    return matchesCrontab(expression, date);
  }
}
