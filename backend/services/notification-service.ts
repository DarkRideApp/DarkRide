import { eq, lt, desc } from 'drizzle-orm';
import { notificationChannels, notificationHistory, notificationQueue, settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';
import * as nodemailer from 'nodemailer';
import type { NotificationService as INotificationService } from '@darkrideapp/plugin-sdk';

const { log, error: logError } = createLoggers('notifications');

// Core event types (plugins register their own via ctx.notificationEvents())
export const CORE_NOTIFICATION_EVENTS: Array<{ type: string; label: string; description: string; critical?: boolean }> = [
  { type: 'automation:success', label: 'Automation success', description: 'When an automation completes successfully' },
  { type: 'automation:failure', label: 'Automation failure', description: 'When an automation fails', critical: true },
  { type: 'apk:new-version', label: 'New APK downloaded', description: 'When a new app version is pulled from device or Play Store' },
  { type: 'apk:analysis-complete', label: 'APK analysis complete', description: 'When APK analysis finishes' },
  { type: 'apk:diff-complete', label: 'APK diff complete', description: 'When APK version diff finishes' },
  { type: 'device:disconnected', label: 'Device disconnected', description: 'When a USB device is lost', critical: true },
  { type: 'capture:error', label: 'Capture error', description: 'When traffic capture encounters an error', critical: true },
  { type: 'system:disk-space-low', label: 'Low disk space', description: 'When free disk space drops below threshold (default 10%)', critical: true },
  { type: 'api:regression', label: 'API regression detected', description: 'When an API endpoint returns a different status code or response structure than previously observed' },
];

export const NOTIFICATION_EVENT_TYPES = CORE_NOTIFICATION_EVENTS.map(e => e.type);
export type NotificationEventType = string;
export const CRITICAL_EVENT_TYPES = CORE_NOTIFICATION_EVENTS.filter(e => e.critical).map(e => e.type);

// Mutable copies for plugin extensions
const allEventTypes = new Set<string>(NOTIFICATION_EVENT_TYPES);
const allCriticalTypes = new Set<string>(CRITICAL_EVENT_TYPES);
const allEventsWithLabels: Array<{ type: string; label: string; description?: string; critical?: boolean }> = [...CORE_NOTIFICATION_EVENTS];

/** Register additional notification event types from plugins */
export function registerPluginNotificationEvents(
  events: Array<{ type: string; label?: string; description?: string; critical?: boolean }>,
): void {
  for (const event of events) {
    allEventTypes.add(event.type);
    if (event.critical) allCriticalTypes.add(event.type);
    allEventsWithLabels.push({
      type: event.type,
      label: event.label || event.type,
      description: event.description,
      critical: event.critical,
    });
  }
}

export function getAllNotificationEventTypes(): Array<{ type: string; label: string; description?: string; critical?: boolean }> {
  return allEventsWithLabels;
}

/** Check if an event type is valid (core or plugin) */
export function isValidEventType(type: string): boolean {
  return allEventTypes.has(type);
}

export interface QuietHoursConfig {
  enabled: boolean;
  startTime: string;  // "HH:MM" (24-hour)
  endTime: string;    // "HH:MM" (24-hour)
  timezone: string;   // IANA timezone, e.g. "America/New_York"
  daysOfWeek: number[]; // 0=Sunday, 1=Monday, ..., 6=Saturday
}

export interface NotificationEvent {
  type: NotificationEventType;
  title: string;
  body: string;
  sourceType?: string;
  sourceId?: string;
  /** Deep link path within the UI, e.g. /ui/automations/session/42 */
  url?: string;
}

export interface ChannelConfig {
  // Discord
  url?: string;
  // Slack
  // url (same field)
  // Telegram
  botToken?: string;
  chatId?: string;
  // Webhook / ntfy / gotify
  // url (same field)
  headers?: Record<string, string>;
  // ntfy helpers
  topic?: string;
  // gotify helpers
  appToken?: string;
  // Email (SMTP)
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  fromAddress?: string;
  toAddresses?: string;
}

interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  config: ChannelConfig;
  enabled: boolean;
  events: string[];
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000]; // exponential-ish backoff

