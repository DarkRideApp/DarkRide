import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerDeviceEndpoints } from './devices';
import type { DeviceManager, DeviceStatus } from '../services/device-manager';

function createMockDeviceManager(overrides: Partial<DeviceManager> = {}): DeviceManager {
  const defaultStatuses: DeviceStatus[] = [
    {
      id: 'DEV001',
      name: 'Pixel 6',
      platform: 'android',
      isRooted: true,
      setupVersion: 1,
      bridgePort: 9100,
      lastSeen: new Date(),
      batteryLevel: 85,
      needsSetup: false,
      isBusy: false,
      isOnline: true,
      manufacturer: 'Google',
      model: 'Pixel 6',
      androidVersion: '14',
      iosVersion: null,
      apiLevel: 34,
      cpuAbi: 'arm64-v8a',
      serialNumber: 'ABC123',
      bootloaderLocked: false,
    },
    {
      id: 'DEV002',
      name: 'Galaxy S22',
      platform: 'android',
      isRooted: false,
      setupVersion: 0,
      bridgePort: null,
      lastSeen: new Date(),
      batteryLevel: 45,
      needsSetup: true,
      isBusy: false,
      isOnline: false,
      manufacturer: 'Samsung',
      model: 'Galaxy S22',
      androidVersion: '13',
      iosVersion: null,
      apiLevel: 33,
      cpuAbi: 'arm64-v8a',
      serialNumber: 'DEF456',
      bootloaderLocked: true,
    },
  ];

  return {
    getAllDeviceStatuses: vi.fn().mockResolvedValue(defaultStatuses),
    getDeviceStatus: vi.fn().mockImplementation(async (id: string) => {
      return defaultStatuses.find((d) => d.id === id) ?? null;
    }),
    performSetup: vi.fn().mockResolvedValue(undefined),
    runDeviceCommand: vi.fn().mockResolvedValue(undefined),
    takeScreenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
    executeShellCommand: vi.fn().mockResolvedValue('shell output'),
    recordInteraction: vi.fn(),
    collectDeviceProperties: vi.fn().mockResolvedValue(undefined),
    checkRooted: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as DeviceManager;
}

function createMockDb(): any {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          run: vi.fn(),
        }),
      }),
    }),
  };
}

