import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/create-test-db';
import { notificationChannels, notificationHistory, notificationQueue, settings } from '../db/schema';
import {
  NotificationService,
  NOTIFICATION_EVENT_TYPES,
  CRITICAL_EVENT_TYPES,
  CORE_NOTIFICATION_EVENTS,
  registerPluginNotificationEvents,
  getAllNotificationEventTypes,
  isValidEventType,
} from './notification-service';
import type { AppDatabase } from '../db/index';

const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'test-id' });
vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail: sendMailMock })),
}));

describe('NotificationService', () => {
  let db: AppDatabase;
  let service: NotificationService;

  beforeEach(() => {
    db = createTestDb([notificationChannels, notificationHistory, notificationQueue, settings]);
    service = new NotificationService(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should export all event types', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('automation:success');
    expect(NOTIFICATION_EVENT_TYPES).toContain('automation:failure');
    expect(NOTIFICATION_EVENT_TYPES).toContain('apk:new-version');
    expect(NOTIFICATION_EVENT_TYPES).toContain('capture:error');
    expect(NOTIFICATION_EVENT_TYPES).toContain('system:disk-space-low');
    expect(NOTIFICATION_EVENT_TYPES).toContain('api:regression');
    // Map events are registered by the maps plugin, not core
    expect(NOTIFICATION_EVENT_TYPES).not.toContain('map:download-complete');
    expect(NOTIFICATION_EVENT_TYPES).not.toContain('map:change-detected');
  });

  it('should do nothing when no channels are subscribed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: 'test body',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should dispatch to subscribed discord channel', async () => {
    // Insert a channel
    db.insert(notificationChannels).values({
      name: 'Test Discord',
      type: 'discord',
      config: JSON.stringify({ url: 'https://discord.com/api/webhooks/test' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:success',
      title: 'Automation completed',
      body: 'Login flow finished',
      sourceType: 'automation',
      sourceId: '42',
    });

    // Wait for async dispatch
    await new Promise(r => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://discord.com/api/webhooks/test');
    expect(opts?.method).toBe('POST');

    const body = JSON.parse(opts?.body as string);
    expect(body.embeds[0].title).toBe('Automation completed');
    expect(body.embeds[0].description).toBe('Login flow finished');
    expect(body.embeds[0].color).toBe(0x22c55e); // green for success
  });

  it('should use red color for failure events', async () => {
    db.insert(notificationChannels).values({
      name: 'Discord',
      type: 'discord',
      config: JSON.stringify({ url: 'https://discord.com/api/webhooks/test' }),
      events: JSON.stringify(['automation:failure']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:failure',
      title: 'Automation failed',
      body: 'Timeout',
    });
    await new Promise(r => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.embeds[0].color).toBe(0xef4444); // red for failure
  });

  it('should skip disabled channels', async () => {
    db.insert(notificationChannels).values({
      name: 'Disabled',
      type: 'discord',
      config: JSON.stringify({ url: 'https://discord.com/api/webhooks/test' }),
      events: JSON.stringify(['automation:success']),
      enabled: false,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: '',
    });
    await new Promise(r => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should skip channels not subscribed to the event type', async () => {
    db.insert(notificationChannels).values({
      name: 'Discord',
      type: 'discord',
      config: JSON.stringify({ url: 'https://discord.com/api/webhooks/test' }),
      events: JSON.stringify(['apk:new-version']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: '',
    });
    await new Promise(r => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should log to notification history on success', async () => {
    db.insert(notificationChannels).values({
      name: 'Test',
      type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:success',
      title: 'Done',
      body: 'ok',
      sourceType: 'automation',
      sourceId: '1',
    });
    await new Promise(r => setTimeout(r, 100));

    const history = service.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].eventType).toBe('automation:success');
    expect(history[0].title).toBe('Done');
    expect(history[0].success).toBe(true);
    expect(history[0].channelName).toBe('Test');
  });

  it('should log to notification history on failure', async () => {
    db.insert(notificationChannels).values({
      name: 'Broken',
      type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:failure']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Request', { status: 400 }));

    await service.emit({
      type: 'automation:failure',
      title: 'Failed',
      body: 'error',
    });
    // Wait for retries (3 attempts)
    await new Promise(r => setTimeout(r, 15000));

    const history = service.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].success).toBe(false);
    expect(history[0].error).toContain('400');
  }, 20000);

  it('should dispatch to slack channel', async () => {
    db.insert(notificationChannels).values({
      name: 'Slack',
      type: 'slack',
      config: JSON.stringify({ url: 'https://hooks.slack.com/services/T/B/xxx' }),
      events: JSON.stringify(['apk:new-version']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'apk:new-version',
      title: 'New APK: com.example',
      body: 'v2.0.0',
    });
    await new Promise(r => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.blocks[0].text.text).toContain('New APK: com.example');
  });

  it('should dispatch to telegram channel', async () => {
    db.insert(notificationChannels).values({
      name: 'TG',
      type: 'telegram',
      config: JSON.stringify({ botToken: '123:ABC', chatId: '-100123' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: '',
    });
    await new Promise(r => setTimeout(r, 50));

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
  });

  it('should dispatch to ntfy channel', async () => {
    db.insert(notificationChannels).values({
      name: 'ntfy',
      type: 'ntfy',
      config: JSON.stringify({ url: 'https://ntfy.sh', topic: 'darkride-test' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: 'body text',
    });
    await new Promise(r => setTimeout(r, 50));

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/darkride-test');
    expect((opts?.headers as Record<string, string>)['Title']).toBe('Test');
  });

  it('should dispatch to gotify channel', async () => {
    db.insert(notificationChannels).values({
      name: 'Gotify',
      type: 'gotify',
      config: JSON.stringify({ url: 'https://gotify.example.com', appToken: 'ATOKEN' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: 'body',
    });
    await new Promise(r => setTimeout(r, 50));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://gotify.example.com/message');
    expect(options.headers['X-Gotify-Key']).toBe('ATOKEN');
  });

  it('should dispatch to email/SMTP channel', async () => {
    db.insert(notificationChannels).values({
      name: 'Email',
      type: 'email',
      config: JSON.stringify({
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        fromAddress: 'darkride@example.com',
        toAddresses: 'admin@example.com',
      }),
      events: JSON.stringify(['automation:failure']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    sendMailMock.mockClear();
    const nodemailer = await import('nodemailer');
    (nodemailer.createTransport as ReturnType<typeof vi.fn>).mockClear();

    await service.emit({
      type: 'automation:failure',
      title: 'Automation failed',
      body: 'Script crashed',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'secret' },
    });
    expect(sendMailMock).toHaveBeenCalledOnce();
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('darkride@example.com');
    expect(mailOpts.to).toBe('admin@example.com');
    expect(mailOpts.subject).toBe('[DarkRide] Automation failed');
    expect(mailOpts.html).toContain('Automation failed');
    expect(mailOpts.html).toContain('Script crashed');
  });

  it('should dispatch to generic webhook', async () => {
    db.insert(notificationChannels).values({
      name: 'Webhook',
      type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook', headers: { Authorization: 'Bearer xyz' } }),
      events: JSON.stringify(['map:download-complete']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'map:download-complete',
      title: 'Map done',
      body: '100 tiles',
      sourceType: 'map',
      sourceId: '5',
    });
    await new Promise(r => setTimeout(r, 50));

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect((opts?.headers as Record<string, string>)['Authorization']).toBe('Bearer xyz');

    const body = JSON.parse(opts?.body as string);
    expect(body.eventType).toBe('map:download-complete');
    expect(body.title).toBe('Map done');
    expect(body.sourceType).toBe('map');
    expect(body.sourceId).toBe('5');
  });

  it('should dispatch to multiple channels', async () => {
    db.insert(notificationChannels).values({
      name: 'Ch1',
      type: 'webhook',
      config: JSON.stringify({ url: 'https://a.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();
    db.insert(notificationChannels).values({
      name: 'Ch2',
      type: 'webhook',
      config: JSON.stringify({ url: 'https://b.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true,
      createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({
      type: 'automation:success',
      title: 'Test',
      body: '',
    });
    await new Promise(r => setTimeout(r, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(c => c[0]);
    expect(urls).toContain('https://a.com/hook');
    expect(urls).toContain('https://b.com/hook');
  });

  it('should prune history', () => {
    db.insert(notificationHistory).values({
      channelId: null,
      channelName: 'Test',
      eventType: 'automation:success',
      title: 'Old',
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    }).run();
    db.insert(notificationHistory).values({
      channelId: null,
      channelName: 'Test',
      eventType: 'automation:success',
      title: 'Recent',
      createdAt: new Date(),
    }).run();

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    service.pruneHistory(cutoff);

    const remaining = service.getHistory();
    expect(remaining.length).toBe(1);
    expect(remaining[0].title).toBe('Recent');
  });

  it('should export critical event types', () => {
    expect(CRITICAL_EVENT_TYPES).toContain('automation:failure');
    expect(CRITICAL_EVENT_TYPES).toContain('device:disconnected');
    expect(CRITICAL_EVENT_TYPES).toContain('system:disk-space-low');
    expect(CRITICAL_EVENT_TYPES).not.toContain('automation:success');
  });

  it('should return null when no quiet hours configured', () => {
    expect(service.getQuietHoursConfig()).toBeNull();
  });

  it('should queue non-critical events during quiet hours instead of dropping', async () => {
    // Configure quiet hours to cover current time (all day, all days)
    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime: '00:00', endTime: '23:59',
        timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }),
    }).run();

    db.insert(notificationChannels).values({
      name: 'Test', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true, createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    service.emit({ type: 'automation:success', title: 'Test', body: '' });
    await new Promise(r => setTimeout(r, 50));

    // Should NOT have been sent yet — queued for later
    expect(fetchSpy).not.toHaveBeenCalled();
    // Verify it's in the database queue
    const queued = db.select().from(notificationQueue).all();
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].payload).title).toBe('Test');
  });

  it('should NOT queue non-critical events with no subscribed channel during quiet hours', async () => {
    // Quiet hours configured, but NO channel subscribes to this event type.
    // When quiet hours end, dispatchEvent would silently drop the event
    // (no subscribers); queueing it just clutters the UI with rows that
    // will never fire.
    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime: '00:00', endTime: '23:59',
        timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }),
    }).run();

    // A channel exists but it subscribes to a DIFFERENT event type.
    db.insert(notificationChannels).values({
      name: 'Subscribed only to other', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['plugin:error']),
      enabled: true, createdAt: new Date(),
    }).run();

    service.emit({ type: 'automation:success', title: 'Test', body: '' });
    await new Promise(r => setTimeout(r, 50));

    const queued = db.select().from(notificationQueue).all();
    expect(queued).toHaveLength(0);
  });

  it('should NOT queue when the subscribed channel is disabled', async () => {
    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime: '00:00', endTime: '23:59',
        timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }),
    }).run();

    // Channel subscribes but is disabled.
    db.insert(notificationChannels).values({
      name: 'Disabled', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: false, createdAt: new Date(),
    }).run();

    service.emit({ type: 'automation:success', title: 'Test', body: '' });
    await new Promise(r => setTimeout(r, 50));

    const queued = db.select().from(notificationQueue).all();
    expect(queued).toHaveLength(0);
  });

  it('should still send critical events during quiet hours', async () => {
    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime: '00:00', endTime: '23:59',
        timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }),
    }).run();

    db.insert(notificationChannels).values({
      name: 'Test', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:failure']),
      enabled: true, createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({ type: 'automation:failure', title: 'Critical', body: '' });
    await new Promise(r => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('should queue during midnight-wrapping quiet hours window', async () => {
    // Configure a window that wraps midnight (e.g. 22:00–06:00)
    // Use a timezone where the current time falls inside this window
    const now = new Date();
    const currentHour = now.getUTCHours();
    // Build a wrapping window that includes the current UTC hour
    const startTime = `${String((currentHour - 1 + 24) % 24).padStart(2, '0')}:00`;
    const endTime = `${String((currentHour + 1) % 24).padStart(2, '0')}:00`;

    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime, endTime,
        timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }),
    }).run();

    db.insert(notificationChannels).values({
      name: 'Test', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true, createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    service.emit({ type: 'automation:success', title: 'Test', body: '' });
    await new Promise(r => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
    const queued2 = db.select().from(notificationQueue).all();
    expect(queued2).toHaveLength(1);
  });

  it('should flush queued events when quiet hours end', async () => {
    // Queue an event during quiet hours
    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime: '00:00', endTime: '23:59',
        timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      }),
    }).run();

    db.insert(notificationChannels).values({
      name: 'Test', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true, createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    service.emit({ type: 'automation:success', title: 'Queued Event', body: '' });
    expect(db.select().from(notificationQueue).all()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Now disable quiet hours and manually flush
    db.update(settings).set({
      value: JSON.stringify({ enabled: false }),
    }).where(eq(settings.key, 'notification_quiet_hours')).run();

    // Manually trigger flush (simulates timer firing)
    (service as any).flushQueue();
    await new Promise(r => setTimeout(r, 100));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(db.select().from(notificationQueue).all()).toHaveLength(0);
  });

  describe('queue dedup', () => {
    beforeEach(() => {
      db.insert(settings).values({
        key: 'notification_quiet_hours',
        value: JSON.stringify({
          enabled: true, startTime: '00:00', endTime: '23:59',
          timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        }),
      }).run();
      db.insert(notificationChannels).values({
        name: 'Test', type: 'webhook',
        config: JSON.stringify({ url: 'https://example.com/hook' }),
        events: JSON.stringify(['apk:analysis-complete']),
        enabled: true, createdAt: new Date(),
      }).run();
    });

    it('collapses repeated events with the same (eventType, sourceType, sourceId)', async () => {
      // Regression guard: an APK analysis that kept failing used to enqueue a
      // fresh row per attempt during quiet hours, growing to 110+ queued.
      for (let i = 0; i < 5; i++) {
        service.emit({
          type: 'apk:analysis-complete',
          title: `APK analysis failed: com.seaworld.mobile (attempt ${i + 1})`,
          body: 'APK not available',
          sourceType: 'apk',
          sourceId: '42',
        });
      }

      const rows = db.select().from(notificationQueue).all();
      expect(rows).toHaveLength(1);
      // The latest title should win (payload updated on each dedup hit).
      const payload = JSON.parse(rows[0].payload);
      expect(payload.title).toContain('attempt 5');
    });

    it('does not dedup events with different sourceIds', async () => {
      service.emit({ type: 'apk:analysis-complete', title: 'A', body: '', sourceType: 'apk', sourceId: '1' });
      service.emit({ type: 'apk:analysis-complete', title: 'B', body: '', sourceType: 'apk', sourceId: '2' });
      expect(db.select().from(notificationQueue).all()).toHaveLength(2);
    });

    it('does not dedup when sourceType / sourceId are absent', async () => {
      // Bare events (no source) — keep existing behaviour of one row per emit.
      service.emit({ type: 'apk:analysis-complete', title: 'First', body: '' });
      service.emit({ type: 'apk:analysis-complete', title: 'Second', body: '' });
      expect(db.select().from(notificationQueue).all()).toHaveLength(2);
    });
  });

  describe('getQueuedCount()', () => {
    it('returns 0 when the queue is empty', () => {
      expect(service.getQueuedCount()).toBe(0);
    });

    it('returns correct count after queueing events during quiet hours', async () => {
      // All-day quiet hours so every non-critical event gets queued
      db.insert(settings).values({
        key: 'notification_quiet_hours',
        value: JSON.stringify({
          enabled: true, startTime: '00:00', endTime: '23:59',
          timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        }),
      }).run();

      db.insert(notificationChannels).values({
        name: 'Test', type: 'webhook',
        config: JSON.stringify({ url: 'https://example.com/hook' }),
        events: JSON.stringify(['automation:success']),
        enabled: true, createdAt: new Date(),
      }).run();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      service.emit({ type: 'automation:success', title: 'First', body: '' });
      service.emit({ type: 'automation:success', title: 'Second', body: '' });
      await new Promise(r => setTimeout(r, 50));

      expect(service.getQueuedCount()).toBe(2);
    });

    it('queue survives service re-instantiation', async () => {
      // Configure all-day quiet hours
      db.insert(settings).values({
        key: 'notification_quiet_hours',
        value: JSON.stringify({
          enabled: true, startTime: '00:00', endTime: '23:59',
          timezone: 'UTC', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        }),
      }).run();

      db.insert(notificationChannels).values({
        name: 'Test', type: 'webhook',
        config: JSON.stringify({ url: 'https://example.com/hook' }),
        events: JSON.stringify(['automation:success']),
        enabled: true, createdAt: new Date(),
      }).run();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      // Queue an event with the original service instance
      service.emit({ type: 'automation:success', title: 'Persisted', body: '' });
      await new Promise(r => setTimeout(r, 50));

      expect(service.getQueuedCount()).toBe(1);

      // Create a fresh service instance backed by the same DB
      const newService = new NotificationService(db);
      expect(newService.getQueuedCount()).toBeGreaterThan(0);
    });
  });

  it('should not suppress when current day is excluded from daysOfWeek', async () => {
    const now = new Date();
    const currentDay = now.getUTCDay();
    // Exclude the current day
    const activeDays = [0, 1, 2, 3, 4, 5, 6].filter(d => d !== currentDay);

    db.insert(settings).values({
      key: 'notification_quiet_hours',
      value: JSON.stringify({
        enabled: true, startTime: '00:00', endTime: '23:59',
        timezone: 'UTC', daysOfWeek: activeDays,
      }),
    }).run();

    db.insert(notificationChannels).values({
      name: 'Test', type: 'webhook',
      config: JSON.stringify({ url: 'https://example.com/hook' }),
      events: JSON.stringify(['automation:success']),
      enabled: true, createdAt: new Date(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await service.emit({ type: 'automation:success', title: 'Test', body: '' });
    await new Promise(r => setTimeout(r, 50));

    // Should send because today is excluded from quiet hours days
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('plugin notification event registration', () => {
  // Note: registerPluginNotificationEvents mutates module-level state. Each test uses
  // unique type strings to avoid collisions with other tests or prior registrations.

  it('registerPluginNotificationEvents adds events to isValidEventType', () => {
    registerPluginNotificationEvents([{ type: 'plugin:test-event-a' }]);
    expect(isValidEventType('plugin:test-event-a')).toBe(true);
  });

  it('registered plugin events appear in getAllNotificationEventTypes with label and description', () => {
    registerPluginNotificationEvents([
      {
        type: 'plugin:test-event-b',
        label: 'My Plugin Event',
        description: 'Fires when something happens',
      },
    ]);
    const all = getAllNotificationEventTypes();
    const entry = all.find(e => e.type === 'plugin:test-event-b');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('My Plugin Event');
    expect(entry?.description).toBe('Fires when something happens');
  });

  it('critical plugin events are marked as critical in the merged list', () => {
    registerPluginNotificationEvents([
      { type: 'plugin:test-critical-c', label: 'Critical Plugin', critical: true },
    ]);
    const all = getAllNotificationEventTypes();
    const entry = all.find(e => e.type === 'plugin:test-critical-c');
    expect(entry).toBeDefined();
    expect(entry?.critical).toBe(true);
  });

  it('isValidEventType returns true for registered plugin events', () => {
    registerPluginNotificationEvents([{ type: 'plugin:test-event-d' }]);
    expect(isValidEventType('plugin:test-event-d')).toBe(true);
  });

  it('isValidEventType returns false for unknown event types', () => {
    expect(isValidEventType('plugin:not-registered-xyz-99')).toBe(false);
  });

  it('getAllNotificationEventTypes returns core events with labels and descriptions', () => {
    const all = getAllNotificationEventTypes();
    for (const core of CORE_NOTIFICATION_EVENTS) {
      const entry = all.find(e => e.type === core.type);
      expect(entry).toBeDefined();
      expect(entry?.label).toBe(core.label);
      expect(entry?.description).toBe(core.description);
    }
  });

  it('plugin events with missing label default to the type string', () => {
    registerPluginNotificationEvents([{ type: 'plugin:test-no-label-e' }]);
    const all = getAllNotificationEventTypes();
    const entry = all.find(e => e.type === 'plugin:test-no-label-e');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('plugin:test-no-label-e');
  });

  it('multiple plugin registrations accumulate independently', () => {
    registerPluginNotificationEvents([
      { type: 'alpha:download-complete-f', label: 'Alpha downloaded' },
      { type: 'alpha:change-detected-f', label: 'Alpha changed', critical: true },
    ]);
    registerPluginNotificationEvents([
      { type: 'beta:sync-complete-f', label: 'Beta sync done' },
    ]);

    expect(isValidEventType('alpha:download-complete-f')).toBe(true);
    expect(isValidEventType('alpha:change-detected-f')).toBe(true);
    expect(isValidEventType('beta:sync-complete-f')).toBe(true);

    const all = getAllNotificationEventTypes();
    expect(all.find(e => e.type === 'alpha:download-complete-f')).toBeDefined();
    expect(all.find(e => e.type === 'alpha:change-detected-f')).toBeDefined();
    expect(all.find(e => e.type === 'beta:sync-complete-f')).toBeDefined();
  });
});
