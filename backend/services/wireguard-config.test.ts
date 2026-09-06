import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateKeyPair,
  derivePublicKey,
  generateServerConfig,
  generateClientWgConfig,
  getServerIp,
  getDeviceLanIp,
  ensureConfigs,
} from './wireguard-config';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

// `promisify(execFile)` is bound at module load, so spying on cp.execFile after
// the fact has no effect — the mock has to be in place at import time.
//
// The real `execFile` carries a `util.promisify.custom` implementation that
// resolves `{ stdout, stderr }`; without it `promisify` would resolve the bare
// stdout string and the production `const { stdout } = await ...` destructure
// would silently yield undefined. Reproduce that contract on the mock.
const mockExecFile = vi.hoisted(() => {
  const fn: any = vi.fn();
  fn[Symbol.for('nodejs.util.promisify.custom')] = (cmd: any, args: any, opts: any) =>
    new Promise((resolve, reject) => {
      fn(cmd, args, opts, (err: any, stdout: any, stderr: any) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return fn;
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, default: actual, execFile: mockExecFile };
});

/** Make the next `adb shell ip -o -4 addr show` return this stdout. */
function mockIpAddrOutput(stdout: string) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(null, stdout, '');
    return {} as any;
  });
}

describe('wireguard-config', () => {
  describe('generateKeyPair', () => {
    it('returns 44-char base64 strings for both keys', () => {
      const { privateKey, publicKey } = generateKeyPair();

      expect(privateKey).toHaveLength(44);
      expect(publicKey).toHaveLength(44);
    });

    it('returns valid base64', () => {
      const { privateKey, publicKey } = generateKeyPair();

      expect(Buffer.from(privateKey, 'base64').length).toBe(32);
      expect(Buffer.from(publicKey, 'base64').length).toBe(32);
    });

    it('generates different keypairs each time', () => {
      const pair1 = generateKeyPair();
      const pair2 = generateKeyPair();

      expect(pair1.privateKey).not.toBe(pair2.privateKey);
      expect(pair1.publicKey).not.toBe(pair2.publicKey);
    });
  });

  describe('derivePublicKey', () => {
    it('derives the correct public key from a private key', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const derived = derivePublicKey(privateKey);

      expect(derived).toBe(publicKey);
    });

    it('different private keys produce different public keys', () => {
      const pair1 = generateKeyPair();
      const pair2 = generateKeyPair();

      const pub1 = derivePublicKey(pair1.privateKey);
      const pub2 = derivePublicKey(pair2.privateKey);

      expect(pub1).not.toBe(pub2);
    });
  });

  describe('generateServerConfig', () => {
    it('returns valid JSON with server_key and client_key', () => {
      const config = generateServerConfig('server-priv', 'client-priv');
      const parsed = JSON.parse(config);

      expect(parsed).toEqual({
        server_key: 'server-priv',
        client_key: 'client-priv',
      });
    });
  });

  describe('generateClientWgConfig', () => {
    it('returns INI with expected fields', () => {
      const config = generateClientWgConfig(
        'client-priv-key',
        'server-pub-key',
        '192.168.1.100:51820',
        '10.0.0.2/32',
      );

      expect(config).toContain('[Interface]');
      expect(config).toContain('PrivateKey = client-priv-key');
      expect(config).toContain('[Peer]');
      expect(config).toContain('PublicKey = server-pub-key');
      expect(config).toContain('Endpoint = 192.168.1.100:51820');
      expect(config).toContain('AllowedIPs = 0.0.0.0/0');
      expect(config).toContain('PersistentKeepalive = 25');
    });

    it('does not include Address or DNS (wg setconf format)', () => {
      const config = generateClientWgConfig(
        'key', 'pub', '1.2.3.4:51820', '10.0.0.2/32',
      );

      expect(config).not.toContain('Address');
      expect(config).not.toContain('DNS');
    });
  });

  describe('getServerIp', () => {
    const originalEnv = process.env.WG_SERVER_IP;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.WG_SERVER_IP = originalEnv;
      } else {
        delete process.env.WG_SERVER_IP;
      }
    });

    it('returns WG_SERVER_IP env var when set', () => {
      process.env.WG_SERVER_IP = '10.10.10.10';
      expect(getServerIp()).toBe('10.10.10.10');
    });

    it('returns a valid IPv4 address when env var is not set', () => {
      delete process.env.WG_SERVER_IP;
      const ip = getServerIp();
      // Should be a valid IPv4 pattern
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    });
  });

  describe('getServerIp — endpoint selection', () => {
    // The device must be able to REACH the endpoint. The original heuristic
    // just grabbed a host address, so on a VPN-connected host it handed the
    // phone a host-only address (e.g. NordLynx 10.5.0.2): the tunnel came up,
    // transferred 0 bytes, and capture was silently dead.
    const originalEnv = process.env.WG_SERVER_IP;

    function mockIfaces(entries: Array<[string, string, string]>) {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue(
        Object.fromEntries(
          entries.map(([name, address, netmask]) => [
            name,
            [{ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null }],
          ]),
        ) as any,
      );
    }

    beforeEach(() => { delete process.env.WG_SERVER_IP; });
    afterEach(() => {
      vi.restoreAllMocks();
      if (originalEnv !== undefined) process.env.WG_SERVER_IP = originalEnv;
      else delete process.env.WG_SERVER_IP;
    });

    it('picks the host interface on the same subnet as the device', () => {
      mockIfaces([
        ['NordLynx', '10.5.0.2', '255.255.255.255'],
        ['WiFi', '192.168.1.160', '255.255.255.0'],
      ]);
      expect(getServerIp('192.168.1.196')).toBe('192.168.1.160');
    });

    it('never returns a VPN address the device cannot route to', () => {
      // Regression for the original bug: NordLynx sorted first and won.
      mockIfaces([
        ['NordLynx', '10.5.0.2', '255.255.255.0'],
        ['Ethernet', '192.168.1.160', '255.255.255.0'],
      ]);
      expect(getServerIp()).toBe('192.168.1.160');
      expect(getServerIp('192.168.1.196')).toBe('192.168.1.160');
    });

    it('prefers a physical interface over a virtual one on the same subnet', () => {
      mockIfaces([
        ['vEthernet (WSL)', '192.168.1.5', '255.255.255.0'],
        ['WiFi', '192.168.1.160', '255.255.255.0'],
      ]);
      expect(getServerIp('192.168.1.196')).toBe('192.168.1.160');
    });

    it('treats docker user bridges and ZeroTier as virtual', () => {
      mockIfaces([
        ['br-1a2b3c4d5e6f', '172.18.0.1', '255.255.0.0'],
        ['zt5u4bhbfe', '10.147.17.3', '255.255.255.0'],
        ['Ethernet', '192.168.1.160', '255.255.255.0'],
      ]);
      expect(getServerIp()).toBe('192.168.1.160');
    });

    it('falls back to the heuristic when no interface shares the device subnet', () => {
      mockIfaces([['WiFi', '192.168.1.160', '255.255.255.0']]);
      expect(getServerIp('10.99.99.99')).toBe('192.168.1.160');
    });

    it('falls back to a virtual interface rather than nothing', () => {
      mockIfaces([['Tailscale', '100.64.0.1', '255.255.255.0']]);
      expect(getServerIp()).toBe('100.64.0.1');
    });

    it('returns loopback when the host has no usable interface', () => {
      mockIfaces([]);
      expect(getServerIp('192.168.1.196')).toBe('127.0.0.1');
    });

    it('ignores 169.254 link-local addresses', () => {
      mockIfaces([
        ['Ethernet 2', '169.254.27.75', '255.255.0.0'],
        ['WiFi', '192.168.1.160', '255.255.255.0'],
      ]);
      expect(getServerIp()).toBe('192.168.1.160');
    });

    it('lets WG_SERVER_IP override even when a device IP is supplied', () => {
      process.env.WG_SERVER_IP = '203.0.113.9';
      mockIfaces([['WiFi', '192.168.1.160', '255.255.255.0']]);
      expect(getServerIp('192.168.1.196')).toBe('203.0.113.9');
    });
  });

  describe('getDeviceLanIp', () => {
    afterEach(() => mockExecFile.mockReset());

    it('prefers wlan over other interfaces', async () => {
      mockIpAddrOutput(
        '1: lo    inet 127.0.0.1/8 scope host lo\n'
        + '47: wlan0    inet 192.168.1.196/24 brd 192.168.1.255 scope global wlan0\n',
      );
      await expect(getDeviceLanIp('DEV1')).resolves.toBe('192.168.1.196');
    });

    it("ignores the capture tunnel and the phone's own VPN interfaces", async () => {
      // A stale wg0, or a VPN app on the phone, must not shadow the real LAN IP:
      // returning 10.0.0.2 makes every host interface look "different subnet"
      // and silently reverts to the heuristic this change exists to replace.
      mockIpAddrOutput(
        '52: wg0    inet 10.0.0.2/32 scope global wg0\n'
        + '60: tun0    inet 10.8.0.6/24 scope global tun0\n'
        + '47: wlan0    inet 192.168.1.196/24 brd 192.168.1.255 scope global wlan0\n',
      );
      await expect(getDeviceLanIp('DEV1')).resolves.toBe('192.168.1.196');
    });

    it('falls back to cellular when there is no wifi', async () => {
      mockIpAddrOutput('30: rmnet_data0    inet 10.51.22.9/30 scope global rmnet_data0\n');
      await expect(getDeviceLanIp('DEV1')).resolves.toBe('10.51.22.9');
    });

    it('skips link-local addresses', async () => {
      mockIpAddrOutput('47: wlan0    inet 169.254.9.9/16 scope link wlan0\n');
      await expect(getDeviceLanIp('DEV1')).resolves.toBeUndefined();
    });

    it('returns undefined when only a tunnel is present', async () => {
      mockIpAddrOutput('52: wg0    inet 10.0.0.2/32 scope global wg0\n');
      await expect(getDeviceLanIp('DEV1')).resolves.toBeUndefined();
    });

    it('degrades to undefined when adb fails', async () => {
      mockExecFile.mockImplementation((_c: any, _a: any, _o: any, cb: any) => {
        cb(new Error('device offline'), '', '');
        return {} as any;
      });
      await expect(getDeviceLanIp('DEV1')).resolves.toBeUndefined();
    });
  });

  describe('ensureConfigs', () => {
    const testDir = path.resolve('./data/wireguard');
    const testConfigPath = path.join(testDir, 'test-device-wg.json');

    beforeEach(() => {
      // Clean up any leftover test configs
      if (fs.existsSync(testConfigPath)) {
        fs.unlinkSync(testConfigPath);
      }
    });

    afterEach(() => {
      if (fs.existsSync(testConfigPath)) {
        fs.unlinkSync(testConfigPath);
      }
    });

    it('creates config file if it does not exist', () => {
      const result = ensureConfigs('test-device-wg', 51820);

      expect(fs.existsSync(testConfigPath)).toBe(true);
      expect(result.serverConfigPath).toBe(testConfigPath);
      expect(result.clientPrivateKey).toBeDefined();
      expect(result.serverPublicKey).toBeDefined();
      expect(result.clientAddress).toBe('10.0.0.2/32');
      expect(result.serverEndpoint).toContain(':51820');
    });

    it('reuses existing config file', () => {
      const result1 = ensureConfigs('test-device-wg', 51820);
      const result2 = ensureConfigs('test-device-wg', 51820);

      // Same keys should be returned
      expect(result2.clientPrivateKey).toBe(result1.clientPrivateKey);
      expect(result2.serverPublicKey).toBe(result1.serverPublicKey);
    });

    it('generates valid JSON config file', () => {
      ensureConfigs('test-device-wg', 51820);

      const content = fs.readFileSync(testConfigPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.server_key).toBeDefined();
      expect(parsed.client_key).toBeDefined();
      expect(Buffer.from(parsed.server_key, 'base64').length).toBe(32);
      expect(Buffer.from(parsed.client_key, 'base64').length).toBe(32);
    });

    it('uses provided port in server endpoint', () => {
      const result = ensureConfigs('test-device-wg', 12345);
      expect(result.serverEndpoint).toContain(':12345');
    });
  });
});