function createTestApp(deviceManager: DeviceManager, db?: any) {
  clearEndpoints();
  registerDeviceEndpoints(deviceManager, db);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Device API', () => {
  let mockManager: DeviceManager;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    mockManager = createMockDeviceManager();
    app = createTestApp(mockManager);
  });

  describe('GET /v1/device/list', () => {
    it('should return list of all devices', async () => {
      const res = await request(app).get('/v1/device/list');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].id).toBe('DEV001');
      expect(res.body.data[1].id).toBe('DEV002');
    });

    it('should return 500 on error', async () => {
      mockManager = createMockDeviceManager({
        getAllDeviceStatuses: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      app = createTestApp(mockManager);

      const res = await request(app).get('/v1/device/list');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/device/view/:id', () => {
    it('should return device details', async () => {
      const res = await request(app).get('/v1/device/view/DEV001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('DEV001');
      expect(res.body.data.isRooted).toBe(true);
      expect(res.body.data.batteryLevel).toBe(85);
    });

    it('should return 404 for unknown device', async () => {
      const res = await request(app).get('/v1/device/view/UNKNOWN');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Device not found');
    });
  });

  describe('PUT /v1/device/:id', () => {
    it('should update device name successfully', async () => {
      const mockDb = createMockDb();
      const baseProps = { manufacturer: 'Google', model: 'Pixel 6', androidVersion: '14', apiLevel: 34, cpuAbi: 'arm64-v8a', serialNumber: 'ABC123', bootloaderLocked: false };
      const updatedStatus = {
        id: 'DEV001',
        name: 'Living Room Phone',
        isRooted: true,
        setupVersion: 1,
        bridgePort: 9100,
        lastSeen: new Date(),
        batteryLevel: 85,
        needsSetup: false,
        isBusy: false,
        isOnline: true,
        ...baseProps,
      };
      const mgr = createMockDeviceManager({
        getDeviceStatus: vi.fn()
          .mockResolvedValueOnce({ id: 'DEV001', name: 'Pixel 6', isRooted: true, setupVersion: 1, bridgePort: 9100, lastSeen: new Date(), batteryLevel: 85, needsSetup: false, isBusy: false, isOnline: true, ...baseProps })
          .mockResolvedValueOnce(updatedStatus),
      });
      const testApp = createTestApp(mgr, mockDb);

      const res = await request(testApp)
        .put('/v1/device/DEV001')
        .send({ name: 'Living Room Phone' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Living Room Phone');
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should return 404 for unknown device', async () => {
      const mockDb = createMockDb();
      const testApp = createTestApp(mockManager, mockDb);

      const res = await request(testApp)
        .put('/v1/device/UNKNOWN')
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Device not found');
    });

    it('should set name to null for empty string', async () => {
      const mockDb = createMockDb();
      const mgr = createMockDeviceManager();
      const testApp = createTestApp(mgr, mockDb);

      const res = await request(testApp)
        .put('/v1/device/DEV001')
        .send({ name: '' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should reject non-string name', async () => {
      const mockDb = createMockDb();
      const testApp = createTestApp(mockManager, mockDb);

      const res = await request(testApp)
        .put('/v1/device/DEV001')
        .send({ name: 123 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('name must be a string');
    });

    it('should return 500 when db is not available', async () => {
      const testApp = createTestApp(mockManager); // no db

      const res = await request(testApp)
        .put('/v1/device/DEV001')
        .send({ name: 'Test' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Database not available');
    });
  });

  describe('POST /v1/device/setup/:id', () => {
    it('should trigger setup for an online device', async () => {
      const res = await request(app).post('/v1/device/setup/DEV001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockManager.performSetup).toHaveBeenCalledWith('DEV001');
    });

    it('should return 404 for unknown device', async () => {
      const res = await request(app).post('/v1/device/setup/UNKNOWN');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for offline device', async () => {
      const res = await request(app).post('/v1/device/setup/DEV002');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Device is offline');
    });
  });

  describe('POST /v1/device/command/:id', () => {
    it('should run restart command', async () => {
      const res = await request(app)
        .post('/v1/device/command/DEV001')
        .send({ command: 'restart' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.command).toBe('restart');
      expect(mockManager.runDeviceCommand).toHaveBeenCalledWith('DEV001', 'restart');
    });

    it('should run sleep command', async () => {
      const res = await request(app)
        .post('/v1/device/command/DEV001')
        .send({ command: 'sleep' });
      expect(res.status).toBe(200);
      expect(mockManager.runDeviceCommand).toHaveBeenCalledWith('DEV001', 'sleep');
    });

    it('should run wake command', async () => {
      const res = await request(app)
        .post('/v1/device/command/DEV001')
        .send({ command: 'wake' });
      expect(res.status).toBe(200);
      expect(mockManager.runDeviceCommand).toHaveBeenCalledWith('DEV001', 'wake');
    });

    it('should reject invalid command', async () => {
      const res = await request(app)
        .post('/v1/device/command/DEV001')
        .send({ command: 'format' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid command');
    });

    it('should reject missing command', async () => {
      const res = await request(app)
        .post('/v1/device/command/DEV001')
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 404 for unknown device', async () => {
      const res = await request(app)
        .post('/v1/device/command/UNKNOWN')
        .send({ command: 'wake' });
      expect(res.status).toBe(404);
    });

    it('should return 400 for offline device', async () => {
      const res = await request(app)
        .post('/v1/device/command/DEV002')
        .send({ command: 'wake' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Device is offline');
    });
  });

  describe('GET /v1/device/screenshot/:id', () => {
    it('should return screenshot as base64', async () => {
      const res = await request(app).get('/v1/device/screenshot/DEV001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deviceId).toBe('DEV001');
      expect(res.body.data.image).toBe(Buffer.from('fake-png-data').toString('base64'));
    });

    it('should return 404 for unknown device', async () => {
      const res = await request(app).get('/v1/device/screenshot/UNKNOWN');
      expect(res.status).toBe(404);
    });

    it('should return 400 for offline device', async () => {
      const res = await request(app).get('/v1/device/screenshot/DEV002');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Device is offline');
    });
  });

  describe('POST /v1/device/shell/:id', () => {
    it('should execute shell command and return output', async () => {
      const res = await request(app)
        .post('/v1/device/shell/DEV001')
        .send({ command: 'ls /sdcard' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.output).toBe('shell output');
      expect(mockManager.executeShellCommand).toHaveBeenCalledWith('DEV001', 'ls /sdcard');
    });

    it('should reject missing command', async () => {
      const res = await request(app)
        .post('/v1/device/shell/DEV001')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing or invalid command');
    });

    it('should reject non-string command', async () => {
      const res = await request(app)
        .post('/v1/device/shell/DEV001')
        .send({ command: 123 });
      expect(res.status).toBe(400);
    });

    it('should return 404 for unknown device', async () => {
      const res = await request(app)
        .post('/v1/device/shell/UNKNOWN')
        .send({ command: 'ls' });
      expect(res.status).toBe(404);
    });

    it('should return 400 for offline device', async () => {
      const res = await request(app)
        .post('/v1/device/shell/DEV002')
        .send({ command: 'ls' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/device/reprobe/:id', () => {
    it('should reprobe device properties', async () => {
      const mockDb = createMockDb();
      const testApp = createTestApp(mockManager, mockDb);

      const res = await request(testApp).post('/v1/device/reprobe/DEV001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('DEV001');
      expect(mockManager.collectDeviceProperties).toHaveBeenCalledWith('DEV001');
      expect(mockManager.checkRooted).toHaveBeenCalledWith('DEV001');
    });

    it('should return 404 for unknown device', async () => {
      const mockDb = createMockDb();
      const testApp = createTestApp(mockManager, mockDb);

      const res = await request(testApp).post('/v1/device/reprobe/UNKNOWN');
      expect(res.status).toBe(404);
    });

    it('should return 400 for offline device', async () => {
      const mockDb = createMockDb();
      const testApp = createTestApp(mockManager, mockDb);

      const res = await request(testApp).post('/v1/device/reprobe/DEV002');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Device is offline');
    });
  });

  describe('GET /v1/device/dom/:id', () => {
    it('should capture DOM via direct ADB uiautomator dump', async () => {
      vi.mocked(mockManager.executeShellCommand).mockImplementation(async (_id, cmd) => {
        if (cmd.startsWith('uiautomator dump')) return 'UI hierarchy dumped to: /sdcard/darkride_dom.xml';
        if (cmd.startsWith('cat ')) return '<?xml version="1.0"?><hierarchy><node /></hierarchy>';
        return '';
      });
      const res = await request(app).get('/v1/device/dom/DEV001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deviceId).toBe('DEV001');
      expect(res.body.data.dom).toContain('<hierarchy');
      expect(mockManager.executeShellCommand).toHaveBeenCalled();
    });

    it('should return 404 for unknown device', async () => {
      const res = await request(app).get('/v1/device/dom/UNKNOWN');
      expect(res.status).toBe(404);
    });

    it('should return 400 for offline device', async () => {
      const res = await request(app).get('/v1/device/dom/DEV002');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Device is offline');
    });
  });
});
