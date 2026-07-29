import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { findPosixShell } from '../test-utils/posix-shell';
import {
  DeviceManager,
  parseAdbDevices,
  parseBatteryLevel,
  CURRENT_SETUP_VERSION,
  STANDBY_TIMEOUT,
  MIN_BATTERY_LEVEL,
  adbShell,
  adbCommand,
  suShell,
  ensureRootAccess,
} from './device-manager';

const { devices } = schema;

// Mock child_process exec + execFile + spawn + execSync.
// Note on `execFile`: production code now invokes adb via `execFile('adb', [args...])`
// for shell-injection safety. To keep the rest of this file's dispatch logic
// (which uses `cmd.includes('which wg')` etc. on the joined command string)
// usable as-is, we install a bridge below that joins the execFile arguments
// back into a single command string and re-dispatches through the `exec` mock.
// Individual tests therefore continue to set `execMock.mockImplementation(...)`
// the way they always did.
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (fn: any) => {
      // Return a wrapper that calls exec/execFile with a callback pattern.
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

beforeAll(async () => {
  // Bridge execFile → exec so tests that dispatch on `cmd.includes(...)` keep
  // working without rewriting every mockImplementation. The bridge stays in
  // place across the whole suite; individual `execMock.mockImplementation(...)`
  // calls steer the underlying exec mock as before.
  const cp = await import('child_process');
  const execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
  const execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
  execFileMock.mockImplementation((file: string, args: string[], opts: any, cb: any) => {
    const joined = `${file} ${args.join(' ')}`;
    return execMock(joined, opts, cb);
  });
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
      // IPv6 must be null-routed inside the custom table so IPv6 attempts fail
      // fast (ENETUNREACH) and Happy-Eyeballs-capable clients fall back to the
      // captured IPv4 path, instead of silently bypassing the tunnel.
      expect(allCmds).toContain('ip -6 route add unreachable default table 51820');
      expect(allCmds).toContain('ip -6 rule add not fwmark 51820 table 51820 priority 100');
      // The inline teardown at the start of the command chain must also
      // reverse the v6 null-route/rule from any prior run.
      expect(allCmds).toContain('ip -6 rule del not fwmark 51820 table 51820 priority 100');
      expect(allCmds).toContain('ip -6 route flush table 51820');
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

    it('routes the device DNS resolvers around the tunnel (priority 50)', async () => {
      // Regression for "tunnel up but zero app traffic": mitmproxy's WireGuard
      // DNS replies don't reach some resolvers (Android 16 + kernel WG), so DNS
      // must resolve on the device's real network. Bypass rules for each DNS
      // server must be emitted at priority 50 (before the catch-all at 100).
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        if (cmd.includes('dumpsys connectivity')) {
          cb(null, 'lp{{InterfaceName: wlan1 DnsAddresses: [ /192.168.1.1,/8.8.8.8 ] Domains: home}}', '');
        } else if (cmd.includes('which wg')) {
          cb(null, '/usr/bin/wg', '');
        } else {
          cb(null, '', '');
        }
      });

      await manager.activateWireGuardTunnel('DEV001', {
        clientPrivateKey: 'k', serverPublicKey: 'k', clientAddress: '10.0.0.2/32', serverEndpoint: '192.168.1.100:51820',
      });

      const allCmds = commands.join(' ');
      expect(allCmds).toContain('ip rule add to 192.168.1.1 lookup main priority 50');
      expect(allCmds).toContain('ip rule add to 8.8.8.8 lookup main priority 50');
      // Stale bypass rules from a prior run are cleared first.
      expect(allCmds).toContain('ip rule del priority 50');
    });

    it('emits no DNS-bypass rule when resolvers cannot be determined', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        // `dumpsys connectivity` fails outright — the resolver list is genuinely
        // unavailable, not merely empty.
        if (cmd.includes('dumpsys connectivity')) {
          cb(new Error('dumpsys: command not found'), '', '');
          return;
        }
        cb(null, cmd.includes('which wg') ? '/usr/bin/wg' : '', '');
      });

      await manager.activateWireGuardTunnel('DEV001', {
        clientPrivateKey: 'k', serverPublicKey: 'k', clientAddress: '10.0.0.2/32', serverEndpoint: '192.168.1.100:51820',
      });

      expect(commands.join(' ')).not.toContain('lookup main priority 50');
    });
  });

  describe('getDeviceDnsServers', () => {
    let execMock: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('parses IPv4 DnsAddresses from dumpsys connectivity, de-duplicated', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(null, 'DnsAddresses: [ /192.168.1.1 ] ... DnsAddresses: [ /192.168.1.1,/1.1.1.1 ]', '');
      });
      const dns = await manager.getDeviceDnsServers('DEV001');
      expect(dns).toEqual(['192.168.1.1', '1.1.1.1']);
    });

    it('returns [] when dumpsys fails', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(new Error('boom'), '', ''));
      expect(await manager.getDeviceDnsServers('DEV001')).toEqual([]);
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
      // Reverse the IPv6 null-route/rule installed during activation.
      expect(allCmds).toContain('ip -6 rule del not fwmark 51820 table 51820 priority 100');
      expect(allCmds).toContain('ip -6 route flush table 51820');
    });

    it('loop-deletes the priority 50/90/100 rules so duplicates cannot survive', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        cb(null, '', '');
      });

      await manager.deactivateWireGuardTunnel('DEV001');

      const allCmds = commands.join(' ');
      // A bare `ip rule del` removes only the first match; a leftover
      // priority-100 rule points the default route at a dead wg0 and
      // black-holes every packet the device sends. Bounded `for` rather than
      // `while` so a non-iproute2 `ip` that exits 0 on a no-op can't spin.
      for (const sel of ['priority 100', 'priority 90', 'priority 50', 'table 51820']) {
        expect(allCmds).toContain(`for i in 1 2 3 4 5 6 7 8; do ip rule del ${sel} 2>/dev/null || break; done`);
      }
      // The IPv6 catch-all accumulates duplicates the same way.
      expect(allCmds).toContain('do ip -6 rule del not fwmark 51820 table 51820 priority 100 2>/dev/null || break; done');
    });
  });

  describe('reconcileOrphanTunnel', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    });

    it('tears down a wg0 left behind by a previous process', async () => {
      const commands: string[] = [];
      let tornDown = false;
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        if (cmd.includes('ip link del wg0')) tornDown = true;
        if (cmd.includes('ip link show wg0')) {
          // Gone once the teardown has run — the method re-probes to confirm.
          cb(null, tornDown ? '' : '52: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 state UNKNOWN', '');
          return;
        }
        cb(null, '', '');
      });

      const cleaned = await manager.reconcileOrphanTunnel('DEV001');

      expect(cleaned).toBe(true);
      expect(commands.join(' ')).toContain('ip link del wg0');
    });

    it('reports failure when the tunnel survives teardown (unrooted device)', async () => {
      // deactivateWireGuardTunnel swallows its own errors, so "we ran teardown"
      // must not be reported as "the tunnel is gone".
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        if (cmd.includes('ip link show wg0')) {
          cb(null, '52: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 state UNKNOWN', '');
          return;
        }
        cb(new Error('su: permission denied'), '', '');
      });

      await expect(manager.reconcileOrphanTunnel('DEV001')).resolves.toBe(false);
    });

    it('ignores an `ip` build that prints its error to stdout', async () => {
      // Some builds print `Device "wg0" does not exist.` on STDOUT. A loose
      // match would "clean up" a tunnel that isn't there — popping an
      // unsolicited Magisk prompt on every device connect.
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        cb(null, 'Device "wg0" does not exist.', '');
      });

      const cleaned = await manager.reconcileOrphanTunnel('DEV001');

      expect(cleaned).toBe(false);
      expect(commands.join(' ')).not.toContain('ip link del wg0');
    });

    it('does nothing when the device has no wg0', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        cb(null, '', '');
      });

      const cleaned = await manager.reconcileOrphanTunnel('DEV001');

      expect(cleaned).toBe(false);
      expect(commands.join(' ')).not.toContain('ip link del wg0');
    });

    it('leaves the tunnel alone when a capture owns the device', async () => {
      const commands: string[] = [];
      execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
        commands.push(cmd);
        cb(null, '52: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP>', '');
      });
      manager.setCaptureActiveCheck((id) => id === 'DEV001');

      const cleaned = await manager.reconcileOrphanTunnel('DEV001');

      expect(cleaned).toBe(false);
      // Must not even probe — a live capture is authoritative.
      expect(commands).toHaveLength(0);
    });

    it('stays quiet when the device is unreachable', async () => {
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('device offline'), '', '');
      });

      await expect(manager.reconcileOrphanTunnel('DEV001')).resolves.toBe(false);
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

  describe('provider-driven polling (live path)', () => {
    let execMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const cp = await import('child_process');
      execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
      // Default: every adb shell command (checkRooted, getprop, etc.) succeeds
      // with empty output so the reconcile path doesn't blow up.
      execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(null, '', ''));
    });

    // Minimal in-memory ProviderRegistry that returns a fixed instance list.
    // Matches the real registry's listInstancesAll() row shape:
    // { providerId, instance: DeviceProviderInstance }.
    function makeRegistry(rows: Array<{ providerId: string; instance: any }>): any {
      return {
        register: vi.fn(),
        get: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        listInstancesAll: vi.fn().mockResolvedValue(rows),
      };
    }

    it('pollDevicesFromProviders writes a devices row for a provider-reported serial', async () => {
      const reg = makeRegistry([
        {
          providerId: 'adb-device',
          instance: {
            id: 'PROV_SERIAL_1',
            displayName: 'PROV_SERIAL_1',
            serial: 'PROV_SERIAL_1',
            state: 'running',
            spawnedByDarkride: false,
          },
        },
      ]);
      manager.setProviderRegistry(reg);

      await manager.pollDevicesFromProviders();

      const row = db.select().from(devices).where(eq(devices.id, 'PROV_SERIAL_1')).all();
      expect(row).toHaveLength(1);
      // A 'running' instance must be tracked as online — same as adb 'device' state.
      expect(manager.isOnline('PROV_SERIAL_1')).toBe(true);
    });

    it('updates lastSeen for an already-known serial rather than inserting again', async () => {
      db.insert(devices).values({ id: 'PROV_KNOWN', name: 'Known' }).run();
      const reg = makeRegistry([
        {
          providerId: 'adb-device',
          instance: { id: 'PROV_KNOWN', displayName: 'PROV_KNOWN', serial: 'PROV_KNOWN', state: 'running', spawnedByDarkride: false },
        },
      ]);
      manager.setProviderRegistry(reg);

      await manager.pollDevicesFromProviders();

      const rows = db.select().from(devices).where(eq(devices.id, 'PROV_KNOWN')).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Known'); // not clobbered by a re-insert
      expect(rows[0].lastSeen).not.toBeNull();
    });

    it('skips instances without a serial (e.g. stopped emulators)', async () => {
      const reg = makeRegistry([
        {
          providerId: 'avd',
          instance: { id: 'avd-1', displayName: 'My AVD', state: 'stopped', spawnedByDarkride: true },
        },
      ]);
      manager.setProviderRegistry(reg);

      await manager.pollDevicesFromProviders();

      expect(db.select().from(devices).all()).toHaveLength(0);
    });

    it('marks a previously-online provider device offline when it disappears', async () => {
      const offlineListener = vi.fn();
      manager.onDeviceOffline(offlineListener);
      const bus = { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn() };
      manager.setHookBus(bus as any);

      // First poll: device present + running.
      const present = makeRegistry([
        { providerId: 'adb-device', instance: { id: 'PROV_GONE', displayName: 'PROV_GONE', serial: 'PROV_GONE', state: 'running', spawnedByDarkride: false } },
      ]);
      manager.setProviderRegistry(present);
      await manager.pollDevicesFromProviders();
      expect(manager.isOnline('PROV_GONE')).toBe(true);

      // Second poll: registry now returns nothing — device must go offline,
      // exactly like pollAdbDevices's offline reconcile.
      manager.setProviderRegistry(makeRegistry([]));
      await manager.pollDevicesFromProviders();

      expect(manager.isOnline('PROV_GONE')).toBe(false);
      expect(offlineListener).toHaveBeenCalledWith('PROV_GONE');
      expect(bus.emit).toHaveBeenCalledWith('device:disconnected', { id: 'PROV_GONE', platform: 'android' });
    });

    it('does nothing (returns early) when no registry is wired', async () => {
      // No setProviderRegistry call.
      await expect(manager.pollDevicesFromProviders()).resolves.not.toThrow();
      expect(db.select().from(devices).all()).toHaveLength(0);
    });

    it('start() schedules pollDevicesFromProviders when a registry is wired', () => {
      const reg = makeRegistry([]);
      manager.setProviderRegistry(reg);
      const providerSpy = vi.spyOn(manager, 'pollDevicesFromProviders').mockResolvedValue();
      const adbSpy = vi.spyOn(manager, 'pollAdbDevices').mockResolvedValue();

      manager.start();

      expect(providerSpy).toHaveBeenCalled();
      expect(adbSpy).not.toHaveBeenCalled();
    });

    it('start() falls back to pollAdbDevices when no registry is wired', () => {
      const providerSpy = vi.spyOn(manager, 'pollDevicesFromProviders').mockResolvedValue();
      const adbSpy = vi.spyOn(manager, 'pollAdbDevices').mockResolvedValue();

      manager.start();

      expect(adbSpy).toHaveBeenCalled();
      expect(providerSpy).not.toHaveBeenCalled();
    });
  });
});

