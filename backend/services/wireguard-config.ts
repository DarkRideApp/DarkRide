import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLoggers } from '../logs';
import { safeJoinInside } from '../utils/safe-path';

const { log } = createLoggers('wireguard-config');

export interface WireGuardTunnelInfo {
  clientPrivateKey: string;
  serverPublicKey: string;
  clientAddress: string;
  serverEndpoint: string;
}

export interface EnsureConfigsResult extends WireGuardTunnelInfo {
  serverConfigPath: string;
}

/**
 * Generate an X25519 keypair and return base64-encoded raw 32-byte keys.
 */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  // X25519 DER private key: last 32 bytes contain the raw key
  const rawPrivate = privateKey.subarray(privateKey.length - 32);
  // X25519 DER public key: last 32 bytes contain the raw key
  const rawPublic = publicKey.subarray(publicKey.length - 32);

  return {
    privateKey: rawPrivate.toString('base64'),
    publicKey: rawPublic.toString('base64'),
  };
}

/**
 * Derive the X25519 public key from a base64-encoded private key.
 */
export function derivePublicKey(privateKeyBase64: string): string {
  const rawPrivate = Buffer.from(privateKeyBase64, 'base64');

  // Wrap the raw 32-byte key in PKCS#8 DER format for X25519
  // Fixed prefix for X25519 PKCS#8 DER encoding
  const pkcs8Prefix = Buffer.from(
    '302e020100300506032b656e04220420',
    'hex',
  );
  const pkcs8Der = Buffer.concat([pkcs8Prefix, rawPrivate]);

  const keyObj = crypto.createPrivateKey({
    key: pkcs8Der,
    format: 'der',
    type: 'pkcs8',
  });

  // Generate a keypair using the same private key to extract the public key
  // Use crypto.diffieHellman-like approach: export as JWK which includes both keys
  const jwk = keyObj.export({ format: 'jwk' }) as { x?: string };
  // JWK 'x' field is the base64url-encoded public key
  const rawPublic = Buffer.from(jwk.x!, 'base64url');
  return rawPublic.toString('base64');
}

/**
 * Generate mitmproxy's WireGuard JSON config.
 * Format: { "server_key": "<privkey>", "client_key": "<privkey>" }
 */
export function generateServerConfig(
  serverPrivateKey: string,
  clientPrivateKey: string,
): string {
  return JSON.stringify({
    server_key: serverPrivateKey,
    client_key: clientPrivateKey,
  });
}

/**
 * Generate a WireGuard `wg setconf` compatible INI config for the device.
 */
export function generateClientWgConfig(
  clientPrivateKey: string,
  serverPublicKey: string,
  serverEndpoint: string,
  clientAddress: string,
): string {
  return [
    '[Interface]',
    `PrivateKey = ${clientPrivateKey}`,
    '',
    '[Peer]',
    `PublicKey = ${serverPublicKey}`,
    `Endpoint = ${serverEndpoint}`,
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 25',
  ].join('\n');
}

/**
 * Check if an IPv4 address belongs to a VPN/overlay network range
 * that Android devices on a LAN typically can't reach directly.
 */
function isVpnAddress(address: string): boolean {
  // Tailscale/CGNAT: 100.64.0.0/10
  if (address.startsWith('100.')) {
    const second = parseInt(address.split('.')[1], 10);
    if (second >= 64 && second <= 127) return true;
  }
  // Docker: 172.17.x.x - 172.31.x.x (common Docker bridge ranges)
  if (address.startsWith('172.')) {
    const second = parseInt(address.split('.')[1], 10);
    if (second >= 17 && second <= 31) return true;
  }
  // WireGuard/VPN common ranges: 10.0.0.x, 10.x.x.x (only skip narrow VPN ranges)
  // Don't skip all of 10.x.x.x since it's also used for real LANs
  return false;
}

/**
 * Get the server IP address for the WireGuard endpoint.
 * Uses WG_SERVER_IP env var or falls back to best non-internal IPv4 address.
 * Prefers LAN addresses over VPN/overlay addresses.
 */
export function getServerIp(): string {
  if (process.env.WG_SERVER_IP) {
    return process.env.WG_SERVER_IP;
  }

  const interfaces = os.networkInterfaces();
  let preferred: string | null = null;  // 192.168.x.x — almost always real LAN
  let secondary: string | null = null;  // other non-VPN IPv4
  let fallback: string | null = null;   // VPN addresses (last resort)

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (isVpnAddress(iface.address)) {
          if (!fallback) fallback = iface.address;
        } else if (iface.address.startsWith('192.168.')) {
          if (!preferred) preferred = iface.address;
        } else {
          if (!secondary) secondary = iface.address;
        }
      }
    }
  }

  return preferred || secondary || fallback || '127.0.0.1';
}

/**
 * Ensure WireGuard configs exist for a device. Generates and writes them if missing.
 * Returns the paths and key info needed for tunnel setup.
 */
export function ensureConfigs(
  deviceId: string,
  serverPort: number = 51820,
): EnsureConfigsResult {
  const configDir = path.resolve('./data/wireguard');
  const configPath = safeJoinInside(configDir, `${deviceId}.json`);

  // Client address: deterministic based on device position but simple default
  const clientAddress = '10.0.0.2/32';
  const serverIp = getServerIp();
  const serverEndpoint = `${serverIp}:${serverPort}`;

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const serverPublicKey = derivePublicKey(existing.server_key);
    return {
      serverConfigPath: configPath,
      clientPrivateKey: existing.client_key,
      serverPublicKey,
      clientAddress,
      serverEndpoint,
    };
  }

  // Generate new keypairs
  const serverKeyPair = generateKeyPair();
  const clientKeyPair = generateKeyPair();

  // Write mitmproxy JSON config
  fs.mkdirSync(configDir, { recursive: true });
  const serverConfig = generateServerConfig(
    serverKeyPair.privateKey,
    clientKeyPair.privateKey,
  );
  fs.writeFileSync(configPath, serverConfig, 'utf-8');

  log(`Generated WireGuard config for device ${deviceId} at ${configPath}`);

  return {
    serverConfigPath: configPath,
    clientPrivateKey: clientKeyPair.privateKey,
    serverPublicKey: serverKeyPair.publicKey,
    clientAddress,
    serverEndpoint,
  };
}
