import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as schema from '../db/schema';
import { PythonBridgeManager } from './python-bridge';
import type { AppDatabase } from '../db/index';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { createTestDb } from '../test-utils/create-test-db';

// Mock fetch for health checks
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as any;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => {
    proc.emit('exit', 0);
  });
  proc.pid = 12345;
  return proc;
}

// Track spawned processes
let spawnCalls: any[] = [];

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => {
    spawnCalls.push(args);
    return createMockProcess();
  },
  execSync: (cmd: string) => {
    if (cmd.includes('--version')) return Buffer.from('Python 3.12.0');
    return Buffer.from('');
  },
  exec: (cmd: string, opts: any, cb?: Function) => {
    const callback = cb || opts;
    if (typeof callback === 'function') callback(null, '', '');
  },
  execFile: (_file: string, _args: string[], opts: any, cb?: Function) => {
    const callback = cb || opts;
    if (typeof callback === 'function') callback(null, '', '');
  },
}));

describe('PythonBridgeManager', () => {
  let db: AppDatabase;
  let manager: PythonBridgeManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new PythonBridgeManager(db);
    mockFetch.mockReset();
    spawnCalls = [];
  });

  afterEach(() => {
    manager.stopAll();
  });

  describe('getOrAllocatePort', () => {
    it('allocates port starting from 9100', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Test Device',
      }).run();

      const port = await manager.getOrAllocatePort('device-1');
      expect(port).toBe(9100);

      // Verify port is saved in DB
      const device = db.select().from(schema.devices).all()[0];
      expect(device.bridgePort).toBe(9100);
    });

    it('returns existing port if already allocated', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Test Device',
        bridgePort: 9150,
      }).run();

      const port = await manager.getOrAllocatePort('device-1');
      expect(port).toBe(9150);
    });

    it('allocates next available port when some are taken', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Device 1',
        bridgePort: 9100,
      }).run();
      db.insert(schema.devices).values({
        id: 'device-2',
        name: 'Device 2',
      }).run();

      const port = await manager.getOrAllocatePort('device-2');
      expect(port).toBe(9101);
    });
  });

  describe('getBridge', () => {
    it('spawns bridge process for new device', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Test Device',
      }).run();

      mockFetch.mockResolvedValue({ ok: true });

      const bridge = await manager.getBridge('device-1');
      expect(bridge.deviceId).toBe('device-1');
      expect(bridge.port).toBe(9100);
      expect(bridge.isRunning()).toBe(true);
      expect(spawnCalls).toHaveLength(1);
      // Windows venvs expose python.exe, POSIX ones python/python3 — match the
      // interpreter name with an optional extension rather than assuming POSIX.
      expect(spawnCalls[0][0]).toMatch(/python3?(\.exe)?$/);
      expect(spawnCalls[0][1]).toContain('--device');
    });

    it('returns existing bridge if running', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Test Device',
      }).run();

      mockFetch.mockResolvedValue({ ok: true });

      const bridge1 = await manager.getBridge('device-1');
      const bridge2 = await manager.getBridge('device-1');

      expect(bridge1).toBe(bridge2);
      expect(spawnCalls).toHaveLength(1);
    });

    it('throws when health check fails', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Test Device',
      }).run();

      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(manager.getBridge('device-1')).rejects.toThrow(
        /failed health check/,
      );
    }, 30000);
  });

  describe('stopBridge', () => {
    it('stops a running bridge', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Test Device',
      }).run();

      mockFetch.mockResolvedValue({ ok: true });

      const bridge = await manager.getBridge('device-1');
      expect(bridge.isRunning()).toBe(true);

      manager.stopBridge('device-1');
      expect(bridge.isRunning()).toBe(false);
    });

    it('does nothing for unknown device', () => {
      expect(() => manager.stopBridge('unknown')).not.toThrow();
    });
  });

  describe('stopAll', () => {
    it('stops all running bridges', async () => {
      db.insert(schema.devices).values({
        id: 'device-1',
        name: 'Device 1',
      }).run();
      db.insert(schema.devices).values({
        id: 'device-2',
        name: 'Device 2',
      }).run();

      mockFetch.mockResolvedValue({ ok: true });

      await manager.getBridge('device-1');
      await manager.getBridge('device-2');

      expect(manager.getRunningBridges().size).toBe(2);

      manager.stopAll();

      expect(manager.getRunningBridges().size).toBe(0);
    });
  });
});