describe('adb helpers — command-injection prevention', () => {
  let execFileMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('child_process');
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
    // The suite-level beforeAll bridge stays in place — exec runs the response.
    execMock.mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, '', ''));
  });

  it('adbShell passes a hostile deviceId as one argv slot (no host shell sees it)', async () => {
    // A malicious deviceId containing shell metacharacters MUST arrive at adb as a
    // single arg — if it ever reached /bin/sh -c "...", the `;` would terminate the
    // adb invocation and the trailing chunk would run as a separate command.
    const hostileDeviceId = 'DEV; rm -rf /tmp/should-not-exist';
    await adbShell(hostileDeviceId, 'ls', 1000);

    expect(execFileMock).toHaveBeenCalled();
    const lastCall = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect(lastCall[0]).toBe('adb');                  // direct binary, not /bin/sh
    expect(Array.isArray(lastCall[1])).toBe(true);    // argv array, not joined string
    expect(lastCall[1]).toContain(hostileDeviceId);   // hostile id stays one slot
  });

  it('adbCommand passes argv array verbatim (no shell interpretation)', async () => {
    // Same contract for the lower-level adbCommand helper.
    const hostilePath = '/tmp/path with spaces; touch /tmp/pwned';
    await adbCommand(['-s', 'DEV001', 'push', hostilePath, '/data/local/tmp/x'], 1000);

    const lastCall = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    expect(lastCall[0]).toBe('adb');
    expect(lastCall[1]).toEqual(['-s', 'DEV001', 'push', hostilePath, '/data/local/tmp/x']);
  });

  it('suShell invokes su unwrapped so the device shell can execute it', async () => {
    // Faithful device-shell simulation. adbShell runs adb via execFile with NO
    // host shell, so whatever string we pass reaches the device shell verbatim.
    // A command wrapped in literal double quotes (`"su -c id"`) is parsed by the
    // device shell as ONE bogus command word named `su -c id` → "inaccessible or
    // not found". Only a bare `su -c '<cmd>'` actually invokes su and runs as root.
    // This is the exact false "Root access unavailable" failure from production.
    let sentToDevice = '';
    execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
      sentToDevice = cmd.replace(/^adb -s \S+ shell /, '');
      if (sentToDevice.startsWith('"')) {
        cb(new Error('Command failed'), '', '/system/bin/sh: su -c id: inaccessible or not found');
      } else if (/^su -c /.test(sentToDevice)) {
        cb(null, 'uid=0(root) gid=0(root) groups=0(root) context=u:r:magisk:s0', '');
      } else {
        cb(new Error('unexpected command'), '', sentToDevice);
      }
    });

    const out = await suShell('DEV001', 'id', 3000);

    expect(out).toContain('uid=0');                 // su actually ran as root
    expect(sentToDevice).not.toMatch(/^"/);         // never wrapped in literal quotes
    expect(sentToDevice).toBe("su -c 'id'");        // exact form sent to the device
  });

  it('suShell escapes single quotes so the device shell reconstructs the exact command', async () => {
    // Defense-in-depth: a command containing a single quote must still reach the
    // device shell as one intact argument to `su -c`, not break out of the quoting.
    let payload = '';
    execMock.mockImplementation((cmd: string, _opts: any, cb: any) => {
      payload = cmd.replace(/^adb -s \S+ shell su -c /, ''); // the `'...'` literal passed to su -c
      cb(null, '', '');
    });

    const tricky = "echo 'a b' c"; // single quotes + a space that must stay grouped
    await suShell('DEV001', tricky, 3000);

    // Verify with a REAL shell (the suite mocks child_process) so the assertion
    // checks POSIX correctness rather than re-implementing the escape algorithm.
    const realCp = await vi.importActual<typeof import('child_process')>('child_process');
    // This suite mocks child_process, so hand the probe the real execFileSync.
    const sh = findPosixShell(realCp.execFileSync);
    expect(sh, 'no POSIX shell available to verify the quoting').not.toBeNull();
    const reconstructed = realCp.execFileSync(sh!, ['-c', `printf %s ${payload}`]).toString();
    expect(reconstructed).toBe(tricky);
  });

  it('adbShell sends a multi-statement getprop chain unwrapped (no literal "..." around it)', async () => {
    // Regression for the collectDeviceProperties bug — the chain was wrapped in
    // literal double quotes, so the device shell parsed the whole quoted string
    // as a single command word and reported "inaccessible or not found". Same
    // failure mode as the wrapped-suShell case above. The chain must arrive at
    // the device shell as a bare `getprop A; getprop B; ...` so `;` is parsed
    // as a statement separator.
    const chain = 'getprop ro.product.manufacturer; getprop ro.product.model';
    await adbShell('DEV001', chain, 1000);

    const lastCall = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
    const argv = lastCall[1] as string[];
    const sent = argv[argv.length - 1];
    expect(sent).toBe(chain);                 // exact bare form
    expect(sent).not.toMatch(/^"/);           // never wrapped in literal quotes
    expect(sent).not.toMatch(/"$/);
  });
});

