import { describe, it, expect, beforeEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { createTestDb } from '../test-utils/create-test-db';

const {
  proxies,
  devices,
  automations,
  automationSessions,
  screenshots,
  capturedTraffic,
} = schema;

describe('Database Schema', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('proxies', () => {
    it('should insert and retrieve a proxy', () => {
      const now = new Date();
      db.insert(proxies).values({
        url: 'http://proxy.example.com:8080',
        username: 'user',
        password: 'pass',
        createdAt: now,
      }).run();

      const result = db.select().from(proxies).all();
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('http://proxy.example.com:8080');
      expect(result[0].username).toBe('user');
      expect(result[0].password).toBe('pass');
      expect(result[0].failureCount).toBe(0);
      expect(result[0].enabled).toBe(true);
    });

    it('should use default values for failureCount and enabled', () => {
      db.insert(proxies).values({
        url: 'http://proxy2.example.com:8080',
        createdAt: new Date(),
      }).run();

      const result = db.select().from(proxies).all();
      expect(result[0].failureCount).toBe(0);
      expect(result[0].enabled).toBe(true);
    });

    it('should update proxy fields', () => {
      db.insert(proxies).values({
        url: 'http://proxy.example.com:8080',
        createdAt: new Date(),
      }).run();

      db.update(proxies)
        .set({ failureCount: 5, enabled: false })
        .where(eq(proxies.id, 1))
        .run();

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(5);
      expect(result[0].enabled).toBe(false);
    });
  });

  describe('devices', () => {
    it('should insert and retrieve a device with text PK', () => {
      db.insert(devices).values({
        id: 'ABCDEF123456',
        name: 'Pixel 6',
      }).run();

      const result = db.select().from(devices).where(eq(devices.id, 'ABCDEF123456')).all();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Pixel 6');
      expect(result[0].isRooted).toBe(false);
      expect(result[0].setupVersion).toBe(0);
      expect(result[0].bridgePort).toBeNull();
    });

    it('should store bridge port assignment', () => {
      db.insert(devices).values({
        id: 'DEV001',
        name: 'Galaxy S22',
        bridgePort: 9100,
      }).run();

      const result = db.select().from(devices).where(eq(devices.id, 'DEV001')).all();
      expect(result[0].bridgePort).toBe(9100);
    });
  });

  describe('automations', () => {
    it('should insert and retrieve an automation', () => {
      const now = new Date();
      db.insert(automations).values({
        name: 'Test Automation',
        code: 'export default async function(device) { await device.click({ text: "OK" }); }',
        passcode: 'abc123',
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(automations).all();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Automation');
      expect(result[0].requiresHttpsCapture).toBe(false);
      expect(result[0].timeoutMs).toBe(300000);
      expect(result[0].isRule).toBe(false);
      expect(result[0].priority).toBe(0);
    });

    it('should support rule automations with priority', () => {
      const now = new Date();
      db.insert(automations).values({
        name: 'Cookie Accept Rule',
        code: 'export default async function(device) {}',
        passcode: 'rule123',
        isRule: true,
        priority: 10,
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(automations).all();
      expect(result[0].isRule).toBe(true);
      expect(result[0].priority).toBe(10);
    });
  });

  describe('automationSessions', () => {
    it('should insert a session with FK references', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();
      db.insert(automations).values({
        name: 'Auto',
        code: 'code',
        passcode: 'pass',
        createdAt: now,
        updatedAt: now,
      }).run();

      db.insert(automationSessions).values({
        automationId: 1,
        deviceId: 'DEV001',
        status: 'running',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const result = db.select().from(automationSessions).all();
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('running');
      expect(result[0].triggerType).toBe('manual');
      expect(result[0].completedAt).toBeNull();
    });

    it('should update session status on completion', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();
      db.insert(automations).values({
        name: 'Auto',
        code: 'code',
        passcode: 'pass',
        createdAt: now,
        updatedAt: now,
      }).run();
      db.insert(automationSessions).values({
        automationId: 1,
        deviceId: 'DEV001',
        status: 'running',
        triggerType: 'schedule',
        startedAt: now,
      }).run();

      const completedAt = new Date();
      db.update(automationSessions)
        .set({ status: 'success', completedAt, logs: 'All steps passed' })
        .where(eq(automationSessions.id, 1))
        .run();

      const result = db.select().from(automationSessions).where(eq(automationSessions.id, 1)).all();
      expect(result[0].status).toBe('success');
      expect(result[0].logs).toBe('All steps passed');
      expect(result[0].completedAt).not.toBeNull();
    });
  });

  describe('screenshots', () => {
    it('should insert and retrieve a screenshot', () => {
      const now = new Date();
      db.insert(screenshots).values({
        filename: 'screenshot-001.png',
        name: 'Login Screen',
        domSnapshot: '<hierarchy>...</hierarchy>',
        capturedAt: now,
      }).run();

      const result = db.select().from(screenshots).all();
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('screenshot-001.png');
      expect(result[0].name).toBe('Login Screen');
      expect(result[0].domSnapshot).toBe('<hierarchy>...</hierarchy>');
    });
  });

  describe('capturedTraffic', () => {
    it('should insert and retrieve traffic entries', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();

      db.insert(capturedTraffic).values({
        deviceId: 'DEV001',
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        requestHeaders: JSON.stringify({ 'Content-Type': 'application/json' }),
        responseStatus: 200,
        responseBody: '{"ok": true}',
        capturedAt: now,
      }).run();

      const result = db.select().from(capturedTraffic).all();
      expect(result).toHaveLength(1);
      expect(result[0].requestMethod).toBe('GET');
      expect(result[0].requestUrl).toBe('https://api.example.com/data');
      expect(result[0].responseStatus).toBe(200);
    });

    it('should allow nullable sessionId', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();

      db.insert(capturedTraffic).values({
        deviceId: 'DEV001',
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/submit',
        capturedAt: now,
      }).run();

      const result = db.select().from(capturedTraffic).all();
      expect(result[0].sessionId).toBeNull();
    });
  });

  describe('delete operations', () => {
    it('should delete records correctly', () => {
      db.insert(proxies).values({
        url: 'http://proxy.example.com:8080',
        createdAt: new Date(),
      }).run();

      expect(db.select().from(proxies).all()).toHaveLength(1);

      db.delete(proxies).where(eq(proxies.id, 1)).run();

      expect(db.select().from(proxies).all()).toHaveLength(0);
    });
  });
});
