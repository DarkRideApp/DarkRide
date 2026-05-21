import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createLoggers } from '../logs';
import { ProxyRotator } from './proxy-rotator';
import { ensureConfigs, type WireGuardTunnelInfo } from './wireguard-config';
import { getBlocklistPath } from './blocklist-writer';
import { getHiddenlistPath } from './hiddenlist-writer';
import { SocksProxyServer } from './socks-proxy-server';
import { syncInterceptConfig, getInterceptConfigPath } from './intercept-config-writer';
import { clearWsFlowMap } from '../api/traffic';
import { resolveVenvBin } from './venv-bin';
import type { AppDatabase } from '../db';

const { log, error } = createLoggers('mitmproxy-manager');

/** Ask the OS for a free TCP port on 127.0.0.1. Subject to TOCTOU but acceptable here. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Persistent directory for mitmproxy CA certs. Uses MITMPROXY_DATA env var
 * (set in Dockerfile/ansible) or falls back to ~/.mitmproxy.
 * This ensures the same CA cert is reused across restarts so devices
 * (especially iPhones) don't need to reinstall the certificate.
 */
export function getMitmproxyConfdir(): string {
  return process.env.MITMPROXY_DATA
    ? path.resolve(process.env.MITMPROXY_DATA)
    : path.join(os.homedir(), '.mitmproxy');
}

/**
 * If certs exist in ~/.mitmproxy but not in the configured confdir,
 * copy them over so existing installations keep working.
 */
function migrateCertsIfNeeded(confdir: string): void {
  const defaultDir = path.join(os.homedir(), '.mitmproxy');
  if (confdir === defaultDir) return;

  const certFile = 'mitmproxy-ca.pem';
  const target = path.join(confdir, certFile);
  const source = path.join(defaultDir, certFile);

  if (!fs.existsSync(target) && fs.existsSync(source)) {
    fs.mkdirSync(confdir, { recursive: true });
    // Copy all mitmproxy CA files to preserve the full key set
    for (const f of fs.readdirSync(defaultDir)) {
      if (f.startsWith('mitmproxy-ca')) {
        fs.copyFileSync(path.join(defaultDir, f), path.join(confdir, f));
      }
    }
    log(`Migrated existing CA certs from ${defaultDir} to ${confdir}`);
  }
}

export interface Socks5Proxy {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface MitmproxyOptions {
  useProxy?: boolean;
  webhookUrl?: string;
  wgConfigPath?: string;
  wgPort?: number;
  sessionId?: number;
  deviceId?: string;
  socks5Proxy?: Socks5Proxy;
  tlsProfile?: string;
  interceptHooks?: boolean;
}

export class MitmproxyManager {
  private processes = new Map<string, ChildProcess>();
  private socksProxies = new Map<string, SocksProxyServer>();

  constructor(
    private proxyRotator: ProxyRotator,
    private defaultWebhookUrl: string,
    private bridgeScriptPath: string = 'python/mitmproxy_bridge.py',
    private db?: AppDatabase,
  ) {}

