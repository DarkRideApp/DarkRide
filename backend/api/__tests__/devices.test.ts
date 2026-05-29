import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { applyMigrations } from '../../test-utils/create-test-db';
import * as schema from '../../db/schema';
import { registerDeviceEndpoints } from '../devices';
import { clearEndpoints, getApiRouter } from '../api-service';

const { devices, automationSessions, capturedTraffic, websocketMessages } = schema;

/**
 * Spin up a real SQLite DB with the full migration history applied so
 * FK constraints behave like production. Returns a Drizzle handle and
 * the underlying better-sqlite3 instance (for raw assertions).
 */
function makeRealDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeApp(db: any) {
  clearEndpoints();
  // The DELETE handler only needs `db`; getAllDeviceStatuses etc. are not
  // exercised here. A minimal stub keeps the rest of registerDeviceEndpoints
  // happy without spinning up the full DeviceManager.
  const deviceManager: any = {
    getAllDeviceStatuses: vi.fn().mockResolvedValue([]),
    getDeviceStatus: vi.fn().mockResolvedValue(null),
  };
  registerDeviceEndpoints(deviceManager, db);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('DELETE /v1/device/:id (forget)', () => {
  beforeEach(() => clearEndpoints());

  it('removes the row when no FK references exist', async () => {
    const { db } = makeRealDb();
    db.insert(devices).values({
      id: 'localhost:32770',
      name: 'old-emulator',
      platform: 'android',
      isRooted: false,
      setupVersion: 0,
      lastSeen: new Date(),
    } as any).run();

    const res = await request(makeApp(db)).delete('/v1/device/localhost%3A32770');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const remaining = db.select().from(devices).where(eq(devices.id, 'localhost:32770')).all();
    expect(remaining).toEqual([]);
  });

  it('preserves historical rows by nulling device_id (does NOT throw FOREIGN KEY constraint failed)', async () => {
    // Regression for the user-reported error:
    //   [devices-api] Failed to forget device 37c254e7: FOREIGN KEY constraint failed
    // captured_traffic, automation_sessions, and websocket_messages all
    // hold device_id FKs with no ON DELETE clause — SQLite's default
    // NO ACTION rejected the delete. The handler now NULLs those refs
    // in a transaction so the history survives.
    const { db } = makeRealDb();
    const now = new Date();

    db.insert(devices).values({
      id: '37c254e7', name: 'old-phone', platform: 'android',
      isRooted: false, setupVersion: 0, lastSeen: now,
    } as any).run();

    const sessionId = (db.insert(automationSessions).values({
      deviceId: '37c254e7', status: 'success', triggerType: 'manual',
      startedAt: now, completedAt: now,
    } as any).returning({ id: automationSessions.id }).all())[0].id;

    const trafficId = (db.insert(capturedTraffic).values({
      sessionId, deviceId: '37c254e7', requestMethod: 'GET',
      requestUrl: 'https://example.com', capturedAt: now,
    } as any).returning({ id: capturedTraffic.id }).all())[0].id;

    db.insert(websocketMessages).values({
      trafficId, sessionId, deviceId: '37c254e7',
      direction: 'send', opcode: 'text', payload: 'ping',
      timestamp: now,
    } as any).run();

    const res = await request(makeApp(db)).delete('/v1/device/37c254e7');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Device row gone.
    expect(db.select().from(devices).where(eq(devices.id, '37c254e7')).all()).toEqual([]);

    // Historical rows survive with device_id nulled out.
    const sess = db.select().from(automationSessions).where(eq(automationSessions.id, sessionId)).all()[0];
    expect(sess).toBeDefined();
    expect(sess.deviceId).toBeNull();

    const traf = db.select().from(capturedTraffic).where(eq(capturedTraffic.id, trafficId)).all()[0];
    expect(traf).toBeDefined();
    expect(traf.deviceId).toBeNull();
    expect(traf.requestUrl).toBe('https://example.com'); // payload intact

    const wsm = db.select().from(websocketMessages).all();
    expect(wsm).toHaveLength(1);
    expect(wsm[0].deviceId).toBeNull();
    expect(wsm[0].payload).toBe('ping');
  });

  it('returns 404 for an unknown device id', async () => {
    const { db } = makeRealDb();
    const res = await request(makeApp(db)).delete('/v1/device/never-existed');
    expect(res.status).toBe(404);
  });
});
