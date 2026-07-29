import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLoggers } from '../logs';
import { safeJoinInside } from '../utils/safe-path';

const execFileAsync = promisify(execFile);

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

/** Parse an IPv4 dotted-quad to a 32-bit unsigned int, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // Require plain decimal digits. `Number()` alone would accept '', '0x10',
    // '4e0', ' 4' and '+4' — so a truncated address like '1.2.3.' would parse
    // as 1.2.3.0 and silently compare against the wrong subnet.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

/** True if `a` and `b` fall in the same IPv4 subnet under `netmask`. */
function sameSubnet(a: string, b: string, netmask: string): boolean {
  const ai = ipv4ToInt(a);
  const bi = ipv4ToInt(b);
  const mi = ipv4ToInt(netmask);
  if (ai === null || bi === null || mi === null) return false;
  return ((ai & mi) >>> 0) === ((bi & mi) >>> 0);
}

/**
 * Interface-name substrings that mark a virtual / VPN / overlay adapter which
 * is never the LAN path to a USB- or WiFi-attached phone. Matched
 * case-insensitively. Name-based detection is far more reliable than IP-range
 * guessing: a real home/office LAN legitimately uses 10.x and 172.x, so those
 * ranges can't be blanket-excluded — but a `NordLynx` / `tailscale` / `docker`
 * / WSL `vEthernet` adapter can be, by name, regardless of its address.
 */
const VIRTUAL_IFACE_HINTS = [
  // VPN / overlay. Short forms subsume longer ones under substring matching:
  // 'nord' covers 'nordlynx', 'wg' covers 'wireguard', 'tun' covers 'utun',
  // 'veth' covers 'vEthernet'.
  'nord', 'tailscale', 'zerotier', 'hamachi', 'wg', 'tun', 'tap', 'ppp',
  // Hypervisor / container host bridges.
  'veth', 'wsl', 'docker', 'hyper-v', 'hyperv', 'vmware', 'virtualbox', 'vbox', 'virbr',
  // Npcap / MS KM-TEST loopback adapters report internal:false, so the
  // os.networkInterfaces() `internal` filter alone doesn't catch them.
  'loopback',
];
/**
 * Prefix-matched (not substring) because these are short enough to appear
 * inside legitimate adapter names. `br-<hex>` is a Docker user-defined /
 * Compose network bridge; `zt<hex>` is ZeroTier on Linux.
 */
const VIRTUAL_IFACE_PATTERNS = [/^br-[0-9a-f]+$/i, /^zt[0-9a-z]{6,}$/i];

function isVirtualIface(name: string): boolean {
  const n = name.toLowerCase();
  if (VIRTUAL_IFACE_HINTS.some((hint) => n.includes(hint))) return true;
  return VIRTUAL_IFACE_PATTERNS.some((re) => re.test(n));
}

interface HostIface { name: string; address: string; netmask: string; }

function hostIpv4Ifaces(): HostIface[] {
  const interfaces = os.networkInterfaces();
  const out: HostIface[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // 169.254.0.0/16 is APIPA/link-local — assigned when DHCP fails and never
      // routable off-link, so it can never be a WireGuard endpoint.
      if (iface.address.startsWith('169.254.')) continue;
      out.push({ name, address: iface.address, netmask: iface.netmask });
    }
  }
  return out;
}

/**
 * Get the host IP a device should dial for the WireGuard endpoint.
 *
 * When `deviceLanIp` is known, we pick the host interface on the SAME subnet as
 * the device — that address is reachable by construction, which is the only
 * thing that actually matters for the handshake. This is what makes capture
 * work when the host is also on a VPN (NordVPN/Tailscale): those adapters are a
 * different subnet, so they're never chosen.
 *
 * Without `deviceLanIp` (or if nothing matched), fall back to a heuristic:
 * drop virtual/VPN adapters by name, then prefer a private LAN address. The old
 * heuristic returned the first non-192.168 address in enumeration order, which
 * on a VPN-connected host with no 192.168 LAN was often a NordVPN 10.x or a
 * link-local 169.254 address the phone could never reach.
 *
 * `WG_SERVER_IP` overrides everything.
 */