  /**
   * Start a mitmdump capture for a device in WireGuard mode.
   * Returns WireGuardTunnelInfo so the caller can configure the device tunnel.
   */
  async startCapture(deviceId: string, options?: MitmproxyOptions): Promise<WireGuardTunnelInfo | undefined> {
    if (this.processes.has(deviceId)) {
      log(`Capture already running for device ${deviceId}`);
      return undefined;
    }

    const wgPort = options?.wgPort ?? 51820;
    const configs = ensureConfigs(deviceId, wgPort);
    const webhookUrl = options?.webhookUrl || this.defaultWebhookUrl;
    const wgConfigPath = configs.serverConfigPath;

    const absoluteScriptPath = path.resolve(this.bridgeScriptPath);
    const confdir = getMitmproxyConfdir();
    migrateCertsIfNeeded(confdir);
    const mitmdumpArgs: string[] = [
      '--set', `confdir=${confdir}`,
      '--mode', `wireguard:${wgConfigPath}@${wgPort}`,
      '-s', absoluteScriptPath,
      '--set', `node_webhook=${webhookUrl}`,
    ];

    // Pass blocklist file path so the bridge can enforce domain blocking
    mitmdumpArgs.push('--set', `blocklist_file=${path.resolve(getBlocklistPath())}`);

    // Pass hiddenlist file path so the bridge can silently skip hidden domain traffic
    mitmdumpArgs.push('--set', `hiddenlist_file=${path.resolve(getHiddenlistPath())}`);

    // Write and pass intercept config file (rules + client certs) to the bridge
    if (this.db) {
      syncInterceptConfig(this.db);
      mitmdumpArgs.push('--set', `intercept_config_file=${getInterceptConfigPath()}`);
    }

    // Pass device/session context to the Python bridge
    if (options?.deviceId) {
      mitmdumpArgs.push('--set', `device_id=${options.deviceId}`);
    }
    if (options?.sessionId != null) {
      mitmdumpArgs.push('--set', `session_id=${options.sessionId}`);
    }

    // TLS fingerprint profile
    if (options?.tlsProfile) {
      mitmdumpArgs.push('--set', `tls_profile=${options.tlsProfile}`);
    }

    // Enable traffic interception hooks
    if (options?.interceptHooks) {
      mitmdumpArgs.push('--set', 'intercept_hooks=true');
    }

    // SOCKS5 mode: start a local HTTP proxy that tunnels through SOCKS5,
    // then tell mitmproxy to use it via the addon's server_connect hook
    if (options?.socks5Proxy) {
      const proxyServer = new SocksProxyServer(options.socks5Proxy);
      const localPort = await proxyServer.start();
      this.socksProxies.set(deviceId, proxyServer);

      // Verify SOCKS5 connectivity with a test request
      const testIp = await proxyServer.testConnection();
      if (testIp) {
        log(`SOCKS5 proxy verified for ${deviceId}: external IP = ${testIp}`);
      } else {
        // Stop the proxy server since we're not going to use it
        proxyServer.stop();
        this.socksProxies.delete(deviceId);
        throw new Error('NordVPN proxy connection failed — check credentials and connectivity. The SOCKS5 proxy at ' +
          `${options.socks5Proxy.host}:${options.socks5Proxy.port} did not respond.`);
      }

      mitmdumpArgs.push('--set', `upstream_proxy_url=http://127.0.0.1:${localPort}`);
      log(`Using SOCKS5 proxy via local bridge for device ${deviceId}: ${options.socks5Proxy.host}:${options.socks5Proxy.port} -> localhost:${localPort}`);
    } else if (options?.useProxy !== false) {
      // Direct or HTTP proxy mode (existing rotation)
      const proxy = this.proxyRotator.getNextProxy();
      if (proxy) {
        let proxyUrl = proxy.url;
        if (proxy.username && proxy.password) {
          const urlObj = new URL(proxy.url);
          urlObj.username = proxy.username;
          urlObj.password = proxy.password;
          proxyUrl = urlObj.toString();
        }
        mitmdumpArgs.push('--set', `upstream_proxy_url=${proxyUrl}`);
        log(`Using upstream proxy ${proxy.id} for device ${deviceId}`);
      }
    }

    const mitmdumpBin = resolveVenvBin('mitmdump');
    log(`Starting mitmdump for ${deviceId} (${mitmdumpBin})`);
    const child = spawn(mitmdumpBin, mitmdumpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Wait for [DarkRide] READY sentinel before declaring capture started.
    // mitmproxy needs time to initialise the WireGuard listener and the addon
    // before the device tunnel can be activated.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('mitmproxy did not become ready within 30s')),
        30_000,
      );

      const onData = (data: Buffer) => {
        if (data.toString().includes('[DarkRide] READY')) {
          clearTimeout(timeout);
          child.stdout?.off('data', onData);
          resolve();
        }
      };

      child.stdout?.on('data', onData);

      child.once('exit', (code) => {
        clearTimeout(timeout);
        child.stdout?.off('data', onData);
        reject(new Error(`mitmproxy exited with code ${code} before becoming ready`));
      });
    });

