import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MitmproxyManager } from './mitmproxy-manager';
import { ProxyRotator } from './proxy-rotator';
import type { ChildProcess } from 'child_process';

// Mock child_process.spawn with EventEmitter-based child that emits 'exit' on kill
const mockKill = vi.fn();
const mockChildren: EventEmitter[] = [];

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal?: string) => {
    mockKill(signal);
    // Simulate async process exit
    process.nextTick(() => child.emit('exit', null, signal));
  });
  // Emit the READY sentinel on stdout so startCapture's readiness promise resolves
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from('[DarkRide] READY\n'));
  });
  mockChildren.push(child);
  return child as ChildProcess;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => createMockChild()),
  exec: vi.fn(),
  execFile: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

const mockEnsureConfigs = vi.fn();

const mockGetDeviceLanIp = vi.fn().mockResolvedValue(undefined);

vi.mock('./wireguard-config', () => ({
  ensureConfigs: (...args: any[]) => mockEnsureConfigs(...args),
  getDeviceLanIp: (...args: any[]) => mockGetDeviceLanIp(...args),
}));

const mockSocksInstances: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; getPort: ReturnType<typeof vi.fn> }> = [];

vi.mock('./socks-proxy-server', () => ({
  SocksProxyServer: vi.fn().mockImplementation(() => {
    const instance = {
      start: vi.fn().mockResolvedValue(19876),
      stop: vi.fn(),
      getPort: vi.fn().mockReturnValue(19876),
      testConnection: vi.fn().mockResolvedValue('1.2.3.4'),
    };
    mockSocksInstances.push(instance);
    return instance;
  }),
}));