export function getServerIp(deviceLanIp?: string): string {
  if (process.env.WG_SERVER_IP) {
    return process.env.WG_SERVER_IP;
  }

  const candidates = hostIpv4Ifaces();

  // Best: a host interface on the device's own subnet — reachable by
  // construction. Prefer a non-virtual adapter if more than one matches.
  if (deviceLanIp) {
    const sameNet = candidates.filter((c) => sameSubnet(c.address, deviceLanIp, c.netmask));
    const chosen = sameNet.find((c) => !isVirtualIface(c.name)) ?? sameNet[0];
    if (chosen) return chosen.address;
  }

  // Fallback heuristic: prefer real (non-virtual) adapters, then a LAN address.
  const physical = candidates.filter((c) => !isVirtualIface(c.name));
  const pool = physical.length ? physical : candidates;
  const is192 = (a: string) => a.startsWith('192.168.');
  const isPrivate = (a: string) => a.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return (
    pool.find((c) => is192(c.address))?.address ??
    pool.find((c) => isPrivate(c.address))?.address ??
    pool[0]?.address ??
    '127.0.0.1'
  );
}

/**
 * Resolve the device's own LAN IPv4 — the address the WireGuard endpoint should
 * live on the same subnet as. Reads the device's interface list over ADB and
 * prefers WiFi (`wlan*`), then cellular (`rmnet*`). Deliberately ignores the
 * capture tunnel (`wg*`) and loopback, and any 169.254 link-local, so a stale
 * tunnel from a previous attempt can't shadow the real LAN address.
 *
 * Returns undefined if ADB is unavailable or the device has no usable LAN
 * address; callers then fall back to {@link getServerIp}'s heuristic.
 */
export async function getDeviceLanIp(deviceId: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'adb', ['-s', deviceId, 'shell', 'ip -o -4 addr show'], { timeout: 5000 },
    );
    const rows = stdout.split('\n')
      .map((line) => {
        // e.g. "23: wlan0    inet 10.180.85.74/24 brd 10.180.85.255 scope global wlan0"
        const m = line.match(/^\s*\d+:\s+(\S+)\s+inet\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        return m ? { iface: m[1], ip: m[2] } : null;
      })
      .filter((r): r is { iface: string; ip: string } => r !== null)
      // Skip loopback, our own capture tunnel, link-local, and the device's own
      // VPN interfaces. The last matters for the same reason we skip VPN
      // adapters host-side: this product's users often run a VPN app on the
      // phone, and returning its tun0 address makes every host interface look
      // "different subnet", silently reverting to the heuristic we're trying to
      // improve on.
      .filter((r) => r.iface !== 'lo'
        && !r.iface.startsWith('wg')
        && !r.iface.startsWith('tun')
        && !r.iface.startsWith('ppp')
        && !r.iface.startsWith('dummy')
        && !r.ip.startsWith('169.254.'));

    const wifi = rows.find((r) => r.iface.startsWith('wlan'));
    // rmnet* = Qualcomm, ccmni* = MediaTek. (There is no `radio*` convention.)
    const cellular = rows.find((r) => r.iface.startsWith('rmnet') || r.iface.startsWith('ccmni'));
    return (wifi ?? cellular ?? rows[0])?.ip;
  } catch {
    return undefined;
  }
}

/**
 * Ensure WireGuard configs exist for a device. Generates and writes them if missing.
 * Returns the paths and key info needed for tunnel setup.
 */
export function ensureConfigs(
  deviceId: string,
  serverPort: number = 51820,
  deviceLanIp?: string,
): EnsureConfigsResult {
  const configDir = path.resolve('./data/wireguard');
  const configPath = safeJoinInside(configDir, `${deviceId}.json`);

  // Client address: deterministic based on device position but simple default
  const clientAddress = '10.0.0.2/32';
  // Pick the endpoint on the device's own subnet when we know it, so the
  // handshake target is actually reachable from the phone (see getServerIp).
  const serverIp = getServerIp(deviceLanIp);
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
