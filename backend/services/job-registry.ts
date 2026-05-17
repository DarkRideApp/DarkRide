import { eq } from 'drizzle-orm';
import { jobConfig } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('job-registry');

export interface JobDefinition {
  id: string;
  name: string;
  description: string;
  category: 'maintenance' | 'sync' | 'analysis';
  /** Default schedule (cron expression or human-readable interval) */
  defaultSchedule: string;
  canRunManually: boolean;
  /** Run the job immediately. */
  run?: () => Promise<void>;
  /** Get the last run timestamp (epoch ms) */
  getLastRunAt?: () => number | null;
}

interface RegisteredJob extends JobDefinition {
  lastRunAt: number | null;
  lastError: string | null;
  running: boolean;
}

export class JobRegistry {
  private jobs = new Map<string, RegisteredJob>();
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private db: AppDatabase) {}

  register(def: JobDefinition): void {
    // Ensure DB row exists with defaults; capture persisted run history.
    let existing = this.db.select().from(jobConfig).where(eq(jobConfig.jobId, def.id)).all()[0];
    if (!existing) {
      this.db.insert(jobConfig).values({
        jobId: def.id,
        enabled: true,
        schedule: def.defaultSchedule,
        updatedAt: new Date(),
      }).run();
      existing = this.db.select().from(jobConfig).where(eq(jobConfig.jobId, def.id)).all()[0];
    }

    this.jobs.set(def.id, {
      ...def,
      lastRunAt: existing?.lastRunAt ?? null,
      lastError: existing?.lastError ?? null,
      running: false,
    });

    log(`Registered job: ${def.id} (${def.name})`);
  }

  /** Start the cron scheduler — checks every 60s which jobs need to run. */
  start(): void {
    if (this.schedulerTimer) return;
    log('Job scheduler started');
    this.schedulerTimer = setInterval(() => this.tick(), 60_000);
  }

  stop(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private tick(): void {
    const now = new Date();
    for (const [id, job] of this.jobs) {
      if (job.running) continue;

      const config = this.getConfig(id);
      if (!config.enabled) continue;

      const schedule = config.schedule || job.defaultSchedule;
      if (this.shouldRun(schedule, now, job.lastRunAt)) {
        this.runJob(id).catch(() => {});
      }
    }
  }

  /** Check if a schedule matches the current time. */
  private shouldRun(schedule: string, now: Date, lastRunAt: number | null): boolean {
    // Try cron expression (5-field: min hour dom month dow)
    if (/^[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+$/.test(schedule.trim())) {
      return this.matchesCron(schedule.trim(), now);
    }

    // Try interval pattern: "Every Xm", "Every Xh", "Every Xs"
    const intervalMatch = schedule.match(/every\s+(\d+)\s*(s|m|h|min|sec|hour|minutes?|hours?|seconds?)/i);
    if (intervalMatch) {
      const value = parseInt(intervalMatch[1]);
      const unit = intervalMatch[2].toLowerCase();
      let intervalMs: number;
      if (unit.startsWith('s')) intervalMs = value * 1000;
      else if (unit.startsWith('m')) intervalMs = value * 60_000;
      else intervalMs = value * 3600_000;

      if (!lastRunAt) return true;
      return Date.now() - lastRunAt >= intervalMs;
    }

    // "Daily at 3 AM" pattern
    const dailyMatch = schedule.match(/daily\s+at\s+(\d+)\s*(AM|PM)?/i);
    if (dailyMatch) {
      let hour = parseInt(dailyMatch[1]);
      if (dailyMatch[2]?.toUpperCase() === 'PM' && hour < 12) hour += 12;
      return now.getHours() === hour && now.getMinutes() === 0;
    }

    return false;
  }

  private matchesCron(cron: string, now: Date): boolean {
    const [minF, hourF, domF, monF, dowF] = cron.split(/\s+/);
    return this.matchField(minF, now.getMinutes(), 0, 59)
      && this.matchField(hourF, now.getHours(), 0, 23)
      && this.matchField(domF, now.getDate(), 1, 31)
      && this.matchField(monF, now.getMonth() + 1, 1, 12)
      && this.matchField(dowF, now.getDay(), 0, 6);
  }

  private matchField(field: string, value: number, _min: number, _max: number): boolean {
    for (const part of field.split(',')) {
      // Step: */n or range/n
      const [range, stepStr] = part.split('/');
      const step = stepStr ? parseInt(stepStr) : 1;

      if (range === '*') {
        if (value % step === 0) return true;
        continue;
      }

      // Range: a-b
      const rangeMatch = range.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1]);
        const hi = parseInt(rangeMatch[2]);
        if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
        continue;
      }

      // Exact value
      if (parseInt(range) === value) return true;
    }
    return false;
  }

  // --- Config ---

  getConfig(jobId: string): { enabled: boolean; schedule: string | null } {
    const row = this.db.select().from(jobConfig).where(eq(jobConfig.jobId, jobId)).all()[0];
    return {
      enabled: row?.enabled !== false,
      schedule: row?.schedule || null,
    };
  }

  updateConfig(jobId: string, updates: { enabled?: boolean; schedule?: string }): void {
    const existing = this.db.select().from(jobConfig).where(eq(jobConfig.jobId, jobId)).all()[0];
    if (existing) {
      this.db.update(jobConfig).set({
        ...updates,
        updatedAt: new Date(),
      }).where(eq(jobConfig.jobId, jobId)).run();
    } else {
      this.db.insert(jobConfig).values({
        jobId,
        enabled: updates.enabled ?? true,
        schedule: updates.schedule || null,
        updatedAt: new Date(),
      }).run();
    }
  }

  isEnabled(jobId: string): boolean {
    return this.getConfig(jobId).enabled;
  }

  // --- List & run ---

  getAll(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    schedule: string;
    defaultSchedule: string;
    canRunManually: boolean;
    enabled: boolean;
    lastRunAt: number | null;
    lastError: string | null;
    status: string;
  }> {
    return Array.from(this.jobs.values()).map(job => {
      const config = this.getConfig(job.id);
      return {
        id: job.id,
        name: job.name,
        description: job.description,
        category: job.category,
        schedule: config.schedule || job.defaultSchedule,
        defaultSchedule: job.defaultSchedule,
        canRunManually: job.canRunManually,
        enabled: config.enabled,
        lastRunAt: job.getLastRunAt?.() ?? job.lastRunAt,
        lastError: job.lastError,
        status: job.running ? 'running' : 'idle',
      };
    });
  }

  async runJob(id: string): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job) return { success: false, error: 'Job not found' };
    if (!job.run) return { success: false, error: 'Job has no run function' };
    if (job.running) return { success: false, error: 'Job is already running' };

    const config = this.getConfig(id);
    if (!config.enabled) return { success: false, error: 'Job is disabled' };

    job.running = true;
    job.lastError = null;
    log(`Running job: ${job.id}`);

    try {
      await job.run();
      job.lastRunAt = Date.now();
      job.lastError = null;
      this.persistRunResult(job.id, job.lastRunAt, null);
      log(`Job completed: ${job.id}`);
      return { success: true };
    } catch (err: any) {
      job.lastError = err.message || 'Unknown error';
      job.lastRunAt = Date.now();
      this.persistRunResult(job.id, job.lastRunAt, job.lastError);
      logError(`Job failed: ${job.id} — ${job.lastError}`);
      return { success: false, error: job.lastError! };
    } finally {
      job.running = false;
    }
  }

  private persistRunResult(jobId: string, lastRunAt: number, lastError: string | null): void {
    this.db.update(jobConfig)
      .set({ lastRunAt, lastError, updatedAt: new Date() })
      .where(eq(jobConfig.jobId, jobId))
      .run();
  }
}