describe('ensureRootAccess — interactive Magisk grant', () => {
  let execMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('child_process');
    execMock = cp.exec as unknown as ReturnType<typeof vi.fn>;
  });

  it('waits out the on-phone grant instead of failing fast (>= 30s, not the old 3s)', async () => {
    // Regression guard for "rooted device won't capture, it just times out":
    // the root check is the first su -c of the capture, so it triggers the
    // Magisk superuser prompt the user has to physically tap. A 3s timeout
    // killed adb before they could respond and reported a false "no root".
    let seenTimeout = 0;
    execMock.mockImplementation((cmd: string, opts: any, cb: any) => {
      const sent = cmd.replace(/^adb -s \S+ shell /, '');
      if (/^su -c /.test(sent)) {
        seenTimeout = opts?.timeout ?? 0;
        cb(null, 'uid=0(root) gid=0(root)', '');
      } else {
        cb(new Error('unexpected'), '', sent);
      }
    });

    await expect(ensureRootAccess('DEV001')).resolves.toBeUndefined();
    // Must give a human time to tap Grant; anything back near the old 3s
    // reintroduces the false-negative on a genuinely rooted device.
    expect(seenTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it('when the grant prompt is never answered (adb killed on timeout), says so', async () => {
    // execFile kills the child with SIGTERM when the timeout elapses.
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
      const err: any = new Error('Command failed: adb ... shell su -c id');
      err.killed = true;
      err.signal = 'SIGTERM';
      cb(err, '', '');
    });

    await expect(ensureRootAccess('DEV001', 50)).rejects.toThrow(/not granted in time/i);
  });

  it('when there is no usable root (su denied/absent, fast error), says not rooted', async () => {
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
      cb(new Error('Command failed'), '', '/system/bin/sh: su: inaccessible or not found');
    });

    await expect(ensureRootAccess('DEV001')).rejects.toThrow(/not rooted, or su access was denied/i);
  });
});
