import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  generateKeyPair,
  derivePublicKey,
  generateServerConfig,
  generateClientWgConfig,
  getServerIp,
  ensureConfigs,
} from './wireguard-config';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

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