    // Log all [DarkRide] lines from stdout for observability
    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes('[DarkRide]')) log(`[${deviceId}] ${trimmed}`);
      }
    });

    // Surface all mitmproxy stderr — [DarkRide] lines as errors, rest as info
    child.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes('[DarkRide]')) {
          error(`[mitm-${deviceId}] ${trimmed}`);
        } else {
          log(`[mitm-${deviceId}] ${trimmed}`);
        }
      }
    });

    // Guard against stale exit/error handlers from a previous process.
    // After restartCapture, the old process may fire 'exit' after the new one
    // is already registered in the map. Only delete if it's still OUR child.
    child.on('exit', (code) => {
      log(`mitmdump for device ${deviceId} exited with code ${code}`);
      if (this.processes.get(deviceId) === child) {
        this.processes.delete(deviceId);
      }
    });

    child.on('error', (err) => {
      error(`mitmdump for device ${deviceId} error: ${err.message}`);
      if (this.processes.get(deviceId) === child) {
        this.processes.delete(deviceId);
      }
    });

    this.processes.set(deviceId, child);

    // Block until addon signals readiness (or timeout/crash)
    try {
      await readyPromise;
    } catch (err: any) {
      this.processes.delete(deviceId);
      child.kill('SIGKILL');
      throw err;
    }

    return {
      clientPrivateKey: configs.clientPrivateKey,
      serverPublicKey: configs.serverPublicKey,
      clientAddress: configs.clientAddress,
      serverEndpoint: configs.serverEndpoint,
    };
  }

  /**
   * Start a mitmdump capture in regular HTTP forward-proxy mode (no
   * WireGuard tunnel). Used by docker-android emulators, where the
   * device is reachable via `adb reverse` rather than the WireGuard
   * routing path used by physical devices.
   *
   * Picks a free localhost port for mitmproxy to listen on; the caller
   * is responsible for wiring the device to point at it (e.g. via
   * `adb shell settings put global http_proxy 127.0.0.1:<port>` paired
   * with `adb reverse tcp:<port> tcp:<port>`).
   *
   * Shares the same `processes` map as `startCapture` so `stopCapture`
   * and `isCapturing` work uniformly across modes.
   */
  async startHttpProxyCapture(deviceId: string, options?: MitmproxyOptions): Promise<{ port: number }> {
    if (this.processes.has(deviceId)) {
      log(`Capture already running for device ${deviceId}`);
      // The caller doesn't know the port the existing process is on;
      // return a sentinel that forces them to reconcile rather than
      // silently reusing a (potentially different) port.
      throw new Error(`Capture already running for device ${deviceId} — stop it first`);
    }

    // Pick a free port on localhost so several emulators can capture in parallel.
    const port = await pickFreePort();

    const absoluteScriptPath = path.resolve(this.bridgeScriptPath);
    const confdir = getMitmproxyConfdir();
    migrateCertsIfNeeded(confdir);
    const webhookUrl = options?.webhookUrl || this.defaultWebhookUrl;
    const mitmdumpArgs: string[] = [
      '--set', `confdir=${confdir}`,
      // Listen on all interfaces so docker-android emulators can reach
      // mitmproxy via the host's docker-bridge gateway (typically
      // 172.17.0.1 on Linux). adb reverse + 127.0.0.1 doesn't work for
      // arbitrary ports on emulators — only the adb transport itself.
      '--listen-host', '0.0.0.0',
      '--listen-port', String(port),
      '-s', absoluteScriptPath,
      '--set', `node_webhook=${webhookUrl}`,
      '--set', `blocklist_file=${path.resolve(getBlocklistPath())}`,
      '--set', `hiddenlist_file=${path.resolve(getHiddenlistPath())}`,
    ];
    if (this.db) {
      syncInterceptConfig(this.db);
      mitmdumpArgs.push('--set', `intercept_config_file=${getInterceptConfigPath()}`);
    }
    if (options?.deviceId) mitmdumpArgs.push('--set', `device_id=${options.deviceId}`);
    if (options?.sessionId != null) mitmdumpArgs.push('--set', `session_id=${options.sessionId}`);
    if (options?.tlsProfile) mitmdumpArgs.push('--set', `tls_profile=${options.tlsProfile}`);
    if (options?.interceptHooks) mitmdumpArgs.push('--set', 'intercept_hooks=true');

    const mitmdumpBin = resolveVenvBin('mitmdump');
    log(`Starting mitmdump (http-proxy mode) for ${deviceId} on 127.0.0.1:${port} (${mitmdumpBin})`);
    const child = spawn(mitmdumpBin, mitmdumpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('mitmproxy did not become ready within 30s')),
        30_000,
      );
      const onData = (data: Buffer) => {
        if (data.toString().includes('[DarkRide] READY')) {
          clearTimeout(timeout);
          child.stdout?.off('data', onData);
          resolve();
        }
      };
      child.stdout?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        child.stdout?.off('data', onData);
        reject(new Error(`mitmproxy exited with code ${code} before becoming ready`));
      });
    });

    child.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes('[DarkRide]')) log(`[${deviceId}] ${trimmed}`);
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes('[DarkRide]')) {
          error(`[mitm-${deviceId}] ${trimmed}`);
        } else {
          log(`[mitm-${deviceId}] ${trimmed}`);
        }
      }
    });

    child.on('exit', (code) => {
      log(`mitmdump for device ${deviceId} exited with code ${code}`);
      if (this.processes.get(deviceId) === child) this.processes.delete(deviceId);
    });
    child.on('error', (err) => {
      error(`mitmdump for device ${deviceId} error: ${err.message}`);
      if (this.processes.get(deviceId) === child) this.processes.delete(deviceId);
    });

    this.processes.set(deviceId, child);

    try {
      await readyPromise;
    } catch (err: any) {
      this.processes.delete(deviceId);
      child.kill('SIGKILL');
      throw err;
    }

    return { port };
  }

  /**
   * Stop the mitmdump capture for a device.
   * Returns a Promise that resolves when the process has exited.
   */
  stopCapture(deviceId: string): Promise<void> {
    const child = this.processes.get(deviceId);
    if (!child) {
      log(`No capture running for device ${deviceId}`);
      return Promise.resolve();
    }

    log(`Stopping mitmdump for device ${deviceId}`);
    this.processes.delete(deviceId);

    // Clean up any tracked WebSocket flows for this device
    clearWsFlowMap(deviceId);

    // Stop the local SOCKS5-to-HTTP bridge if one was running
    const proxyServer = this.socksProxies.get(deviceId);
    if (proxyServer) {
      proxyServer.stop();
      this.socksProxies.delete(deviceId);
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log(`mitmdump for ${deviceId} did not exit in time, killing`);
        child.kill('SIGKILL');
        resolve();
      }, 3000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // If the process already exited (e.g. crashed), resolve immediately
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      // Use SIGINT for graceful shutdown — mitmproxy handles it to flush and exit cleanly.
      child.kill('SIGINT');
    });
  }

  /**
   * Restart capture for a device with new options (e.g. switching proxy mode).
   * Waits for the old process to exit before starting the new one.
   */
  async restartCapture(deviceId: string, options?: MitmproxyOptions): Promise<WireGuardTunnelInfo | undefined> {
    await this.stopCapture(deviceId);
    return this.startCapture(deviceId, options);
  }

  /**
   * Check if capture is active for a device.
   */
  isCapturing(deviceId: string): boolean {
    return this.processes.has(deviceId);
  }

  /**
   * Generate a WireGuard configuration for a device.
   */
  generateWireGuardConfig(serverPublicKey: string, serverEndpoint: string, clientPrivateKey: string, clientAddress: string): string {
    return [
      '[Interface]',
      `PrivateKey = ${clientPrivateKey}`,
      `Address = ${clientAddress}`,
      'DNS = 1.1.1.1',
      '',
      '[Peer]',
      `PublicKey = ${serverPublicKey}`,
      `Endpoint = ${serverEndpoint}`,
      'AllowedIPs = 0.0.0.0/0',
      'PersistentKeepalive = 25',
    ].join('\n');
  }

  /**
   * Inject SSL certificate onto a rooted device via ADB.
   * Returns the shell commands to run.
   */
  getSslCertInjectionCommands(certPath: string): string[] {
    return [
      `adb push ${certPath} /data/local/tmp/mitm.pem`,
      `adb shell "su -c '` +
        `hash=$(openssl x509 -inform PEM -subject_hash_old -in /data/local/tmp/mitm.pem | head -1) && ` +
        `cp /data/local/tmp/mitm.pem /data/local/tmp/$hash.0 && ` +
        `mount -t tmpfs tmpfs /system/etc/security/cacerts && ` +
        `cp /apex/com.android.conscrypt/cacerts/* /system/etc/security/cacerts/ && ` +
        `mv /data/local/tmp/$hash.0 /system/etc/security/cacerts/ && ` +
        `chown root:root /system/etc/security/cacerts/* && ` +
        `chmod 644 /system/etc/security/cacerts/*` +
        `'"`,
    ];
  }

  /**
   * Stop all active captures (for shutdown).
   */
  stopAll(): void {
    for (const [deviceId] of this.processes) {
      // Fire-and-forget during shutdown — don't await
      this.stopCapture(deviceId);
    }
  }
}
