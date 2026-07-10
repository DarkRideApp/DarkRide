import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { createTestDb } from '../../test-utils/create-test-db';
import { getApiRouter, clearEndpoints } from '../api-service';
import { registerAutomationEndpoints } from '../automations';
import { registerNotificationEndpoints } from '../notifications';
import { registerDevicesProvidersEndpoints } from '../devices-providers';
import { DeviceInstancesRepo } from '../../services/device-instances-repo';

const { automations, automationSessions, notificationChannels, notificationHistory, deviceInstances, devices } = schema;

// These endpoints all delete a parent row whose children FK-reference it with
// NO onDelete: 'cascade'. With foreign_keys=ON (prod default, backend/db/index.ts:22)
// a delete that leaves those children behind throws FOREIGN KEY constraint failed
// and aborts — the row survives while the UI toasts success. Each test seeds the
// "has been used" state that makes the child rows exist, then asserts the delete
// succeeds and actually removes the parent.

function mountRouter(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('DELETE endpoints clean up non-cascading FK children', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDb(undefined, { foreignKeys: true });
    clearEndpoints();
  });

  it('DELETE /v1/automation/delete/:id removes an automation that has run sessions', async () => {
    registerAutomationEndpoints(
      db,
      {} as any,
      {} as any,
      { removeSchedule: () => {} } as any,
    );
    const app = mountRouter();

    db.insert(automations).values({ id: 1, name: 'A', code: 'c', passcode: 'p', isCaptureRule: false, createdAt: new Date(), updatedAt: new Date() }).run();
    // A completed run leaves an automation_sessions row referencing the automation.
    db.insert(automationSessions).values({ automationId: 1, status: 'success', triggerType: 'manual', startedAt: new Date() }).run();

    const res = await request(app).delete('/v1/automation/delete/1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.select().from(automations).where(eq(automations.id, 1)).all()).toHaveLength(0);
    // Session history is preserved but disassociated (automationId nulled).
    const sessions = db.select().from(automationSessions).all();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].automationId).toBeNull();
  });

  it('DELETE /v1/notifications/channels/:id removes a channel that has fired notifications', async () => {
    registerNotificationEndpoints(db, {} as any);
    const app = mountRouter();

    db.insert(notificationChannels).values({ id: 1, name: 'Discord', type: 'discord', config: '{}', events: '[]', createdAt: new Date() }).run();
    // Every send/test writes a notification_history row referencing the channel.
    db.insert(notificationHistory).values({ channelId: 1, channelName: 'Discord', eventType: 'test', title: 'hi', createdAt: new Date() }).run();

    const res = await request(app).delete('/v1/notifications/channels/1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.select().from(notificationChannels).where(eq(notificationChannels.id, 1)).all()).toHaveLength(0);
    // History row survives (readable via channelName) with channelId nulled.
    const history = db.select().from(notificationHistory).all();
    expect(history).toHaveLength(1);
    expect(history[0].channelId).toBeNull();
    expect(history[0].channelName).toBe('Discord');
  });

  it('DELETE /v1/devices/providers/:id/instances/:instId removes an instance a device row points at', async () => {
    const repo = new DeviceInstancesRepo(db);
    const provider = { id: 'docker-android', deleteInstance: async () => {} };
    const registry = { get: (id: string) => (id === 'docker-android' ? provider : undefined) } as any;
    registerDevicesProvidersEndpoints(registry, repo, db, { adbDisconnect: async () => {} });
    const app = mountRouter();

    db.insert(deviceInstances).values({ id: 5, providerId: 'docker-android', runtimeId: 'container-abc', serial: 'localhost:5555', state: 'running', createdAt: new Date(), lastStateAt: new Date() }).run();
    // The booted emulator was matched to an adb devices row linked via instance_id.
    db.insert(devices).values({ id: 'localhost:5555', name: 'Emu', instanceId: 5 }).run();

    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/5');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.select().from(deviceInstances).where(eq(deviceInstances.id, 5)).all()).toHaveLength(0);
    // The stale device row was cleaned up (forgetDeviceRow deletes it).
    expect(db.select().from(devices).where(eq(devices.id, 'localhost:5555')).all()).toHaveLength(0);
  });

  it('deletes an instance that was STOPPED first (serial nulled) but still has a device row', async () => {
    const repo = new DeviceInstancesRepo(db);
    const provider = { id: 'docker-android', deleteInstance: async () => {} };
    const registry = { get: (id: string) => (id === 'docker-android' ? provider : undefined) } as any;
    registerDevicesProvidersEndpoints(registry, repo, db, { adbDisconnect: async () => {} });
    const app = mountRouter();

    // Post-stop state: the stop endpoint nulls device_instances.serial, but the
    // adb-discovered devices row keeps its instance_id. A serial-keyed cleanup
    // would skip it and the FK would throw on delete.
    db.insert(deviceInstances).values({ id: 6, providerId: 'docker-android', runtimeId: 'container-xyz', serial: null, state: 'stopped', createdAt: new Date(), lastStateAt: new Date() }).run();
    db.insert(devices).values({ id: 'localhost:5556', name: 'Emu', instanceId: 6 }).run();

    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/6');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.select().from(deviceInstances).where(eq(deviceInstances.id, 6)).all()).toHaveLength(0);
    expect(db.select().from(devices).where(eq(devices.id, 'localhost:5556')).all()).toHaveLength(0);
  });
});
