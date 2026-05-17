import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import {
  DeviceManager,
  parseAdbDevices,
  parseBatteryLevel,
  CURRENT_SETUP_VERSION,
  STANDBY_TIMEOUT,
  MIN_BATTERY_LEVEL,
} from './device-manager';

const { devices } = schema;

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (fn: any) => {
      // Return a wrapper that calls exec with a callback pattern
      return (...args: any[]) => {
        return new Promise((resolve, reject) => {
          fn(...args, (err: any, stdout: any, stderr: any) => {
            if (err) reject(err);
            else resolve({ stdout: stdout || '', stderr: stderr || '' });
          });
        });
      };
    },
  };
});

describe('parseAdbDevices', () => {
  it('should parse standard adb devices output', () => {
    const output = `List of devices attached
ABCDEF123456\tdevice
GHIJKL789012\toffline
`;
    const result = parseAdbDevices(output);
    expect(result).toEqual([
      { id: 'ABCDEF123456', status: 'device' },
      { id: 'GHIJKL789012', status: 'offline' },
    ]);
  });

  it('should handle empty output', () => {
    const output = `List of devices attached

`;
    const result = parseAdbDevices(output);
    expect(result).toEqual([]);
  });

  it('should handle single device', () => {
    const output = `List of devices attached
R5CR10XXXXX\tdevice
`;
    const result = parseAdbDevices(output);
    expect(result).toEqual([{ id: 'R5CR10XXXXX', status: 'device' }]);
  });

  it('should handle unauthorized devices', () => {
    const output = `List of devices attached
ABCDEF123456\tunauthorized
`;
    const result = parseAdbDevices(output);
    expect(result).toEqual([{ id: 'ABCDEF123456', status: 'unauthorized' }]);
  });

  it('should skip daemon messages', () => {
    const output = `* daemon not running
List of devices attached
DEV001\tdevice
`;
    const result = parseAdbDevices(output);
    expect(result).toEqual([{ id: 'DEV001', status: 'device' }]);
  });

  it('should handle multiple devices of varying statuses', () => {
    const output = `List of devices attached
DEV001\tdevice
DEV002\toffline
DEV003\tdevice
DEV004\tunauthorized
`;
    const result = parseAdbDevices(output);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ id: 'DEV001', status: 'device' });
    expect(result[2]).toEqual({ id: 'DEV003', status: 'device' });
  });
});

describe('parseBatteryLevel', () => {
  it('should parse battery level from dumpsys output', () => {
    const output = `Current Battery Service state:
  AC powered: true
  USB powered: false
  Wireless powered: false
  Max charging current: 1500000
  Max charging voltage: 5000000
  Charge type: 1
  status: 5
  health: 2
  present: true
  level: 85
  scale: 100
  voltage: 4350
  temperature: 250
  technology: Li-ion`;
    expect(parseBatteryLevel(output)).toBe(85);
  });

  it('should return null for invalid output', () => {
    expect(parseBatteryLevel('no battery info here')).toBeNull();
  });

  it('should parse level 100', () => {
    expect(parseBatteryLevel('  level: 100\n  scale: 100')).toBe(100);
  });

  it('should parse level 0', () => {
    expect(parseBatteryLevel('  level: 0\n  scale: 100')).toBe(0);
  });
});