export class NotificationService implements INotificationService {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private db: AppDatabase) {
    // Flush any events queued before a restart
    this.scheduleFlush();
  }

  /** Resolve a UI path (e.g. /ui/apks) to a full clickable URL.
   *
   * As of 2026-05-13 the canonical "where is this server publicly reachable"
   * setting is `oauth_public_base_url` (shown + edited on the MCP Server
   * settings page — same value also drives OAuth callback URLs and the MCP
   * server URL display, so it's the right one). Legacy installs may still
   * carry `notification_base_url`; fall back to it if the canonical key is
   * empty so existing deployments keep working without a manual migration.
   */
  private resolveUrl(path?: string): string | undefined {
    if (!path) return undefined;
    const canonical = this.db.select().from(settings).where(eq(settings.key, 'oauth_public_base_url')).all()[0];
    const legacy = this.db.select().from(settings).where(eq(settings.key, 'notification_base_url')).all()[0];
    const base = canonical?.value
      || legacy?.value
      || `http://localhost:${process.env.PORT || '3000'}`;
    return `${base.replace(/\/$/, '')}${path}`;
  }

  /**
   * Emit a notification event (fire-and-forget). Dispatches to all enabled channels
   * subscribed to this event type. Notification delivery happens asynchronously in the
   * background — this method returns immediately and never rejects.
   * Non-critical events are queued during quiet hours and flushed when quiet hours end.
   */
  emit(event: NotificationEvent): void {
    // Check quiet hours — critical events always get through
    if (!allCriticalTypes.has(event.type) && this.isInQuietHours()) {
      // Skip queueing entirely if no enabled channel subscribes to this event
      // type — when quiet hours end, dispatchEvent would silently drop it
      // anyway, and the queue UI shouldn't show events that won't fire.
      if (this.getSubscribedChannels(event.type).length === 0) {
        return;
      }
      try {
        // Dedup: collapse repeated events from the same source into a single
        // queued row (newest payload wins). Without this an APK analysis that
        // fails every boot during quiet hours grows the queue unbounded.
        // Bare events (no sourceType/sourceId) bypass dedup and insert as-is.
        const now = new Date();
        let deduped = false;
        if (event.sourceType && event.sourceId) {
          const existingRows = this.db
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.eventType, event.type))
            .all();
          for (const row of existingRows) {
            let parsed: NotificationEvent | null = null;
            try { parsed = JSON.parse(row.payload); } catch { parsed = null; }
            if (parsed?.sourceType === event.sourceType && parsed?.sourceId === event.sourceId) {
              this.db.update(notificationQueue)
                .set({ payload: JSON.stringify(event), createdAt: now })
                .where(eq(notificationQueue.id, row.id))
                .run();
              deduped = true;
              break;
            }
          }
        }
        if (!deduped) {
          this.db.insert(notificationQueue).values({
            eventType: event.type,
            payload: JSON.stringify(event),
            createdAt: now,
          }).run();
        }
      } catch (err: any) {
        logError(`Failed to queue notification: ${err.message}`);
        return;
      }
      const count = this.db.select({ id: notificationQueue.id }).from(notificationQueue).all().length;
      log(`Queued "${event.type}" during quiet hours (${count} queued): ${event.title}`);
      this.scheduleFlush();
      return;
    }

    this.dispatchEvent(event);
  }

  /**
   * Dispatch an event to all subscribed channels immediately, bypassing
   * quiet-hours queueing. Used by:
   *  - emit() once it's confirmed the event isn't in quiet hours
   *  - flushQueue() draining the queue when quiet hours end
   *  - the queue API (manual "send now" from the UI)
   */
  private dispatchEvent(event: NotificationEvent): void {
    const channels = this.getSubscribedChannels(event.type);
    if (channels.length === 0) return;

    log(`Dispatching "${event.type}" to ${channels.length} channel(s): ${event.title}`);

    // Fire all dispatches concurrently — don't block the caller
    const promises = channels.map(async (channel) => {
      let success = false;
      let lastError = '';

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await this.dispatch(channel, event);
          success = true;
          break;
        } catch (err: any) {
          lastError = err.message || 'Unknown error';
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          }
        }
      }

      // Log to history
      try {
        this.db.insert(notificationHistory).values({
          channelId: channel.id,
          channelName: channel.name,
          eventType: event.type,
          title: event.title,
          body: event.body || null,
          sourceType: event.sourceType || null,
          sourceId: event.sourceId || null,
          success,
          error: success ? null : lastError,
          createdAt: new Date(),
        }).run();
      } catch (err: any) {
        logError(`Failed to log notification history: ${err.message}`);
      }

      if (!success) {
        logError(`Failed to send "${event.type}" to channel "${channel.name}" after ${MAX_RETRIES} attempts: ${lastError}`);
      }
    });

    // Don't await — fire and forget so we don't block event sources
    Promise.all(promises).catch(() => {});
  }

  /**
   * Schedule a timer to flush the queue when quiet hours end.
   * Only one timer is active at a time; re-calling is a no-op if already scheduled.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return; // already scheduled

    const queueCount = this.db.select({ id: notificationQueue.id }).from(notificationQueue).all().length;
    if (queueCount === 0) return; // nothing to flush

    if (!this.isInQuietHours()) {
      // Quiet hours already over (startup recovery or race) — flush now
      this.flushQueue();
      return;
    }

    const ms = this.msUntilQuietHoursEnd();
    // Cap at 60 minutes — we'll re-check and reschedule if still in quiet hours
    const delay = Math.min(ms + 1000, 60 * 60 * 1000);
    log(`Quiet hours flush scheduled in ${Math.round(delay / 1000)}s (${queueCount} queued)`);

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;

      if (this.isInQuietHours()) {
        // Still in quiet hours (config changed, or cap kicked in) — reschedule
        this.scheduleFlush();
        return;
      }

      this.flushQueue();
    }, delay);
  }

  /** Dispatch all queued events from the database. Called when quiet hours end. */
  private flushQueue(): void {
    const rows = this.db.select().from(notificationQueue).all();
    if (rows.length === 0) return;

    // Delete all rows first to avoid re-processing on crash
    this.db.delete(notificationQueue).run();

    log(`Flushing ${rows.length} queued notification(s) after quiet hours`);

    for (const row of rows) {
      try {
        const event: NotificationEvent = JSON.parse(row.payload);
        // Bypass quiet-hours check: we're called precisely BECAUSE quiet
        // hours ended (or via sendAllQueued at user request). Routing back
        // through emit() would re-queue the event we just dequeued.
        this.dispatchEvent(event);
      } catch (err: any) {
        logError(`Failed to parse queued notification ${row.id}: ${err.message}`);
      }
    }
  }

  /**
   * Calculate milliseconds until quiet hours end. Returns 0 if not currently
   * in quiet hours.
   */
  private msUntilQuietHoursEnd(): number {
    const config = this.getQuietHoursConfig();
    if (!config?.enabled) return 0;

    const now = new Date();
    let localHours: number;
    let localMinutes: number;

    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone,
        hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
      });
      const parts = formatter.formatToParts(now);
      localHours = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
      localMinutes = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    } catch {
      localHours = now.getUTCHours();
      localMinutes = now.getUTCMinutes();
    }

    const [endH, endM] = config.endTime.split(':').map(Number);
    const nowMins = localHours * 60 + localMinutes;
    const endMins = endH * 60 + endM;

    let minsUntilEnd: number;
    if (nowMins < endMins) {
      minsUntilEnd = endMins - nowMins;
    } else {
      // End time is tomorrow (midnight wrap)
      minsUntilEnd = (24 * 60 - nowMins) + endMins;
    }

    return minsUntilEnd * 60 * 1000;
  }

  private getSubscribedChannels(eventType: NotificationEventType): NotificationChannel[] {
    const rows = this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.enabled, true))
      .all();

    return rows
      .map(row => ({
        id: row.id,
        name: row.name,
        type: row.type,
        config: JSON.parse(row.config) as ChannelConfig,
        enabled: row.enabled !== false,
        events: JSON.parse(row.events) as string[],
      }))
      .filter(ch => ch.events.includes(eventType));
  }

  private async dispatch(channel: NotificationChannel, event: NotificationEvent): Promise<void> {
    switch (channel.type) {
      case 'discord':
        return this.sendDiscord(channel.config, event);
      case 'slack':
        return this.sendSlack(channel.config, event);
      case 'telegram':
        return this.sendTelegram(channel.config, event);
      case 'email':
        return this.sendEmail(channel.config, event);
      case 'webhook':
      case 'ntfy':
      case 'gotify':
        return this.sendWebhook(channel, event);
      default:
        throw new Error(`Unknown channel type: ${channel.type}`);
    }
  }

  private async sendDiscord(config: ChannelConfig, event: NotificationEvent): Promise<void> {
    if (!config.url) throw new Error('Discord webhook URL not configured');

    const isError = event.type.includes('failure') || event.type.includes('error');
    const color = isError ? 0xef4444 : 0x22c55e; // red / green
    const fullUrl = this.resolveUrl(event.url);

    const description = [
      event.body || '',
      fullUrl ? `[Open in DarkRide](${fullUrl})` : '',
    ].filter(Boolean).join('\n\n');

    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: event.title,
          description: description || undefined,
          url: fullUrl || undefined,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: 'DarkRide' },
        }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord ${res.status}: ${text}`);
    }
  }

  private async sendSlack(config: ChannelConfig, event: NotificationEvent): Promise<void> {
    if (!config.url) throw new Error('Slack webhook URL not configured');

    const isError = event.type.includes('failure') || event.type.includes('error');
    const emoji = isError ? ':x:' : ':white_check_mark:';
    const fullUrl = this.resolveUrl(event.url);

    const parts = [
      `${emoji} *${event.title}*`,
      event.body || '',
      fullUrl ? `<${fullUrl}|Open in DarkRide>` : '',
    ].filter(Boolean);

    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: parts.join('\n'),
            },
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Slack ${res.status}: ${text}`);
    }
  }

  private async sendTelegram(config: ChannelConfig, event: NotificationEvent): Promise<void> {
    if (!config.botToken || !config.chatId) throw new Error('Telegram bot token and chat ID required');

    const fullUrl = this.resolveUrl(event.url);
    const parts = [
      `<b>${escapeHtml(event.title)}</b>`,
      event.body ? escapeHtml(event.body) : '',
      fullUrl ? `<a href="${escapeHtml(fullUrl)}">Open in DarkRide</a>` : '',
    ].filter(Boolean);

    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: parts.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram ${res.status}: ${body}`);
    }
  }

  private async sendEmail(config: ChannelConfig, event: NotificationEvent): Promise<void> {
    if (!config.smtpHost) throw new Error('SMTP host not configured');
    if (!config.fromAddress) throw new Error('From address not configured');
    if (!config.toAddresses) throw new Error('To addresses not configured');

    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: config.smtpSecure ?? false,
      ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPass || '' } } : {}),
    });

    const isError = event.type.includes('failure') || event.type.includes('error');
    const fullUrl = this.resolveUrl(event.url);
    const statusColor = isError ? '#ef4444' : '#22c55e';

    const html = [
      `<div style="font-family:sans-serif;max-width:600px">`,
      `<div style="border-left:4px solid ${statusColor};padding:12px 16px">`,
      `<h2 style="margin:0 0 8px">${escapeHtml(event.title)}</h2>`,
      event.body ? `<p style="margin:0 0 8px;color:#555">${escapeHtml(event.body)}</p>` : '',
      fullUrl ? `<p style="margin:0"><a href="${escapeHtml(fullUrl)}">Open in DarkRide</a></p>` : '',
      `</div>`,
      `<p style="font-size:11px;color:#999;margin-top:16px">Sent by DarkRide</p>`,
      `</div>`,
    ].join('\n');

    await transport.sendMail({
      from: config.fromAddress,
      to: config.toAddresses,
      subject: `[DarkRide] ${event.title}`,
      html,
    });
  }

  private async sendWebhook(channel: NotificationChannel, event: NotificationEvent): Promise<void> {
    const config = channel.config;

    // ntfy: POST to {url}/{topic} with plain text
    if (channel.type === 'ntfy') {
      const baseUrl = (config.url || 'https://ntfy.sh').replace(/\/$/, '');
      const topic = config.topic;
      if (!topic) throw new Error('ntfy topic not configured');

      const isError = event.type.includes('failure') || event.type.includes('error');
      const fullUrl = this.resolveUrl(event.url);
      const res = await fetch(`${baseUrl}/${topic}`, {
        method: 'POST',
        headers: {
          'Title': event.title,
          'Priority': isError ? '4' : '3',
          'Tags': isError ? 'x' : 'white_check_mark',
          ...(fullUrl ? { 'Click': fullUrl, 'Actions': `view, Open, ${fullUrl}` } : {}),
          ...(config.headers || {}),
        },
        body: event.body || event.title,
      });
      if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text().catch(() => '')}`);
      return;
    }

    // gotify: POST to {url}/message with JSON
    if (channel.type === 'gotify') {
      if (!config.url) throw new Error('Gotify server URL not configured');
      if (!config.appToken) throw new Error('Gotify app token not configured');

      const isError = event.type.includes('failure') || event.type.includes('error');
      const fullUrl = this.resolveUrl(event.url);
      const message = [event.body || event.title, fullUrl || ''].filter(Boolean).join('\n');
      const res = await fetch(`${config.url.replace(/\/$/, '')}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': config.appToken },
        body: JSON.stringify({
          title: event.title,
          message,
          priority: isError ? 7 : 4,
          extras: fullUrl ? { 'client::notification': { click: { url: fullUrl } } } : undefined,
        }),
      });
      if (!res.ok) throw new Error(`Gotify ${res.status}: ${await res.text().catch(() => '')}`);
      return;
    }

    // Generic webhook: POST JSON payload
    if (!config.url) throw new Error('Webhook URL not configured');

    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      },
      body: JSON.stringify({
        eventType: event.type,
        title: event.title,
        body: event.body || null,
        url: this.resolveUrl(event.url) || null,
        sourceType: event.sourceType || null,
        sourceId: event.sourceId || null,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Webhook ${res.status}: ${text}`);
    }
  }

  /**
   * Send a test notification directly to a specific channel, bypassing event subscription checks.
   * Returns the delivery result synchronously so the caller can report success/failure.
   */
  async testChannel(channelId: number): Promise<{ success: boolean; error?: string }> {
    const row = this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .all()[0];

    if (!row) return { success: false, error: 'Channel not found' };

    const channel: NotificationChannel = {
      id: row.id,
      name: row.name,
      type: row.type,
      config: JSON.parse(row.config) as ChannelConfig,
      enabled: true,
      events: [],
    };

    const event: NotificationEvent = {
      type: 'automation:success',
      title: 'Test Notification',
      body: `This is a test from DarkRide to your "${row.name}" channel.`,
      sourceType: 'test',
      sourceId: String(channelId),
    };

    try {
      await this.dispatch(channel, event);

      this.db.insert(notificationHistory).values({
        channelId: channel.id,
        channelName: channel.name,
        eventType: 'test',
        title: event.title,
        body: event.body || null,
        sourceType: 'test',
        sourceId: String(channelId),
        success: true,
        error: null,
        createdAt: new Date(),
      }).run();

      return { success: true };
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';

      this.db.insert(notificationHistory).values({
        channelId: channel.id,
        channelName: channel.name,
        eventType: 'test',
        title: event.title,
        body: event.body || null,
        sourceType: 'test',
        sourceId: String(channelId),
        success: false,
        error: errorMsg,
        createdAt: new Date(),
      }).run();

      return { success: false, error: errorMsg };
    }
  }

  // --- Quiet hours ---

  getQuietHoursConfig(): QuietHoursConfig | null {
    const row = this.db.select().from(settings).where(eq(settings.key, 'notification_quiet_hours')).all()[0];
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as QuietHoursConfig;
    } catch {
      return null;
    }
  }

  private isInQuietHours(): boolean {
    const config = this.getQuietHoursConfig();
    if (!config?.enabled) return false;

    const now = new Date();
    let localTime: { hours: number; minutes: number; day: number };

    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone,
        hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
      });
      const parts = formatter.formatToParts(now);
      const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
      const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
      const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? '';
      const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      localTime = { hours: hour, minutes: minute, day: dayMap[weekdayStr] ?? now.getDay() };
    } catch {
      // Invalid timezone — fall back to UTC
      localTime = { hours: now.getUTCHours(), minutes: now.getUTCMinutes(), day: now.getUTCDay() };
    }

    if (!config.daysOfWeek.includes(localTime.day)) return false;

    const [startH, startM] = config.startTime.split(':').map(Number);
    const [endH, endM] = config.endTime.split(':').map(Number);
    const nowMins = localTime.hours * 60 + localTime.minutes;
    const startMins = startH * 60 + startM;
    const endMins = endH * 60 + endM;

    if (startMins <= endMins) {
      // Same-day window (e.g. 09:00–17:00)
      return nowMins >= startMins && nowMins < endMins;
    }
    // Wraps midnight (e.g. 22:00–08:00)
    return nowMins >= startMins || nowMins < endMins;
  }

  /** Number of events currently queued (waiting for quiet hours to end). */
  getQueuedCount(): number {
    return this.db.select({ id: notificationQueue.id }).from(notificationQueue).all().length;
  }

  /** List currently queued events. Payload is parsed for the UI; createdAt is
   *  the seconds-resolution timestamp the queue was populated at. */
  listQueued(): Array<{ id: number; eventType: string; createdAt: number; payload: NotificationEvent | null }> {
    const rows = this.db.select().from(notificationQueue).orderBy(notificationQueue.createdAt).all();
    return rows.map(r => {
      let payload: NotificationEvent | null = null;
      try { payload = JSON.parse(r.payload); } catch { /* corrupt row */ }
      const ts = r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt);
      return { id: r.id, eventType: r.eventType, createdAt: ts, payload };
    });
  }

  /** Dispatch a single queued event immediately and remove it from the queue.
   *  Returns true if the row existed, false if not. */
  sendQueued(id: number): boolean {
    const row = this.db.select().from(notificationQueue).where(eq(notificationQueue.id, id)).get();
    if (!row) return false;
    this.db.delete(notificationQueue).where(eq(notificationQueue.id, id)).run();
    try {
      const event: NotificationEvent = JSON.parse(row.payload);
      // emit() will re-check quiet hours; bypass that by routing direct.
      this.dispatchEvent(event);
    } catch (err: any) {
      logError(`sendQueued failed to parse row ${id}: ${err.message}`);
      return false;
    }
    return true;
  }

  /** Discard a queued event without sending. Returns true if a row was removed. */
  discardQueued(id: number): boolean {
    const result = this.db.delete(notificationQueue).where(eq(notificationQueue.id, id)).run();
    return result.changes > 0;
  }

  /** Dispatch every queued event immediately. Returns the number sent. */
  sendAllQueued(): number {
    const rows = this.db.select().from(notificationQueue).all();
    if (rows.length === 0) return 0;
    this.db.delete(notificationQueue).run();
    let sent = 0;
    for (const row of rows) {
      try {
        const event: NotificationEvent = JSON.parse(row.payload);
        this.dispatchEvent(event);
        sent += 1;
      } catch (err: any) {
        logError(`sendAllQueued failed to parse row ${row.id}: ${err.message}`);
      }
    }
    return sent;
  }

  // --- History & management ---

  getHistory(limit = 50, offset = 0) {
    return this.db
      .select()
      .from(notificationHistory)
      .orderBy(desc(notificationHistory.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
  }

  pruneHistory(cutoffDate: Date): void {
    this.db.delete(notificationHistory).where(lt(notificationHistory.createdAt, cutoffDate)).run();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
