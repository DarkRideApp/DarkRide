import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { notificationChannels, notificationHistory, settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { NotificationService, CRITICAL_EVENT_TYPES, isValidEventType, getAllNotificationEventTypes } from '../services/notification-service';
import type { QuietHoursConfig } from '../services/notification-service';

function isValidTime(time: string): boolean {
  const [h, m] = time.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function registerNotificationEndpoints(db: AppDatabase, notificationService: NotificationService): void {

  // GET /v1/notifications/channels — list all channels
  registerEndpoint('GET', '/v1/notifications/channels', (_req, res) => {
    const rows = db.select().from(notificationChannels).all();
    const data = rows.map(row => ({
      ...row,
      config: JSON.parse(row.config),
      events: JSON.parse(row.events),
    }));
    res.json({ success: true, data });
  }, { requires: ['core.settings:write'] });

  // GET /v1/notifications/channels/:id — get single channel
  registerEndpoint('GET', '/v1/notifications/channels/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).all()[0];
    if (!row) {
      res.status(404).json({ success: false, error: 'Channel not found' });
      return;
    }
    res.json({
      success: true,
      data: { ...row, config: JSON.parse(row.config), events: JSON.parse(row.events) },
    });
  }, { requires: ['core.settings:write'] });

  // POST /v1/notifications/channels — create channel
  registerEndpoint('POST', '/v1/notifications/channels', (req, res) => {
    const { name, type, config, events, enabled } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }
    if (!type || !['discord', 'slack', 'telegram', 'webhook', 'ntfy', 'gotify', 'email'].includes(type)) {
      res.status(400).json({ success: false, error: 'type must be one of: discord, slack, telegram, webhook, ntfy, gotify, email' });
      return;
    }
    if (!config || typeof config !== 'object') {
      res.status(400).json({ success: false, error: 'config object is required' });
      return;
    }
    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({ success: false, error: 'events must be a non-empty array' });
      return;
    }

    // Validate event types
    const invalidEvents = events.filter((e: string) => !isValidEventType(e));
    if (invalidEvents.length > 0) {
      res.status(400).json({ success: false, error: `Invalid event types: ${invalidEvents.join(', ')}` });
      return;
    }

    const result = db.insert(notificationChannels).values({
      name,
      type,
      config: JSON.stringify(config),
      events: JSON.stringify(events),
      enabled: enabled !== false,
      createdAt: new Date(),
    }).run();

    const row = db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, Number(result.lastInsertRowid))).all()[0];

    res.json({
      success: true,
      data: { ...row, config: JSON.parse(row!.config), events: JSON.parse(row!.events) },
    });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/notifications/channels/:id — update channel
  registerEndpoint('PUT', '/v1/notifications/channels/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Channel not found' });
      return;
    }

    const updates: Record<string, any> = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.type !== undefined) updates.type = req.body.type;
    if (req.body.config !== undefined) updates.config = JSON.stringify(req.body.config);
    if (req.body.events !== undefined) {
      if (!Array.isArray(req.body.events)) {
        res.status(400).json({ success: false, error: 'events must be an array' });
        return;
      }
      const invalidEvents = req.body.events.filter((e: string) => !isValidEventType(e));
      if (invalidEvents.length > 0) {
        res.status(400).json({ success: false, error: `Invalid event types: ${invalidEvents.join(', ')}` });
        return;
      }
      updates.events = JSON.stringify(req.body.events);
    }
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

    db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, id)).run();

    const row = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).all()[0];
    res.json({
      success: true,
      data: { ...row, config: JSON.parse(row!.config), events: JSON.parse(row!.events) },
    });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/notifications/channels/:id — delete channel
  registerEndpoint('DELETE', '/v1/notifications/channels/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Channel not found' });
      return;
    }
    db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // POST /v1/notifications/channels/:id/test — send test notification
  registerEndpoint('POST', '/v1/notifications/channels/:id/test', async (req, res) => {
    const id = Number(req.params.id);
    const result = await notificationService.testChannel(id);
    if (!result.success) {
      res.status(result.error === 'Channel not found' ? 404 : 502).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true });
  });

  // GET /v1/notifications/history — paginated history
  registerEndpoint('GET', '/v1/notifications/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const data = notificationService.getHistory(limit, offset);
    res.json({ success: true, data });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/notifications/history — clear history
  registerEndpoint('DELETE', '/v1/notifications/history', (_req, res) => {
    db.delete(notificationHistory).run();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // GET /v1/notifications/event-types — list available event types
  registerEndpoint('GET', '/v1/notifications/event-types', (_req, res) => {
    res.json({ success: true, data: getAllNotificationEventTypes() });
  }, { requires: ['core.settings:write'] });

  // GET /v1/notifications/quiet-hours — get quiet hours config
  registerEndpoint('GET', '/v1/notifications/quiet-hours', (_req, res) => {
    const config = notificationService.getQuietHoursConfig();
    res.json({
      success: true,
      data: config || { enabled: false, startTime: '22:00', endTime: '08:00', timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
      criticalEventTypes: CRITICAL_EVENT_TYPES,
      queuedCount: notificationService.getQueuedCount(),
    });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/notifications/quiet-hours — update quiet hours config
  registerEndpoint('PUT', '/v1/notifications/quiet-hours', (req, res) => {
    const { enabled, startTime, endTime, timezone, daysOfWeek } = req.body as Partial<QuietHoursConfig>;

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
      return;
    }
    if (!startTime || !/^\d{2}:\d{2}$/.test(startTime) || !isValidTime(startTime)) {
      res.status(400).json({ success: false, error: 'startTime must be HH:MM format with valid hour (0-23) and minute (0-59)' });
      return;
    }
    if (!endTime || !/^\d{2}:\d{2}$/.test(endTime) || !isValidTime(endTime)) {
      res.status(400).json({ success: false, error: 'endTime must be HH:MM format with valid hour (0-23) and minute (0-59)' });
      return;
    }
    if (!timezone || typeof timezone !== 'string') {
      res.status(400).json({ success: false, error: 'timezone is required' });
      return;
    }
    // Validate timezone
    try {
      Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      res.status(400).json({ success: false, error: `Invalid timezone: ${timezone}` });
      return;
    }
    if (!Array.isArray(daysOfWeek) || daysOfWeek.some((d: any) => typeof d !== 'number' || d < 0 || d > 6)) {
      res.status(400).json({ success: false, error: 'daysOfWeek must be an array of numbers 0-6' });
      return;
    }

    const config: QuietHoursConfig = { enabled, startTime, endTime, timezone, daysOfWeek };
    const existing = db.select().from(settings).where(eq(settings.key, 'notification_quiet_hours')).all()[0];
    if (existing) {
      db.update(settings).set({ value: JSON.stringify(config) }).where(eq(settings.key, 'notification_quiet_hours')).run();
    } else {
      db.insert(settings).values({ key: 'notification_quiet_hours', value: JSON.stringify(config) }).run();
    }

    res.json({ success: true, data: config });
  }, { requires: ['core.settings:write'] });

  // GET /v1/notifications/queue — list events queued during quiet hours
  registerEndpoint('GET', '/v1/notifications/queue', (_req, res) => {
    res.json({ success: true, data: notificationService.listQueued() });
  }, { requires: ['core.settings:write'] });

  // POST /v1/notifications/queue/flush — dispatch every queued event now
  registerEndpoint('POST', '/v1/notifications/queue/flush', (_req, res) => {
    const sent = notificationService.sendAllQueued();
    res.json({ success: true, sent });
  }, { requires: ['core.settings:write'] });

  // POST /v1/notifications/queue/:id/send — dispatch a single queued event now
  registerEndpoint('POST', '/v1/notifications/queue/:id/send', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ success: false, error: 'id must be an integer' }); return; }
    const ok = notificationService.sendQueued(id);
    if (!ok) { res.status(404).json({ success: false, error: 'Queued notification not found' }); return; }
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/notifications/queue/:id — discard a queued event without sending
  registerEndpoint('DELETE', '/v1/notifications/queue/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ success: false, error: 'id must be an integer' }); return; }
    const ok = notificationService.discardQueued(id);
    if (!ok) { res.status(404).json({ success: false, error: 'Queued notification not found' }); return; }
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });
}