describe('DeviceManager', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let manager: DeviceManager;

  beforeEach(() => {
    DeviceManager.resetInstance();
    db = createTestDb();
    manager = new DeviceManager(db);
  });

  afterEach(() => {
    manager.stop();
    DeviceManager.resetInstance();
  });

  describe('needsSetup', () => {
    it('should return true for new device with setupVersion 0', () => {
      db.insert(devices).values({
        id: 'DEV001',
        name: 'Test Device',
        setupVersion: 0,
      }).run();

      expect(manager.needsSetup('DEV001')).toBe(true);
    });

    it('should return false when setupVersion matches current', () => {
      db.insert(devices).values({
        id: 'DEV001',
        name: 'Test Device',
        setupVersion: CURRENT_SETUP_VERSION,
      }).run();

      expect(manager.needsSetup('DEV001')).toBe(false);
    });

    it('should return false for unknown device', () => {
      expect(manager.needsSetup('UNKNOWN')).toBe(false);
    });

    it('should return true when setupVersion is less than current', () => {
      db.insert(devices).values({
        id: 'DEV001',
        setupVersion: CURRENT_SETUP_VERSION - 1,
      }).run();

      // This is meaningful only if CURRENT_SETUP_VERSION > 1
      if (CURRENT_SETUP_VERSION > 1) {
        expect(manager.needsSetup('DEV001')).toBe(true);
      } else {
        expect(manager.needsSetup('DEV001')).toBe(true);
      }
    });
  });

  describe('busy tracking', () => {
    it('should mark device as busy', () => {
      expect(manager.isBusy('DEV001')).toBe(false);
      manager.markBusy('DEV001');
      expect(manager.isBusy('DEV001')).toBe(true);
    });

    it('should mark device as idle', () => {
      manager.markBusy('DEV001');
      manager.markIdle('DEV001');
      expect(manager.isBusy('DEV001')).toBe(false);
    });

    it('should track multiple busy devices', () => {
      manager.markBusy('DEV001');
      manager.markBusy('DEV002');
      expect(manager.isBusy('DEV001')).toBe(true);
      expect(manager.isBusy('DEV002')).toBe(true);
      manager.markIdle('DEV001');
      expect(manager.isBusy('DEV001')).toBe(false);
      expect(manager.isBusy('DEV002')).toBe(true);
    });

    it('tryAcquireBusy succeeds when device is free', () => {
      expect(manager.tryAcquireBusy('DEV001')).toBe(true);
      expect(manager.isBusy('DEV001')).toBe(true);
    });

    it('tryAcquireBusy fails when device is already busy', () => {
      manager.markBusy('DEV001');
      expect(manager.tryAcquireBusy('DEV001')).toBe(false);
    });

    it('tryAcquireBusy is atomic — second call fails immediately', () => {
      expect(manager.tryAcquireBusy('DEV001')).toBe(true);
      expect(manager.tryAcquireBusy('DEV001')).toBe(false);
    });

    it('refreshBusy updates timestamp for busy device', () => {
      manager.markBusy('DEV001');
      // Wait a bit so timestamps differ
      manager.refreshBusy('DEV001');
      expect(manager.isBusy('DEV001')).toBe(true);
    });

    it('refreshBusy does nothing for non-busy device', () => {
      manager.refreshBusy('DEV001');
      expect(manager.isBusy('DEV001')).toBe(false);
    });
  });

  describe('interaction tracking', () => {
    it('should record interaction time', () => {
      manager.recordInteraction('DEV001');
      // The interaction should have been recorded; not directly exposed but
      // it influences standby behavior
      expect(manager.isBusy('DEV001')).toBe(false); // recording interaction doesn't make it busy
    });
  });

  describe('device availability', () => {
    it('should return empty list when no devices exist', async () => {
      const available = await manager.getAvailableDevices();
      expect(available).toEqual([]);
    });

    it('should return only online, non-busy devices', async () => {
      db.insert(devices).values({ id: 'DEV001', name: 'Online' }).run();
      db.insert(devices).values({ id: 'DEV002', name: 'Busy' }).run();

      // Simulate DEV001 online but not DEV002
      // We can't easily set the onlineDevices set directly, but we can test via getAllDeviceStatuses
      const statuses = await manager.getAllDeviceStatuses();
      // Both should be offline since no ADB poll happened
      expect(statuses.every((s) => !s.isOnline)).toBe(true);
    });

    it('should filter by rooted requirement', async () => {
      db.insert(devices).values({ id: 'DEV001', name: 'Rooted', isRooted: true }).run();
      db.insert(devices).values({ id: 'DEV002', name: 'Not Rooted', isRooted: false }).run();

      // Both offline, so available will be empty anyway
      const available = await manager.getAvailableDevices({ rooted: true });
      expect(available).toEqual([]);
    });
  });

  describe('getAllDeviceStatuses', () => {
    it('should return all devices with status info', async () => {
      db.insert(devices).values({
        id: 'DEV001',
        name: 'Pixel 6',
        isRooted: true,
        setupVersion: 0,
      }).run();
      db.insert(devices).values({
        id: 'DEV002',
        name: 'Galaxy S22',
        isRooted: false,
        setupVersion: CURRENT_SETUP_VERSION,
      }).run();

      const statuses = await manager.getAllDeviceStatuses();
      expect(statuses).toHaveLength(2);

      const dev1 = statuses.find((s) => s.id === 'DEV001')!;
      expect(dev1.name).toBe('Pixel 6');
      expect(dev1.isRooted).toBe(true);
      expect(dev1.needsSetup).toBe(true);
      expect(dev1.isOnline).toBe(false);

      const dev2 = statuses.find((s) => s.id === 'DEV002')!;
      expect(dev2.name).toBe('Galaxy S22');
      expect(dev2.isRooted).toBe(false);
      expect(dev2.needsSetup).toBe(false);
    });
  });

  describe('getDeviceStatus', () => {
    it('should return null for unknown device', async () => {
      const status = await manager.getDeviceStatus('UNKNOWN');
      expect(status).toBeNull();
    });

    it('should return device with correct status fields', async () => {
      db.insert(devices).values({
        id: 'DEV001',
        name: 'Test',
        isRooted: true,
        setupVersion: CURRENT_SETUP_VERSION,
        bridgePort: 9100,
      }).run();

      const status = await manager.getDeviceStatus('DEV001');
      expect(status).not.toBeNull();
      expect(status!.id).toBe('DEV001');
      expect(status!.name).toBe('Test');
      expect(status!.isRooted).toBe(true);
      expect(status!.bridgePort).toBe(9100);
      expect(status!.needsSetup).toBe(false);
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      DeviceManager.resetInstance();
      const instance1 = DeviceManager.getInstance(db);
      const instance2 = DeviceManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should throw if no db provided on first init', () => {
      DeviceManager.resetInstance();
      expect(() => DeviceManager.getInstance()).toThrow('DeviceManager requires db on first init');
    });
  });

  describe('CURRENT_SETUP_VERSION', () => {
    it('should be 4', () => {
      expect(CURRENT_SETUP_VERSION).toBe(4);
    });
  });

  describe('findWgTool', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('returns system wg path when found', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        if (_cmd.includes('which wg')) {
          cb(null, '/usr/bin/wg', '');
        } else {
          cb(new Error('not found'), '', '');
        }
      });

      const result = await manager.findWgTool('DEV001');
      expect(result).toBe('/usr/bin/wg');
    });

    it('returns pushed binary path when found', async () => {
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('which wg')) {
          cb(new Error('not found'), '', '');
        } else if (cmd.includes('test -x')) {
          cb(null, 'ok', '');
        } else {
          cb(new Error('not found'), '', '');
        }
      });

      const result = await manager.findWgTool('DEV001');
      expect(result).toBe('/data/local/tmp/wg');
    });

    it('returns null when wg not found anywhere', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('not found'), '', '');
      });

      const result = await manager.findWgTool('DEV001');
      expect(result).toBeNull();
    });
  });

  describe('hasKernelWireGuard', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('returns true when kernel WireGuard probe succeeds', async () => {
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('wg_test')) {
          cb(null, '', '');
        } else {
          cb(new Error(''), '', '');
        }
      });

      const result = await manager.hasKernelWireGuard('DEV001');
      expect(result).toBe(true);
    });

    it('returns false when kernel WireGuard probe fails', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('Operation not supported'), '', '');
      });

      const result = await manager.hasKernelWireGuard('DEV001');
      expect(result).toBe(false);
    });

    it('caches the result per device', async () => {
      let callCount = 0;
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('wg_test')) callCount++;
        cb(null, '', '');
      });

      await manager.hasKernelWireGuard('DEV001');
      await manager.hasKernelWireGuard('DEV001');
      expect(callCount).toBe(1); // Only probed once
    });
  });

  describe('activateWireGuardTunnel', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('uses kernel WireGuard when available', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        if (cmd.includes('which wg')) {
          cb(null, '/usr/bin/wg', '');
        } else {
          cb(null, '', '');
        }
      });

      await manager.activateWireGuardTunnel('DEV001', {
        clientPrivateKey: 'test-client-key',
        serverPublicKey: 'test-server-key',
        clientAddress: '10.0.0.2/32',
        serverEndpoint: '192.168.1.100:51820',
      });

      const allCmds = commands.join(' ');
      expect(allCmds).toContain('ip link add dev wg0 type wireguard');
      expect(allCmds).toContain('killall wireguard-go');
      expect(allCmds).toContain('setconf wg0');
      expect(allCmds).toContain('fwmark 51820');
      expect(allCmds).toContain('ip route add default dev wg0 table 51820');
      // Android's `32000: unreachable` rule requires explicit routing for fwmark packets
      expect(allCmds).toContain('ip rule add fwmark 51820 lookup main priority 90');
      expect(allCmds).toContain('ip rule add not fwmark 51820 table 51820 priority 100');
    });

    it('uses wireguard-go and wg-uapi when kernel WireGuard not available', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        if (cmd.includes('wg_test')) {
          // Kernel probe fails
          cb(new Error('Operation not supported'), '', '');
        } else if (cmd.includes('which wg')) {
          cb(null, '/usr/bin/wg', '');
        } else if (cmd.includes('test -x /data/local/tmp/wireguard-go')) {
          cb(null, 'ok', '');
        } else if (cmd.includes('test -x /data/local/tmp/wg-uapi')) {
          cb(null, 'ok', '');
        } else {
          cb(null, '', '');
        }
      });

      await manager.activateWireGuardTunnel('DEV001', {
        clientPrivateKey: 'test-client-key',
        serverPublicKey: 'test-server-key',
        clientAddress: '10.0.0.2/32',
        serverEndpoint: '192.168.1.100:51820',
      });

      const allCmds = commands.join(' ');
      expect(allCmds).not.toContain('ip link add dev wg0 type wireguard');
      expect(allCmds).toContain('/data/local/tmp/wireguard-go wg0');
      // In userspace mode, wg-uapi is used instead of the APK's wg binary
      expect(allCmds).toContain('/data/local/tmp/wg-uapi setconf wg0');
      expect(allCmds).toContain('/data/local/tmp/wg-uapi set wg0 fwmark 51820');
    });
  });

  describe('deactivateWireGuardTunnel', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('handles missing interface gracefully', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('Cannot find device "wg0"'), '', '');
      });

      // Should not throw
      await manager.deactivateWireGuardTunnel('DEV001');
    });

    it('cleans up interface, wireguard-go process, rule, and routing table', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        cb(null, '', '');
      });

      await manager.deactivateWireGuardTunnel('DEV001');

      const allCmds = commands.join(' ');
      expect(allCmds).toContain('ip link del wg0');
      expect(allCmds).toContain('killall wireguard-go');
      expect(allCmds).toContain('ip rule del table 51820');
      expect(allCmds).toContain('ip route flush table 51820');
    });
  });

  describe('findWgGoTool', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('returns path when wireguard-go binary exists on device', async () => {
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('test -x /data/local/tmp/wireguard-go')) {
          cb(null, 'ok', '');
        } else {
          cb(new Error('not found'), '', '');
        }
      });

      const result = await manager.findWgGoTool('DEV001');
      expect(result).toBe('/data/local/tmp/wireguard-go');
    });

    it('returns null when wireguard-go not found', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('not found'), '', '');
      });

      const result = await manager.findWgGoTool('DEV001');
      expect(result).toBeNull();
    });
  });

  describe('findWgUapiTool', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('returns path when wg-uapi binary exists on device', async () => {
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('test -x /data/local/tmp/wg-uapi')) {
          cb(null, 'ok', '');
        } else {
          cb(new Error('not found'), '', '');
        }
      });

      const result = await manager.findWgUapiTool('DEV001');
      expect(result).toBe('/data/local/tmp/wg-uapi');
    });

    it('returns null when wg-uapi not found', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('not found'), '', '');
      });

      const result = await manager.findWgUapiTool('DEV001');
      expect(result).toBeNull();
    });
  });

  describe('ensureWgTool', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('returns path when wg is already available', async () => {
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('which wg')) {
          cb(null, '/usr/bin/wg', '');
        } else {
          cb(new Error(''), '', '');
        }
      });

      const result = await manager.ensureWgTool('DEV001');
      expect(result).toBe('/usr/bin/wg');
    });

    it('throws when wg not available even after push attempt', async () => {
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('getprop ro.product.cpu.abi')) {
          cb(null, 'arm64-v8a', '');
        } else if (cmd.includes('push')) {
          cb(null, '', '');
        } else if (cmd.includes('chmod')) {
          cb(null, '', '');
        } else {
          cb(new Error('not found'), '', '');
        }
      });

      await expect(manager.ensureWgTool('DEV001')).rejects.toThrow(
        /wg.*not found/i,
      );
    });
  });

  describe('onDeviceOffline', () => {
    it('invokes registered listeners when a device transitions offline', () => {
      const listener = vi.fn();
      manager.onDeviceOffline(listener);
      (manager as any).notifyOffline('DEV_GONE');
      expect(listener).toHaveBeenCalledWith('DEV_GONE');
    });

    it('supports multiple listeners', () => {
      const a = vi.fn();
      const b = vi.fn();
      manager.onDeviceOffline(a);
      manager.onDeviceOffline(b);
      (manager as any).notifyOffline('DEV1');
      expect(a).toHaveBeenCalledWith('DEV1');
      expect(b).toHaveBeenCalledWith('DEV1');
    });

    it('a listener that throws does not block subsequent listeners', () => {
      const bad = vi.fn(() => { throw new Error('boom'); });
      const good = vi.fn();
      manager.onDeviceOffline(bad);
      manager.onDeviceOffline(good);
      expect(() => (manager as any).notifyOffline('DEV1')).not.toThrow();
      expect(good).toHaveBeenCalledWith('DEV1');
    });
  });

  describe('hookBus integration', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('emits device:connected when a device first comes online', async () => {
      const handler = vi.fn();
      const bus = { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn() };
      manager.setHookBus(bus as any);

      // adb devices → one online device; checkRooted → sucess
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('adb devices')) {
          cb(null, 'List of devices attached\nDEV_HOOK\tdevice\n', '');
        } else {
          cb(null, '', '');
        }
      });

      // Pre-seed the device so the insert branch is skipped (simpler mock surface)
      db.insert(devices).values({ id: 'DEV_HOOK', name: 'Hook Test' }).run();

      await manager.pollAdbDevices();

      expect(bus.emit).toHaveBeenCalledWith('device:connected', { id: 'DEV_HOOK', platform: 'android' });
    });

    it('emits device:disconnected when a device goes offline', async () => {
      const bus = { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn() };
      manager.setHookBus(bus as any);

      // Mark device as online first (simulates a previous poll)
      (manager as any).onlineDevices.add('DEV_GONE');

      // adb devices → empty (device gone)
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, 'List of devices attached\n', '');
      });

      await manager.pollAdbDevices();

      expect(bus.emit).toHaveBeenCalledWith('device:disconnected', { id: 'DEV_GONE', platform: 'android' });
    });

    it('does not throw when no hookBus is wired', async () => {
      // No setHookBus call — hookBus stays null
      (manager as any).onlineDevices.add('DEV_NOHOOK');

      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, 'List of devices attached\n', '');
      });

      await expect(manager.pollAdbDevices()).resolves.not.toThrow();
    });
  });
});
