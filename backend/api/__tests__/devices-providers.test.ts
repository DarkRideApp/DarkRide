import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerDevicesProvidersEndpoints } from '../devices-providers';
import { clearEndpoints, getApiRouter } from '../api-service';

function createApp(registry: any, repo: any, db?: any, deps?: any) {
  clearEndpoints();
  // Default to a no-op adb disconnect so unit tests never shell out to a real
  // `adb` binary. Tests that assert on the disconnect pass their own mock.
  registerDevicesProvidersEndpoints(
    registry,
    repo,
    db,
    deps ?? { adbDisconnect: vi.fn().mockResolvedValue(undefined) },
  );
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('/v1/devices/providers endpoints', () => {
  beforeEach(() => clearEndpoints());

  it('GET /v1/devices/providers returns all registered providers + availability', async () => {
    const reg = {
      list: () => [
        { id: 'docker-android', displayName: 'Docker Android', isAvailable: vi.fn().mockResolvedValue({ available: true }), createInstance: () => {}, getCreateFormSchema: () => Promise.resolve({ fields: [] }) },
        { id: 'avd', displayName: 'AVD', isAvailable: vi.fn().mockResolvedValue({ available: false, installHint: 'install android-sdk' }) },
      ],
    };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.providers).toEqual([
      { id: 'docker-android', displayName: 'Docker Android', available: true, installHint: undefined, capabilities: { canCreate: true } },
      { id: 'avd', displayName: 'AVD', available: false, installHint: 'install android-sdk', capabilities: { canCreate: false } },
    ]);
  });

  it('GET /v1/devices/providers/:id/create-form returns the schema', async () => {
    const schema = { fields: [{ key: 'androidVersion', label: 'Android version', type: 'string' }] };
    const reg = {
      get: () => ({ getCreateFormSchema: vi.fn().mockResolvedValue(schema) }),
    };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers/docker-android/create-form');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(schema);
  });

  it('GET on an unknown provider id returns 404', async () => {
    const reg = { get: () => undefined };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers/nope/create-form');
    expect(res.status).toBe(404);
  });

  it('POST /v1/devices/providers/:id/instances returns immediately in `pulling` state; provider.createInstance runs in background', async () => {
    let resolveCreate!: (v: any) => void;
    const createInstance = vi.fn().mockReturnValue(new Promise((r) => { resolveCreate = r; }));
    const reg = { get: () => ({ createInstance }) };
    const repo = {
      insert: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: '', state: 'pulling' }),
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: '', state: 'pulling' }),
      updateRuntimeId: vi.fn(),
      updateState: vi.fn(),
      // The endpoint touches `(repo as any).db` to set spawnMetadata; provide
      // a chainable stub so the call doesn't crash the background task.
      db: { update: () => ({ set: () => ({ where: () => ({ run: vi.fn() }) }) }) },
    };
    const app = createApp(reg, repo);
    const res = await request(app)
      .post('/v1/devices/providers/docker-android/instances')
      .send({ displayName: 'test', config: { androidVersion: '14' } });
    expect(res.status).toBe(200);
    expect(res.body.data.instance).toMatchObject({ id: 99, state: 'pulling' });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'docker-android',
      runtimeId: '',
      state: 'pulling',
    }));
    // Provider.createInstance was invoked but the HTTP response didn't
    // wait for it.
    expect(createInstance).toHaveBeenCalled();
    // Resolve the background promise so the test's unhandled-rejection
    // tracker doesn't fire.
    resolveCreate({ id: 'inst-1', displayName: 'test', state: 'created', spawnedByDarkride: true });
    await new Promise((r) => setImmediate(r));
  });

  it('POST .../start delegates to provider.startInstance + updates state + persists serial', async () => {
    const start = vi.fn().mockResolvedValue({ id: 'inst-1', serial: 'localhost:6001' });
    const reg = { get: () => ({ startInstance: start }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1' }),
      updateState: vi.fn(),
      updateSerial: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/start');
    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith('inst-1');
    expect(repo.updateState).toHaveBeenCalledWith(99, 'running');
    // CaptureSessionManager uses the serial column to find which provider
    // spawned a device; persist it as soon as startInstance resolves.
    expect(repo.updateSerial).toHaveBeenCalledWith(99, 'localhost:6001');
  });

  it('POST .../start records last_error when provider throws', async () => {
    const start = vi.fn().mockRejectedValue(new Error('boot timeout'));
    const reg = { get: () => ({ startInstance: start }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1' }),
      updateState: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/start');
    expect(res.status).toBe(500);
    expect(repo.updateState).toHaveBeenCalledWith(99, 'error', expect.stringContaining('boot timeout'));
  });

  it('DELETE removes the instance', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ deleteInstance: remove }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1', state: 'stopped' }),
      delete: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/99');
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith('inst-1');
    expect(repo.delete).toHaveBeenCalledWith(99);
  });

  it('DELETE also drops the stale devices row matching the instance serial', async () => {
    // Regression for the post-delete UX glitch: after deleting an emulator
    // the container is gone but the adb-seeded devices row stayed around
    // for ~2 minutes (until lastSeen aged out), shown as an unactionable
    // "online" device card (no Forget button because online + no backing
    // instance, no Stop/Delete because no backing instance).
    const sqlite = new (await import('better-sqlite3')).default(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const { applyMigrations } = await import('../../test-utils/create-test-db');
    applyMigrations(sqlite);
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('../../db/schema');
    const db = drizzle(sqlite, { schema }) as any;
    db.insert(schema.devices).values({
      id: 'localhost:32768', name: 'pixel-emu', platform: 'android',
      isRooted: true, setupVersion: 0, lastSeen: new Date(),
    } as any).run();

    const remove = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ deleteInstance: remove }) };
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 7, providerId: 'docker-android', runtimeId: 'inst-1',
        state: 'running', serial: 'localhost:32768',
      }),
      delete: vi.fn(),
    };
    clearEndpoints();
    const adbDisconnect = vi.fn().mockResolvedValue(undefined);
    registerDevicesProvidersEndpoints(reg as any, repo as any, db, { adbDisconnect });
    const app = express();
    app.use(express.json());
    app.use(getApiRouter());

    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/7');
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith('inst-1');

    // The orphaned device row should be gone.
    const { eq } = await import('drizzle-orm');
    const rows = db.select().from(schema.devices).where(eq(schema.devices.id, 'localhost:32768')).all();
    expect(rows).toEqual([]);
  });

  it('DELETE drops the stale adb endpoint so the poller cannot resurrect it', async () => {
    // Root cause of the "deleted emulator reappears as an adb device" bug:
    // nothing ran `adb disconnect`, so the adb server kept tracking
    // localhost:<port> and pollAdbDevices re-inserted an orphaned devices row.
    const remove = vi.fn().mockResolvedValue(undefined);
    const adbDisconnect = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ deleteInstance: remove }) };
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 99, providerId: 'docker-android', runtimeId: 'inst-1',
        state: 'stopped', serial: 'localhost:32768',
      }),
      delete: vi.fn(),
    };
    const app = createApp(reg, repo, undefined, { adbDisconnect });
    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/99');
    expect(res.status).toBe(200);
    expect(adbDisconnect).toHaveBeenCalledWith('localhost:32768');
  });

  it('STOP drops the adb endpoint so the stopped emulator leaves adb devices', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const adbDisconnect = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ stopInstance: stop }) };
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 99, providerId: 'docker-android', runtimeId: 'inst-1',
        state: 'running', serial: 'localhost:32768',
      }),
      updateState: vi.fn(),
      updateSerial: vi.fn(),
    };
    const app = createApp(reg, repo, undefined, { adbDisconnect });
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/stop');
    expect(res.status).toBe(200);
    expect(stop).toHaveBeenCalledWith('inst-1');
    expect(adbDisconnect).toHaveBeenCalledWith('localhost:32768');
    // H3: serial cleared so a recycled host port can't resurface this dead row.
    expect(repo.updateSerial).toHaveBeenCalledWith(99, null);
    expect(repo.updateState).toHaveBeenCalledWith(99, 'stopped');
  });

  it('non-network serials (e.g. iOS UDID) are left alone — no spurious adb disconnect', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const adbDisconnect = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ stopInstance: stop }) };
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 99, providerId: 'ios-device', runtimeId: 'inst-1',
        state: 'running', serial: '00008110-000A1B2C3D4E801E',
      }),
      updateState: vi.fn(),
      updateSerial: vi.fn(),
    };
    const app = createApp(reg, repo, undefined, { adbDisconnect });
    const res = await request(app).post('/v1/devices/providers/ios-device/instances/99/stop');
    expect(res.status).toBe(200);
    expect(adbDisconnect).not.toHaveBeenCalled();
  });

  it('recreate-on-start tears down the old adb endpoint + devices row before rebuilding', async () => {
    // The auto-recreate path (budtmo can't `docker start` an exited container)
    // builds a fresh container that may bind a different host port. If the old
    // localhost:<port> endpoint + its devices row survive, the recreated
    // emulator's detail page can resolve to that orphan (→ scrcpy) instead of
    // the new webrtc-capable docker-android instance.
    const sqlite = new (await import('better-sqlite3')).default(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const { applyMigrations } = await import('../../test-utils/create-test-db');
    applyMigrations(sqlite);
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('../../db/schema');
    const db = drizzle(sqlite, { schema }) as any;
    db.insert(schema.devices).values({
      id: 'localhost:32768', name: 'pixel-emu', platform: 'android',
      isRooted: true, setupVersion: 0, lastSeen: new Date(),
    } as any).run();

    const adbDisconnect = vi.fn().mockResolvedValue(undefined);
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const createInstance = vi.fn().mockResolvedValue({ id: 'inst-2', state: 'created' });
    const startInstance = vi.fn().mockResolvedValue({ id: 'inst-2', serial: 'localhost:32770' });
    const reg = { get: () => ({ deleteInstance, createInstance, startInstance }) };
    const repo = {
      getById: vi.fn().mockReturnValue({
        id: 7, providerId: 'docker-android', runtimeId: 'inst-1',
        state: 'stopped', serial: 'localhost:32768', spawnMetadata: { androidVersion: '14' },
        displayName: 'pixel-emu',
      }),
      updateState: vi.fn(),
      updateSerial: vi.fn(),
      updateRuntimeId: vi.fn(),
    };
    const app = createApp(reg, repo, db, { adbDisconnect });

    const res = await request(app).post('/v1/devices/providers/docker-android/instances/7/start');
    expect(res.status).toBe(200);
    // Old endpoint disconnected, old devices row forgotten, stale serial cleared.
    expect(adbDisconnect).toHaveBeenCalledWith('localhost:32768');
    expect(repo.updateSerial).toHaveBeenCalledWith(7, null);
    const { eq } = await import('drizzle-orm');
    const rows = db.select().from(schema.devices).where(eq(schema.devices.id, 'localhost:32768')).all();
    expect(rows).toEqual([]);
    // …then the fresh container is built and its new serial persisted.
    expect(deleteInstance).toHaveBeenCalledWith('inst-1');
    expect(createInstance).toHaveBeenCalled();
    expect(repo.updateRuntimeId).toHaveBeenCalledWith(7, 'inst-2');
    expect(repo.updateSerial).toHaveBeenCalledWith(7, 'localhost:32770');
    expect(repo.updateState).toHaveBeenCalledWith(7, 'running');
  });
});