describe('MitmproxyManager', () => {
  let manager: MitmproxyManager;
  let proxyRotator: ProxyRotator;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSocksInstances.length = 0;
    mockChildren.length = 0;

    mockEnsureConfigs.mockReturnValue({
      serverConfigPath: './data/wireguard/device-1.json',
      clientPrivateKey: 'mock-client-privkey',
      serverPublicKey: 'mock-server-pubkey',
      clientAddress: '10.0.0.2/32',
      serverEndpoint: '192.168.1.100:51820',
    });

    const cp = await import('child_process');
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>;

    proxyRotator = {
      getNextProxy: vi.fn().mockReturnValue(null),
    } as unknown as ProxyRotator;

    manager = new MitmproxyManager(
      proxyRotator,
      'http://localhost:3000/v1/traffic/ingest',
      'python/mitmproxy_bridge.py',
    );
  });

  afterEach(() => {
    // Don't use vi.restoreAllMocks() — it resets vi.mock() factory implementations
  });

  describe('startCapture', () => {
    it("threads the device's resolved LAN IP into ensureConfigs", async () => {
      // The whole point of resolving it: ensureConfigs uses it to pick a
      // WireGuard endpoint on the phone's own subnet. Passing it through is the
      // difference between a reachable endpoint and the VPN address that made
      // the tunnel come up and move zero bytes.
      mockGetDeviceLanIp.mockResolvedValueOnce('192.168.1.196');

      await manager.startCapture('device-lan');

      expect(mockGetDeviceLanIp).toHaveBeenCalledWith('device-lan');
      expect(mockEnsureConfigs).toHaveBeenCalledWith('device-lan', 51820, '192.168.1.196');
    });

    it('still starts capture when the device LAN IP cannot be resolved', async () => {
      mockGetDeviceLanIp.mockRejectedValueOnce(new Error('device offline'));

      await expect(manager.startCapture('device-nolan')).resolves.toBeDefined();
      expect(mockEnsureConfigs).toHaveBeenCalledWith('device-nolan', 51820, undefined);
    });

    it('calls ensureConfigs and spawns mitmdump with @port suffix', async () => {
      await manager.startCapture('device-1');

      expect(mockEnsureConfigs).toHaveBeenCalledWith('device-1', 51820, undefined);
      // The branch resolves mitmdump through resolveVenvBin() (so the venv
      // copy wins over any host install), so the command is an absolute
      // path ending in mitmdump rather than the bare 'mitmdump' name.
      expect(spawnMock).toHaveBeenCalledWith(
        // .exe on Windows venvs, extensionless on POSIX.
        expect.stringMatching(/mitmdump(\.exe)?$/),
        expect.arrayContaining([
          '--mode', 'wireguard:./data/wireguard/device-1.json@51820',
          '-s', expect.stringContaining('mitmproxy_bridge.py'),
          '--set', 'node_webhook=http://localhost:3000/v1/traffic/ingest',
        ]),
        expect.any(Object),
      );
    });

    it('returns WireGuardTunnelInfo', async () => {
      const result = await manager.startCapture('device-1');

      expect(result).toEqual({
        clientPrivateKey: 'mock-client-privkey',
        serverPublicKey: 'mock-server-pubkey',
        clientAddress: '10.0.0.2/32',
        serverEndpoint: '192.168.1.100:51820',
      });
    });

    it('returns undefined when capture already running', async () => {
      await manager.startCapture('device-1');
      const result = await manager.startCapture('device-1');

      expect(result).toBeUndefined();
    });

    it('uses custom wgPort when provided', async () => {
      await manager.startCapture('device-1', { wgPort: 9999 });

      expect(mockEnsureConfigs).toHaveBeenCalledWith('device-1', 9999, undefined);
      const args = spawnMock.mock.calls[0][1] as string[];
      const modeIdx = args.indexOf('--mode');
      expect(args[modeIdx + 1]).toBe('wireguard:./data/wireguard/device-1.json@9999');
    });

    it('passes device_id and session_id as --set flags', async () => {
      await manager.startCapture('device-1', {
        deviceId: 'device-1',
        sessionId: 42,
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      const deviceIdIdx = args.indexOf('device_id=device-1');
      expect(deviceIdIdx).toBeGreaterThan(-1);
      expect(args[deviceIdIdx - 1]).toBe('--set');

      const sessionIdIdx = args.indexOf('session_id=42');
      expect(sessionIdIdx).toBeGreaterThan(-1);
      expect(args[sessionIdIdx - 1]).toBe('--set');
    });

    it('does not pass device_id/session_id when not provided', async () => {
      await manager.startCapture('device-1');

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args.join(' ')).not.toContain('device_id=');
      expect(args.join(' ')).not.toContain('session_id=');
    });

    it('sets PYTHONUNBUFFERED=1 in spawn env', async () => {
      await manager.startCapture('device-1');

      const spawnOpts = spawnMock.mock.calls[0][2];
      expect(spawnOpts.env.PYTHONUNBUFFERED).toBe('1');
    });

    it('does not spawn a second process for the same device', async () => {
      await manager.startCapture('device-1');
      await manager.startCapture('device-1');

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('starts local SOCKS5 bridge for socks5Proxy option', async () => {
      await manager.startCapture('device-1', {
        socks5Proxy: {
          host: 'us.socks.nordhold.net',
          port: 1080,
          username: 'user',
          password: 'pass',
        },
      });

      // Verify a SocksProxyServer was created and started
      expect(mockSocksInstances).toHaveLength(1);
      expect(mockSocksInstances[0].start).toHaveBeenCalled();

      // Verify mitmproxy gets the local bridge as upstream proxy
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain('upstream_proxy_url=http://127.0.0.1:19876');
    });
  });

  describe('stopCapture', () => {
    it('kills the process for the device', async () => {
      await manager.startCapture('device-1');
      await manager.stopCapture('device-1');

      expect(mockKill).toHaveBeenCalledWith('SIGINT');
    });

    it('does nothing if no capture is running', async () => {
      await manager.stopCapture('device-1');
      expect(mockKill).not.toHaveBeenCalled();
    });

    it('stops socks proxy server on stop', async () => {
      await manager.startCapture('device-1', {
        socks5Proxy: {
          host: 'us.socks.nordhold.net',
          port: 1080,
          username: 'user',
          password: 'pass',
        },
      });

      await manager.stopCapture('device-1');

      expect(mockSocksInstances[0].stop).toHaveBeenCalled();
    });
  });

  describe('isCapturing', () => {
    it('returns true when capture is active', async () => {
      await manager.startCapture('device-1');
      expect(manager.isCapturing('device-1')).toBe(true);
    });

    it('returns false when no capture is active', () => {
      expect(manager.isCapturing('device-1')).toBe(false);
    });

    it('returns false after stopCapture', async () => {
      await manager.startCapture('device-1');
      await manager.stopCapture('device-1');
      expect(manager.isCapturing('device-1')).toBe(false);
    });
  });

  describe('stopAll', () => {
    it('stops all active captures', async () => {
      await manager.startCapture('device-1');
      await manager.startCapture('device-2');
      manager.stopAll();

      // stopAll is fire-and-forget, but kill should be called synchronously
      expect(mockKill).toHaveBeenCalledTimes(2);
      expect(manager.isCapturing('device-1')).toBe(false);
      expect(manager.isCapturing('device-2')).toBe(false);
    });
  });
});
