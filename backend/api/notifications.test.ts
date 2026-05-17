import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import { createTestDb } from '../test-utils/create-test-db';
import { notificationChannels, notificationHistory, notificationQueue, settings } from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerNotificationEndpoints } from './notifications';
import { NotificationService, registerPluginNotificationEvents } from '../services/notification-service';
import type { AppDatabase } from '../db/index';

describe('Notification API Endpoints', () => {
  let db: AppDatabase;
  let app: express.Express;
  let notificationService: NotificationService;

  beforeEach(() => {
    clearEndpoints();
    db = createTestDb([notificationChannels, notificationHistory, notificationQueue, settings]);
    notificationService = new NotificationService(db);
    registerNotificationEndpoints(db, notificationService);
    app = express();
    app.use(express.json());
    app.use('/api', getApiRouter());
  });

  describe('GET /v1/notifications/channels', () => {
    it('returns empty array when no channels', async () => {
      const res = await supertest(app).get('/api/v1/notifications/channels');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('returns channels with parsed JSON fields', async () => {
      db.insert(notificationChannels).values({
        name: 'Discord',
        type: 'discord',
        config: JSON.stringify({ url: 'https://discord.com/webhook' }),
        events: JSON.stringify(['automation:success']),
        enabled: true,
        createdAt: new Date(),
      }).run();

      const res = await supertest(app).get('/api/v1/notifications/channels');
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].name).toBe('Discord');
      expect(res.body.data[0].config.url).toBe('https://discord.com/webhook');
      expect(res.body.data[0].events).toEqual(['automation:success']);
    });
  });

  describe('POST /v1/notifications/channels', () => {
    it('creates a channel', async () => {
      const res = await supertest(app)
        .post('/api/v1/notifications/channels')
        .send({
          name: 'My Slack',
          type: 'slack',
          config: { url: 'https://hooks.slack.com/test' },
          events: ['automation:success', 'automation:failure'],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('My Slack');
      expect(res.body.data.type).toBe('slack');
      expect(res.body.data.events).toEqual(['automation:success', 'automation:failure']);
    });

    it('rejects missing name', async () => {
      const res = await supertest(app)
        .post('/api/v1/notifications/channels')
        .send({ type: 'discord', config: {}, events: ['automation:success'] });
      expect(res.status).toBe(400);
    });

    it('rejects invalid type', async () => {
      const res = await supertest(app)
        .post('/api/v1/notifications/channels')
        .send({ name: 'Test', type: 'sms', config: {}, events: ['automation:success'] });
      expect(res.status).toBe(400);
    });

    it('rejects invalid event types', async () => {
      const res = await supertest(app)
        .post('/api/v1/notifications/channels')
        .send({ name: 'Test', type: 'discord', config: {}, events: ['invalid:event'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid event types');
    });

    it('rejects empty events array', async () => {
      const res = await supertest(app)
        .post('/api/v1/notifications/channels')
        .send({ name: 'Test', type: 'discord', config: {}, events: [] });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /v1/notifications/channels/:id', () => {
    it('updates a channel', async () => {
      db.insert(notificationChannels).values({
        name: 'Old Name',
        type: 'discord',
        config: JSON.stringify({ url: 'https://old.url' }),
        events: JSON.stringify(['automation:success']),
        enabled: true,
        createdAt: new Date(),
      }).run();

      const channels = db.select().from(notificationChannels).all();
      const id = channels[0].id;

      const res = await supertest(app)
        .put(`/api/v1/notifications/channels/${id}`)
        .send({ name: 'New Name', enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('New Name');
      expect(res.body.data.enabled).toBe(false);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await supertest(app)
        .put('/api/v1/notifications/channels/999')
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
    });

    it('rejects invalid events on update', async () => {
      db.insert(notificationChannels).values({
        name: 'Ch',
        type: 'discord',
        config: JSON.stringify({}),
        events: JSON.stringify(['automation:success']),
        enabled: true,
        createdAt: new Date(),
      }).run();
      const id = db.select().from(notificationChannels).all()[0].id;

      const res = await supertest(app)
        .put(`/api/v1/notifications/channels/${id}`)
        .send({ events: ['bad:event'] });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /v1/notifications/channels/:id', () => {
    it('deletes a channel', async () => {
      db.insert(notificationChannels).values({
        name: 'Delete Me',
        type: 'webhook',
        config: JSON.stringify({}),
        events: JSON.stringify(['automation:success']),
        enabled: true,
        createdAt: new Date(),
      }).run();
      const id = db.select().from(notificationChannels).all()[0].id;

      const res = await supertest(app).delete(`/api/v1/notifications/channels/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const remaining = db.select().from(notificationChannels).all();
      expect(remaining.length).toBe(0);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await supertest(app).delete('/api/v1/notifications/channels/999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/notifications/history', () => {
    it('returns history entries', async () => {
      db.insert(notificationHistory).values({
        channelId: null,
        channelName: 'Test',
        eventType: 'automation:success',
        title: 'Done',
        body: 'ok',
        success: true,
        createdAt: new Date(),
      }).run();

      const res = await supertest(app).get('/api/v1/notifications/history');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].title).toBe('Done');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        db.insert(notificationHistory).values({
          channelId: null,
          channelName: 'Test',
          eventType: 'automation:success',
          title: `Entry ${i}`,
          success: true,
          createdAt: new Date(),
        }).run();
      }

      const res = await supertest(app).get('/api/v1/notifications/history?limit=3');
      expect(res.body.data.length).toBe(3);
    });
  });

  describe('GET /v1/notifications/event-types', () => {
    it('returns success with an array', async () => {
      const res = await supertest(app).get('/api/v1/notifications/event-types');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns objects with type, label, and description — not plain strings', async () => {
      const res = await supertest(app).get('/api/v1/notifications/event-types');
      expect(res.status).toBe(200);
      // Every entry must be an object, not a plain string
      for (const entry of res.body.data) {
        expect(typeof entry).toBe('object');
        expect(typeof entry.type).toBe('string');
        expect(typeof entry.label).toBe('string');
        // description is optional but when present must be a string
        if (entry.description !== undefined) {
          expect(typeof entry.description).toBe('string');
        }
      }
    });

    it('includes core events with correct labels and descriptions', async () => {
      const res = await supertest(app).get('/api/v1/notifications/event-types');
      expect(res.status).toBe(200);
      const types = res.body.data.map((e: { type: string }) => e.type);
      expect(types).toContain('automation:success');
      expect(types).toContain('apk:new-version');
      // Map events are registered by the maps plugin, not in core
      expect(types).not.toContain('map:download-complete');
      // Core entry has the expected label and a non-empty description
      const successEntry = res.body.data.find((e: { type: string }) => e.type === 'automation:success');
      expect(successEntry).toBeDefined();
      expect(successEntry.label).toBe('Automation success');
      expect(successEntry.description).toBeDefined();
      expect(successEntry.description.length).toBeGreaterThan(0);
    });

    it('includes plugin-registered events with their labels', async () => {
      // Register a plugin event before hitting the endpoint
      registerPluginNotificationEvents([
        {
          type: 'test-api:plugin-event-unique-xyz',
          label: 'Test Plugin Event',
          description: 'A plugin event for API endpoint testing',
        },
      ]);

      const res = await supertest(app).get('/api/v1/notifications/event-types');
      expect(res.status).toBe(200);

      const entry = res.body.data.find(
        (e: { type: string }) => e.type === 'test-api:plugin-event-unique-xyz',
      );
      expect(entry).toBeDefined();
      expect(entry.label).toBe('Test Plugin Event');
      expect(entry.description).toBe('A plugin event for API endpoint testing');
    });
  });

  describe('GET /v1/notifications/channels/:id', () => {
    it('returns a single channel', async () => {
      db.insert(notificationChannels).values({
        name: 'Single',
        type: 'telegram',
        config: JSON.stringify({ botToken: '123', chatId: '-100' }),
        events: JSON.stringify(['apk:new-version']),
        enabled: true,
        createdAt: new Date(),
      }).run();
      const id = db.select().from(notificationChannels).all()[0].id;

      const res = await supertest(app).get(`/api/v1/notifications/channels/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Single');
      expect(res.body.data.config.botToken).toBe('123');
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await supertest(app).get('/api/v1/notifications/channels/999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/notifications/quiet-hours', () => {
    it('returns defaults when not configured', async () => {
      const res = await supertest(app).get('/api/v1/notifications/quiet-hours');
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.startTime).toBe('22:00');
      expect(res.body.data.endTime).toBe('08:00');
      expect(res.body.criticalEventTypes).toContain('automation:failure');
    });
  });

  describe('PUT /v1/notifications/quiet-hours', () => {
    it('saves quiet hours config', async () => {
      const config = {
        enabled: true,
        startTime: '23:00',
        endTime: '07:00',
        timezone: 'UTC',
        daysOfWeek: [1, 2, 3, 4, 5],
      };
      const res = await supertest(app)
        .put('/api/v1/notifications/quiet-hours')
        .send(config);
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.startTime).toBe('23:00');
      expect(res.body.data.daysOfWeek).toEqual([1, 2, 3, 4, 5]);

      // Verify persistence
      const get = await supertest(app).get('/api/v1/notifications/quiet-hours');
      expect(get.body.data.enabled).toBe(true);
      expect(get.body.data.startTime).toBe('23:00');
    });

    it('rejects invalid timezone', async () => {
      const res = await supertest(app)
        .put('/api/v1/notifications/quiet-hours')
        .send({
          enabled: true, startTime: '22:00', endTime: '08:00',
          timezone: 'Invalid/Zone', daysOfWeek: [0],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid timezone');
    });

    it('rejects bad time format', async () => {
      const res = await supertest(app)
        .put('/api/v1/notifications/quiet-hours')
        .send({
          enabled: true, startTime: '10pm', endTime: '08:00',
          timezone: 'UTC', daysOfWeek: [0],
        });
      expect(res.status).toBe(400);
    });

    it('rejects out-of-range time values', async () => {
      const res = await supertest(app)
        .put('/api/v1/notifications/quiet-hours')
        .send({
          enabled: true, startTime: '25:00', endTime: '08:00',
          timezone: 'UTC', daysOfWeek: [0],
        });
      expect(res.status).toBe(400);

      const res2 = await supertest(app)
        .put('/api/v1/notifications/quiet-hours')
        .send({
          enabled: true, startTime: '22:00', endTime: '08:61',
          timezone: 'UTC', daysOfWeek: [0],
        });
      expect(res2.status).toBe(400);
    });

    it('rejects invalid daysOfWeek', async () => {
      const res = await supertest(app)
        .put('/api/v1/notifications/quiet-hours')
        .send({
          enabled: true, startTime: '22:00', endTime: '08:00',
          timezone: 'UTC', daysOfWeek: [7],
        });
      expect(res.status).toBe(400);
    });
  });
});
