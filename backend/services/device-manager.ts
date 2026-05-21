import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { eq } from 'drizzle-orm';
import { devices } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';
import { broadcastToAll } from '../websocket/index';
import { ensureMinicap, ensureMinitouch, getScrcpyServerJar } from './vendor-manager';
import type { WireGuardTunnelInfo } from './wireguard-config';
import { CURRENT_SETUP_VERSION } from '../../shared/types/api';
import type { DeviceFilter } from '../../shared/types/api';
import { matchesDeviceFilter, migrateDeviceFilter } from '../../shared/lib/device-filter';
import { getMitmproxyConfdir } from './mitmproxy-manager';
import type { HookBus } from '@darkrideapp/plugin-sdk';
import type { ProviderRegistry } from './providers';
import type { CaptureModeRegistry } from './capture-mode-registry';

const execFileAsync = promisify(execFile);

const { log, error } = createLoggers('device-manager');
const ADB_POLL_INTERVAL = 5000;
const STANDBY_TIMEOUT = 60000;
const MAX_BUSY_IDLE = 600_000; // 10 minutes without interaction — safety net for stuck-busy devices
const BUSY_IDLE_WARNING = 120_000; // Warn 2 minutes before forced idle
const MIN_BATTERY_LEVEL = 50;

export interface DeviceStatus {
  id: string;
  name: string | null;
  platform: 'android' | 'ios';
  isRooted: boolean;
  setupVersion: number;
  bridgePort: number | null;
  lastSeen: Date | null;
  batteryLevel: number | null;
  needsSetup: boolean;
  isBusy: boolean;
  isOnline: boolean;
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  iosVersion: string | null;
  apiLevel: number | null;
  cpuAbi: string | null;
  serialNumber: string | null;
  bootloaderLocked: boolean | null;
  // Extended iOS device info (Phase 1.5)
  wifiAddress?: string | null;
  wifiSsid?: string | null;
  bluetoothAddress?: string | null;
  phoneNumber?: string | null;
}

/**
 * Execute an ADB shell command on a specific device.
 *
 * `command` is the device-shell command to run — adb itself receives it as a
 * single argv slot, so the host shell is never invoked. The device shell DOES
 * interpret `command` (intentionally — callers rely on this for pipes,
 * redirection, etc.); the security boundary is that arbitrary `deviceId` or
 * other host-side data can never escape into a host-shell command line.
 */
export async function adbShell(deviceId: string, command: string, timeout: number = 10000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'shell', command], { timeout });
    return stdout.trim();
  } catch (err: any) {
    // execFileAsync errors include stdout/stderr — surface them in the error message
    const output = [err.stdout, err.stderr].filter(Boolean).map((s: string) => s.trim()).join('\n').trim();
    if (output) {
      throw new Error(`${err.message}\n${output}`);
    }
    throw err;
  }
}

/**
 * Execute a raw ADB command (non-shell). Arguments are passed as an argv
 * array so no host shell sees them.
 *
 * @example adbCommand(['-s', deviceId, 'push', localPath, remotePath])
 * @example adbCommand(['devices'])
 */
export async function adbCommand(args: string[], timeout: number = 10000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('adb', args, { timeout });
    return stdout.trim();
  } catch (err: any) {
    const output = [err.stdout, err.stderr].filter(Boolean).map((s: string) => s.trim()).join('\n').trim();
    if (output) {
      throw new Error(`${err.message}\n${output}`);
    }
    throw err;
  }
}

/**
 * Pull a file from a device to a local path.
 * Tries `adb pull` first; if that fails (common on non-rooted devices for
 * /data/app/ paths), falls back to streaming via `adb exec-out cat`.
 */
export async function adbPull(deviceId: string, remotePath: string, localPath: string, timeout: number = 5 * 60 * 1000): Promise<void> {
  try {
    await adbCommand(['-s', deviceId, 'pull', remotePath, localPath], timeout);
    return;
  } catch (pullErr: any) {
    log(`adb pull failed for ${remotePath}, trying exec-out cat fallback: ${pullErr.message?.split('\n')[0]}`);
  }

  // Fallback: stream via exec-out cat (uses different ADB code path)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('adb', ['-s', deviceId, 'exec-out', 'cat', remotePath]);
    const ws = fs.createWriteStream(localPath);
    let stderr = '';

    child.stdout.pipe(ws);
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`adb exec-out cat timed out after ${timeout / 1000}s`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Clean up partial file
        try { fs.unlinkSync(localPath); } catch {}
        reject(new Error(`adb exec-out cat failed (exit ${code}): ${stderr.trim()}`));
      } else {
        // Verify we actually got data
        try {
          const size = fs.statSync(localPath).size;
          if (size === 0) {
            try { fs.unlinkSync(localPath); } catch {}
            reject(new Error('adb exec-out cat produced empty file'));
          } else {
            resolve();
          }
        } catch (err: any) {
          reject(new Error(`Failed to verify pulled file: ${err.message}`));
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Read a DER TLV (Tag-Length-Value) element at the given offset.
 * Returns the content start offset and the end offset (past the value).
 */
function derReadTLV(buf: Buffer, offset: number): { tag: number; start: number; end: number } {
  const tag = buf[offset];
  let pos = offset + 1;
  let length: number;

  if (buf[pos] < 0x80) {
    length = buf[pos];
    pos += 1;
  } else if (buf[pos] === 0x81) {
    length = buf[pos + 1];
    pos += 2;
  } else if (buf[pos] === 0x82) {
    length = (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
  } else {
    throw new Error(`Unsupported DER length encoding: 0x${buf[pos].toString(16)}`);
  }

  return { tag, start: pos, end: pos + length };
}

/**
 * Compute OpenSSL's subject_hash_old for an X.509 certificate PEM.
 * This is what Android uses for CA cert filenames (<hash>.0).
 * Algorithm: MD5(subject DER) → first 4 bytes as little-endian uint32 → hex.
 */
export function computeSubjectHashOld(certPem: string): string {
  const cert = new crypto.X509Certificate(certPem);
  const der = cert.raw;

  // Parse ASN.1 to extract the subject Name from the TBSCertificate:
  // Certificate → SEQUENCE { TBSCertificate, ... }
  // TBSCertificate → SEQUENCE { version?, serial, sigAlg, issuer, validity, subject, ... }
  const certSeq = derReadTLV(der, 0);
  const tbsSeq = derReadTLV(der, certSeq.start);
  let pos = tbsSeq.start;

  // Skip version [0] EXPLICIT if present (context-specific, constructed, tag 0)
  if (der[pos] === 0xa0) {
    pos = derReadTLV(der, pos).end;
  }
  // Skip serialNumber INTEGER
  pos = derReadTLV(der, pos).end;
  // Skip signature AlgorithmIdentifier SEQUENCE
  pos = derReadTLV(der, pos).end;
  // Skip issuer Name SEQUENCE
  pos = derReadTLV(der, pos).end;
  // Skip validity SEQUENCE
  pos = derReadTLV(der, pos).end;
  // Subject Name SEQUENCE — this is what we need (full TLV)
  const subject = derReadTLV(der, pos);
  const subjectDer = der.subarray(pos, subject.end);

  const md5 = crypto.createHash('md5').update(subjectDer).digest();
  const hashVal = md5.readUInt32LE(0);
  return hashVal.toString(16).padStart(8, '0');
}

/**
 * Parse the output of `adb devices` into device ID + status pairs.
 */
export function parseAdbDevices(output: string): Array<{ id: string; status: string }> {
  const lines = output.split('\n');
  const results: Array<{ id: string; status: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip header and empty lines
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed === '* daemon not running') {
      continue;
    }
    // Lines look like: "SERIAL\tdevice" or "SERIAL\toffline" etc.
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      results.push({ id: parts[0], status: parts[1] });
    }
  }

  return results;
}

/**
 * Parse the output of `adb shell dumpsys battery` into a battery level.
 */
export function parseBatteryLevel(output: string): number | null {
  const match = output.match(/level:\s*(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

export class DeviceManager {
  private static instance: DeviceManager | null = null;

  private lastInteraction = new Map<string, number>();
  private busyDevices = new Map<string, number>(); // deviceId → timestamp when marked busy
  private onlineDevices = new Set<string>();
  private sleepingDevices = new Set<string>(); // devices we already put to sleep
  private batteryCache = new Map<string, { level: number; timestamp: number }>();
  private kernelWgSupport = new Map<string, boolean>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private standbyTimer: ReturnType<typeof setInterval> | null = null;

  private fridaReleaseManager: any = null;
  private _hasActiveViewers: ((deviceId: string) => boolean) | null = null;
  private stayAwakeDevices = new Set<string>(); // devices with stay_on_while_plugged_in enabled
  private offlineListeners: Array<(deviceId: string) => void> = [];
  private hookBus: HookBus | null = null;
  private providerRegistry: ProviderRegistry | null = null;
  // TODO(phase-2): read in capture-startup path. Setter is present so the
  // boot wiring (Task 1.6) can install it now; the read site lands when
  // Phase 2 implements the capture-mode dispatch.
  private captureModeRegistry: CaptureModeRegistry | null = null;

  constructor(private db: AppDatabase) {}

  setHookBus(bus: HookBus): void {
    this.hookBus = bus;
  }

  /**
   * Wire the provider registry. Once wired, `pollDevicesFromProviders()`
   * routes device discovery through registered DeviceProviders instead of
   * the legacy inline `adb devices` parsing. Existing `pollAdbDevices()`
   * remains as the no-registry fallback during the refactor.
   */
  setProviderRegistry(reg: ProviderRegistry): void {
    this.providerRegistry = reg;
  }

  /**
   * Wire the capture-mode registry for per-mode capture dispatch.
   * Phase 1 wires a no-op stub for `wireguard` mode; Phase 2 replaces it
   * with the real handler.
   */
  setCaptureModeRegistry(reg: CaptureModeRegistry): void {
    this.captureModeRegistry = reg;
  }

  /** Register a callback to check if a device has active stream viewers. */
  setViewerCheck(fn: (deviceId: string) => boolean): void {
    this._hasActiveViewers = fn;
  }

  /**
   * Register a listener invoked when a device transitions from online to
   * offline. Used by live-stream to release cached ports and ADB forwards —
   * without this, ports in the 9200–9399 range accumulate across reconnects.
   */
  onDeviceOffline(fn: (deviceId: string) => void): void {
    this.offlineListeners.push(fn);
  }

  private notifyOffline(deviceId: string): void {
    for (const fn of this.offlineListeners) {
      try { fn(deviceId); } catch (err: any) {
        error(`onDeviceOffline listener failed for ${deviceId}: ${err.message}`);
      }
    }
  }

  /**
   * Set the Android `stay_on_while_plugged_in` setting.
   * value=2 → stay awake on USB, value=0 → normal sleep behavior.
   */
  private async setStayAwake(deviceId: string, on: boolean): Promise<void> {
    const value = on ? 2 : 0;
    const current = this.stayAwakeDevices.has(deviceId);
    if (current === on) return; // already in desired state
    try {
      await adbShell(deviceId, `settings put global stay_on_while_plugged_in ${value}`);
      if (on) {
        this.stayAwakeDevices.add(deviceId);
      } else {
        this.stayAwakeDevices.delete(deviceId);
      }
      log(`Device ${deviceId}: stay_on_while_plugged_in=${value}`);
    } catch {
      // Device may have disconnected
    }
  }

  /** Returns true if a device should be kept awake (busy or has viewers). */
  private shouldStayAwake(deviceId: string): boolean {
    return this.busyDevices.has(deviceId) || (this._hasActiveViewers?.(deviceId) ?? false);
  }

  setFridaReleaseManager(manager: any): void {
    this.fridaReleaseManager = manager;
  }

  static getInstance(db?: AppDatabase): DeviceManager {
    if (!DeviceManager.instance) {
      if (!db) throw new Error('DeviceManager requires db on first init');
      DeviceManager.instance = new DeviceManager(db);
    }
    return DeviceManager.instance;
  }

  /** Reset singleton — for testing only. */
  static resetInstance(): void {
    DeviceManager.instance = null;
  }

  /**
   * Start the ADB polling loop and standby management.
   */
  start(): void {
    log('Starting device manager');
    this.pollAdbDevices();
    this.pollTimer = setInterval(() => this.pollAdbDevices(), ADB_POLL_INTERVAL);
    this.standbyTimer = setInterval(() => this.checkStandby(), 10000);
  }

  /**
   * Stop all polling loops.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.standbyTimer) {
      clearInterval(this.standbyTimer);
      this.standbyTimer = null;
    }
    log('Device manager stopped');
  }

  /**
   * Poll `adb devices` and upsert discovered devices into the database.
   */
  async pollAdbDevices(): Promise<void> {
    try {
      const output = await adbCommand(['devices']);
      const parsed = parseAdbDevices(output);

      const currentIds = new Set<string>();

      for (const { id, status } of parsed) {
        currentIds.add(id);

        if (status === 'device') {
          const wasOnline = this.onlineDevices.has(id);
          this.onlineDevices.add(id);
          // On first discovery (or server restart), reset stay_on_while_plugged_in
          // so devices don't stay awake indefinitely from a previous session
          if (!wasOnline) {
            this.setStayAwake(id, false).catch(() => {});
            this.hookBus?.emit('device:connected', { id, platform: 'android' });
          }
        } else {
          this.onlineDevices.delete(id);
          this.stayAwakeDevices.delete(id);
        }

        // Upsert device
        const existing = this.db
          .select()
          .from(devices)
          .where(eq(devices.id, id))
          .all();

        if (existing.length === 0) {
          log(`New device discovered: ${id}`);
          // Check if rooted
          const isRooted = await this.checkRooted(id);
          this.db.insert(devices).values({
            id,
            isRooted,
            lastSeen: new Date(),
          }).run();
          // Collect extended properties for new device
          if (status === 'device') {
            this.collectDeviceProperties(id).catch(() => {});
          }
        } else {
          // Re-check root status if currently marked as non-rooted
          // (covers devices rooted after first discovery, or Magisk prompt not approved on first check)
          const wasRooted = existing[0].isRooted ?? false;
          if (!wasRooted) {
            const isNowRooted = await this.checkRooted(id);
            if (isNowRooted) {
              log(`Device ${id} is now rooted`);
            }
            this.db.update(devices)
              .set({ lastSeen: new Date(), ...(isNowRooted ? { isRooted: true } : {}) })
              .where(eq(devices.id, id))
              .run();
          } else {
            this.db.update(devices)
              .set({ lastSeen: new Date() })
              .where(eq(devices.id, id))
              .run();
          }
          // Backfill properties if any are missing (one-time per device)
          if (status === 'device' && existing[0].manufacturer == null) {
            this.collectDeviceProperties(id).catch(() => {});
          }
        }
      }

      // Mark devices no longer seen as offline
      for (const onlineId of [...this.onlineDevices]) {
        if (!currentIds.has(onlineId)) {
          this.onlineDevices.delete(onlineId);
          this.kernelWgSupport.delete(onlineId);
          this.sleepingDevices.delete(onlineId);
          this.stayAwakeDevices.delete(onlineId);
          log(`Android device offline: ${onlineId}`);
          broadcastToAll({ type: 'device-status', deviceId: onlineId, status: 'offline' });
          this.hookBus?.emit('device:disconnected', { id: onlineId, platform: 'android' });
          this.notifyOffline(onlineId);
        }
      }
    } catch (err: any) {
      error(`ADB poll failed: ${err.message}`);
    }
  }

  /**
   * New provider-driven polling path. Asks the registry for all instances
   * across all registered providers and upserts them into the devices
   * table. Falls through (returns early) if no registry is wired —
   * backwards-compat for the refactor period.
   *
   * Phase 1 only: inserts new serials / updates lastSeen for existing ones.
   * Root checks and property collection are ADB-specific and remain in
   * `pollAdbDevices`; they will be wired in Phase 2 once the provider
   * contract surfaces those capabilities.
   */
  async pollDevicesFromProviders(): Promise<void> {
    if (!this.providerRegistry) {
      return;
    }
    const all = await this.providerRegistry.listInstancesAll();
    for (const row of all) {
      if (!row.instance.serial) continue;
      const id = row.instance.serial;

      const existing = this.db
        .select()
        .from(devices)
        .where(eq(devices.id, id))
        .all();

      if (existing.length === 0) {
        log(`New device discovered via provider ${row.providerId}: ${id}`);
        this.db.insert(devices).values({
          id,
          lastSeen: new Date(),
        }).run();
      } else {
        this.db.update(devices)
          .set({ lastSeen: new Date() })
          .where(eq(devices.id, id))
          .run();
      }
    }
  }

  /**
   * Check if a device is rooted by running `su -c whoami`.
   */
  async checkRooted(deviceId: string): Promise<boolean> {
    // Strategy 1: check if su binary exists (works without triggering Magisk grant prompt)
    try {
      const whichSu = await adbShell(deviceId, 'which su', 5000);
      if (whichSu && !whichSu.includes('not found')) {
        return true;
      }
    } catch {
      // which may not exist on some devices, fall through
    }

    // Strategy 2: check common su paths directly
    try {
      const lsSu = await adbShell(deviceId, 'ls /sbin/su /system/xbin/su /system/bin/su 2>/dev/null', 5000);
      if (lsSu && lsSu.includes('/su')) {
        return true;
      }
    } catch {
      // fall through
    }

    // Strategy 3: try su -c whoami (may trigger Magisk prompt, short timeout)
    try {
      const result = await adbShell(deviceId, 'su -c whoami', 5000);
      return result.toLowerCase().includes('root');
    } catch {
      return false;
    }
  }

  /**
   * Collect extended device properties via ADB getprop and store them in the DB.
   */
  async collectDeviceProperties(deviceId: string): Promise<void> {
    try {
      const output = await adbShell(
        deviceId,
        '"getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi; getprop ro.serialno; getprop ro.boot.flash.locked; getprop ro.boot.verifiedbootstate"',
        10000,
      );
      const lines = output.split('\n').map(l => l.trim());

      const manufacturer = lines[0] || null;
      const model = lines[1] || null;
      const androidVersion = lines[2] || null;
      const apiLevel = lines[3] ? parseInt(lines[3], 10) : null;
      const cpuAbi = lines[4] || null;
      const serialNumber = lines[5] || null;
      const flashLocked = lines[6] || '';
      const verifiedBootState = lines[7] || '';

      let bootloaderLocked: boolean | null = null;
      if (flashLocked === '1') {
        bootloaderLocked = true;
      } else if (flashLocked === '0') {
        bootloaderLocked = false;
      } else if (verifiedBootState === 'green') {
        bootloaderLocked = true;
      } else if (verifiedBootState === 'orange' || verifiedBootState === 'red') {
        bootloaderLocked = false;
      }

      this.db.update(devices)
        .set({
          manufacturer,
          model,
          androidVersion,
          apiLevel: apiLevel !== null && !isNaN(apiLevel) ? apiLevel : null,
          cpuAbi,
          serialNumber,
          bootloaderLocked,
        })
        .where(eq(devices.id, deviceId))
        .run();

      log(`Collected properties for ${deviceId}: ${manufacturer} ${model} Android ${androidVersion}`);
    } catch (err: any) {
      error(`Failed to collect properties for ${deviceId}: ${err.message}`);
    }
  }

  /**
   * Get the battery level for a device (with short cache).
   */
  async getBatteryLevel(deviceId: string): Promise<number | null> {
    const cached = this.batteryCache.get(deviceId);
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.level;
    }

    try {
      const output = await adbShell(deviceId, 'dumpsys battery');
      const level = parseBatteryLevel(output);
      if (level !== null) {
        this.batteryCache.set(deviceId, { level, timestamp: Date.now() });
      }
      return level;
    } catch {
      return null;
    }
  }

  /**
   * Check whether a device needs setup (setupVersion < CURRENT_SETUP_VERSION).
   */
  needsSetup(deviceId: string): boolean {
    const device = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .all()[0];

    if (!device) return false;
    return (device.setupVersion ?? 0) < CURRENT_SETUP_VERSION;
  }

  /**
   * Perform device setup, then update setupVersion in the database.
   */
  async performSetup(deviceId: string): Promise<void> {
    log(`Performing setup for device ${deviceId} (version ${CURRENT_SETUP_VERSION})`);

    const device = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .all()[0];

    const currentVersion = device?.setupVersion ?? 0;

    // Setup steps for version 1:
    if (currentVersion < 1) {
      // - Enable stay awake while charging
      await adbShell(deviceId, 'settings put global stay_on_while_plugged_in 3');
      // - Disable screen lock
      await adbShell(deviceId, 'settings put secure lockscreen.disabled 1');
    }

    // Setup steps for version 2 (WireGuard + CA cert):
    if (currentVersion < 2) {
      const isRooted = device?.isRooted ?? false;
      if (isRooted) {
        // Check and cache kernel WireGuard support
        const hasKernelWg = await this.hasKernelWireGuard(deviceId);

        // Ensure wg tool is available
        try {
          await this.ensureWgTool(deviceId);
        } catch (err: any) {
          log(`Device ${deviceId}: wg tool setup skipped: ${err.message}`);
        }

        // If kernel WireGuard not available, pre-push wireguard-go and wg-uapi
        if (!hasKernelWg) {
          try {
            await this.ensureWgGoTool(deviceId);
            await this.ensureWgUapiTool(deviceId);
          } catch (err: any) {
            log(`Device ${deviceId}: wireguard-go/wg-uapi push skipped: ${err.message}`);
          }
        }

        // Inject mitmproxy CA certificate
        try {
          await this.injectMitmproxyCaCert(deviceId);
        } catch (err: any) {
          log(`Device ${deviceId}: CA cert injection skipped: ${err.message}`);
        }
      } else {
        log(`Device ${deviceId}: skipping WireGuard setup (not rooted)`);
      }
    }

    // Setup steps for version 3 (Frida server push):
    if (currentVersion < 3) {
      const isRooted = device?.isRooted ?? false;
      if (isRooted && this.fridaReleaseManager) {
        try {
          const version = this.fridaReleaseManager.resolveVersion(
            this.fridaReleaseManager.getDefaultVersion(),
          );
          if (version) {
            let binPath = this.fridaReleaseManager.getBinaryPath(version);
            if (!this.fridaReleaseManager.isDownloaded(version)) {
              binPath = await this.fridaReleaseManager.downloadVersion(version);
            }
            await adbCommand(['-s', deviceId, 'push', binPath, '/data/local/tmp/frida-server']);
            await adbShell(deviceId, '"su -c \'chmod 755 /data/local/tmp/frida-server\'"');
            this.db.update(devices)
              .set({ fridaVersion: version })
              .where(eq(devices.id, deviceId))
              .run();
            log(`Device ${deviceId}: Frida server ${version} pushed`);
          } else {
            log(`Device ${deviceId}: No Frida version available, skipping push`);
          }
        } catch (err: any) {
          log(`Device ${deviceId}: Frida push failed: ${err.message}`);
        }
      }
    }

    // Setup steps for version 4 (pre-push stream binaries):
    // Push minicap, minitouch, and scrcpy binaries during setup so the first
    // stream start skips pushIfNeeded entirely (~200ms saved on cold start).
    if (currentVersion < 4) {
      try {
        const arch = (await adbShell(deviceId, 'getprop ro.product.cpu.abi')).trim();
        const apiLevel = parseInt((await adbShell(deviceId, 'getprop ro.build.version.sdk')).trim(), 10);

        // Push minitouch
        try {
          const minitouchBin = await ensureMinitouch(arch);
          await adbCommand(['-s', deviceId, 'push', minitouchBin, '/data/local/tmp/minitouch']);
          await adbShell(deviceId, 'chmod 755 /data/local/tmp/minitouch');
          log(`Device ${deviceId}: minitouch binary pushed`);
        } catch (err: any) {
          log(`Device ${deviceId}: minitouch push skipped: ${err.message}`);
        }

        // Push minicap (only for API < 33)
        if (apiLevel < 33) {
          try {
            const minicapPaths = await ensureMinicap(arch, apiLevel);
            await Promise.all([
              adbCommand(['-s', deviceId, 'push', minicapPaths.binary, '/data/local/tmp/minicap']),
              adbCommand(['-s', deviceId, 'push', minicapPaths.sharedLib, '/data/local/tmp/minicap.so']),
            ]);
            await adbShell(deviceId, 'chmod 755 /data/local/tmp/minicap');
            log(`Device ${deviceId}: minicap binary + so pushed`);
          } catch (err: any) {
            log(`Device ${deviceId}: minicap push skipped: ${err.message}`);
          }
        }

        // Push scrcpy-server jar
        try {
          const scrcpyJar = getScrcpyServerJar();
          await adbCommand(['-s', deviceId, 'push', scrcpyJar, '/data/local/tmp/scrcpy-server.jar']);
          log(`Device ${deviceId}: scrcpy-server jar pushed`);
        } catch (err: any) {
          log(`Device ${deviceId}: scrcpy push skipped: ${err.message}`);
        }
      } catch (err: any) {
        log(`Device ${deviceId}: stream binary push failed: ${err.message}`);
      }
    }

    this.db.update(devices)
      .set({ setupVersion: CURRENT_SETUP_VERSION })
      .where(eq(devices.id, deviceId))
      .run();

    log(`Setup complete for device ${deviceId}`);
  }

  /**
   * Record an interaction with a device (resets standby timer).
   */
  recordInteraction(deviceId: string): void {
    const now = Date.now();
    this.lastInteraction.set(deviceId, now);
    this.sleepingDevices.delete(deviceId);
    // Refresh busy timestamp so active sessions don't get force-idled
    if (this.busyDevices.has(deviceId)) {
      this.busyDevices.set(deviceId, now);
    }
  }

  /**
   * Wake a device screen.
   */
  async wakeDevice(deviceId: string): Promise<void> {
    this.recordInteraction(deviceId); // also clears sleepingDevices
    await adbShell(deviceId, 'input keyevent KEYCODE_WAKEUP');
    log(`Woke device ${deviceId}`);
  }

  /**
   * Check standby timeout for all devices and put idle ones to sleep.
   * Uses KEYCODE_SLEEP (223) which only turns the screen off — unlike
   * KEYCODE_POWER (26) which toggles and can wake the device back up.
   * Only sends the keyevent if the screen is currently on.
   */
  async checkStandby(): Promise<void> {
    const now = Date.now();

    // Safety net: release devices stuck in busy state with no interaction
    for (const [deviceId, lastBusyActivity] of this.busyDevices) {
      const idleTime = now - lastBusyActivity;
      if (idleTime > MAX_BUSY_IDLE) {
        error(`Device ${deviceId} busy with no interaction for ${Math.round(idleTime / 1000)}s, forcing idle`);
        this.busyDevices.delete(deviceId);
      } else if (idleTime > MAX_BUSY_IDLE - BUSY_IDLE_WARNING) {
        const remainingSec = Math.round((MAX_BUSY_IDLE - idleTime) / 1000);
        broadcastToAll({
          type: 'busy-timeout-warning',
          deviceId,
          remainingSeconds: remainingSec,
        });
      }
    }

    for (const deviceId of this.onlineDevices) {
      const awake = this.shouldStayAwake(deviceId);

      // Sync stay_on_while_plugged_in with current state
      this.setStayAwake(deviceId, awake).catch(() => {});

      if (awake) continue;
      if (this.sleepingDevices.has(deviceId)) continue;

      const lastTime = this.lastInteraction.get(deviceId) ?? 0;
      if (now - lastTime > STANDBY_TIMEOUT) {
        try {
          // Check if screen is already off before sending sleep
          const displayState = await adbShell(deviceId, 'dumpsys power | grep "Display Power"');
          if (displayState.includes('state=OFF')) {
            this.sleepingDevices.add(deviceId);
            continue;
          }

          await adbShell(deviceId, 'input keyevent KEYCODE_SLEEP');
          this.sleepingDevices.add(deviceId);
          log(`Put device ${deviceId} to sleep (idle timeout)`);
        } catch {
          // Device may have disconnected
        }
      }
    }
  }

  /**
   * Atomically check if a device is free and mark it busy.
   * Returns true if the device was free and is now marked busy.
   * Returns false if the device was already busy (caller must NOT proceed).
   */
  tryAcquireBusy(deviceId: string): boolean {
    if (this.busyDevices.has(deviceId)) {
      return false;
    }
    this.busyDevices.set(deviceId, Date.now());
    this.recordInteraction(deviceId);
    this.setStayAwake(deviceId, true).catch(() => {});
    return true;
  }

  /**
   * Mark a device as busy (automation running or user interacting).
   * Prefer tryAcquireBusy() for automation/capture — this unconditionally overwrites.
   */
  markBusy(deviceId: string): void {
    this.busyDevices.set(deviceId, Date.now());
    this.recordInteraction(deviceId);
    this.setStayAwake(deviceId, true).catch(() => {});
  }

  /**
   * Mark a device as no longer busy.
   */
  markIdle(deviceId: string): void {
    this.busyDevices.delete(deviceId);
  }

  /**
   * Refresh the busy timestamp to prevent MAX_BUSY_IDLE from force-idling
   * a device that is actively being used by a long-running automation.
   */
  refreshBusy(deviceId: string): void {
    if (this.busyDevices.has(deviceId)) {
      this.busyDevices.set(deviceId, Date.now());
      this.lastInteraction.set(deviceId, Date.now());
    }
  }

  /**
   * Check if a device is currently busy.
   */
  isBusy(deviceId: string): boolean {
    return this.busyDevices.has(deviceId);
  }

  /**
   * Check if a device is currently online.
   */
  isOnline(deviceId: string): boolean {
    return this.onlineDevices.has(deviceId);
  }

  /**
   * Get all devices with their live status information.
   */
  async getAllDeviceStatuses(): Promise<DeviceStatus[]> {
    const allDevices = this.db.select().from(devices).all();

    // Fetch battery levels in parallel for online devices
    const onlineIds = allDevices
      .filter(d => this.onlineDevices.has(d.id))
      .map(d => d.id);
    const batteryResults = await Promise.all(
      onlineIds.map(id => this.getBatteryLevel(id).catch(() => null)),
    );
    const batteryMap = new Map<string, number | null>();
    onlineIds.forEach((id, i) => batteryMap.set(id, batteryResults[i]));

    return allDevices.map(device => {
      const isOnline = this.onlineDevices.has(device.id);
      return {
        id: device.id,
        name: device.name,
        platform: (device.platform as 'android' | 'ios') ?? 'android',
        isRooted: device.isRooted ?? false,
        setupVersion: device.setupVersion ?? 0,
        bridgePort: device.bridgePort,
        lastSeen: device.lastSeen,
        batteryLevel: batteryMap.get(device.id) ?? null,
        needsSetup: (device.setupVersion ?? 0) < CURRENT_SETUP_VERSION,
        isBusy: this.busyDevices.has(device.id),
        isOnline,
        manufacturer: device.manufacturer ?? null,
        model: device.model ?? null,
        androidVersion: device.androidVersion ?? null,
        iosVersion: device.iosVersion ?? null,
        apiLevel: device.apiLevel ?? null,
        cpuAbi: device.cpuAbi ?? null,
        serialNumber: device.serialNumber ?? null,
        bootloaderLocked: device.bootloaderLocked ?? null,
      };
    });
  }

  /**
   * Get a single device status.
   */
  async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
    const device = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .all()[0];

    if (!device) return null;

    const isOnline = this.onlineDevices.has(device.id);
    let batteryLevel: number | null = null;

    if (isOnline) {
      batteryLevel = await this.getBatteryLevel(device.id);
    }

    return {
      id: device.id,
      name: device.name,
      platform: (device.platform as 'android' | 'ios') ?? 'android',
      isRooted: device.isRooted ?? false,
      setupVersion: device.setupVersion ?? 0,
      bridgePort: device.bridgePort,
      lastSeen: device.lastSeen,
      batteryLevel,
      needsSetup: (device.setupVersion ?? 0) < CURRENT_SETUP_VERSION,
      isBusy: this.busyDevices.has(device.id),
      isOnline,
      manufacturer: device.manufacturer ?? null,
      model: device.model ?? null,
      androidVersion: device.androidVersion ?? null,
      iosVersion: device.iosVersion ?? null,
      apiLevel: device.apiLevel ?? null,
      cpuAbi: device.cpuAbi ?? null,
      serialNumber: device.serialNumber ?? null,
      bootloaderLocked: device.bootloaderLocked ?? null,
    };
  }

  /**
   * Get available devices that meet optional filter requirements.
   */
  async getAvailableDevices(filter?: DeviceFilter): Promise<DeviceStatus[]> {
    const allStatuses = await this.getAllDeviceStatuses();
    // Ensure filter is migrated from old format if needed
    const migrated = filter ? migrateDeviceFilter(filter) : undefined;
    // If no explicit batteryLevel rule, apply default minimum
    const hasBatteryRule = migrated?.rules.some(r => r.field === 'batteryLevel');

    return allStatuses.filter((d) => {
      if (!d.isOnline) return false;
      if (d.isBusy) return false;
      if (!hasBatteryRule && d.batteryLevel !== null && d.batteryLevel < MIN_BATTERY_LEVEL) return false;
      if (migrated && !matchesDeviceFilter(d as any, migrated)) return false;
      return true;
    });
  }

  /**
   * Take a screenshot via ADB and return the image data as a Buffer.
   */
  async takeScreenshot(deviceId: string): Promise<Buffer> {
    const remotePath = '/sdcard/darkride_screenshot.png';
    await adbShell(deviceId, `screencap -p ${remotePath}`);
    const { stdout } = await execFileAsync(
      'adb',
      ['-s', deviceId, 'exec-out', 'cat', remotePath],
      { encoding: 'buffer' as any, maxBuffer: 50 * 1024 * 1024, timeout: 15000 },
    );
    // Clean up remote file
    adbShell(deviceId, `rm -f ${remotePath}`).catch(() => {});
    return stdout as unknown as Buffer;
  }

  /**
   * Execute an arbitrary ADB shell command on a device.
   */
  async executeShellCommand(deviceId: string, command: string, timeout?: number): Promise<string> {
    return adbShell(deviceId, command, timeout);
  }

  /**
   * Run a device command (restart, sleep, wake).
   */
  async runDeviceCommand(deviceId: string, command: 'restart' | 'sleep' | 'wake' | 'unlock' | 'stopall'): Promise<void> {
    switch (command) {
      case 'restart':
        await adbShell(deviceId, 'reboot');
        log(`Restarted device ${deviceId}`);
        break;
      case 'sleep':
        await adbShell(deviceId, 'input keyevent KEYCODE_SLEEP');
        this.sleepingDevices.add(deviceId);
        log(`Put device ${deviceId} to sleep`);
        break;
      case 'wake':
        await this.wakeDevice(deviceId);
        break;
      case 'unlock':
        await this.unlockDevice(deviceId);
        break;
      case 'stopall':
        await this.stopAllApps(deviceId);
        break;
    }
  }

  /**
   * Unlock the device — wake screen and dismiss lock screen.
   * Uses multiple strategies and verifies the result.
   */
  async unlockDevice(deviceId: string): Promise<void> {
    this.recordInteraction(deviceId);

    const isKeyguardShowing = async (): Promise<boolean> => {
      const windowState = await adbShell(deviceId, 'dumpsys window');
      return windowState.includes('mDreamingLockscreen=true')
        || windowState.includes('mShowingLockscreen=true')
        || windowState.includes('mKeyguardShowing=true')
        || windowState.includes('isKeyguardShowing=true')
        || windowState.includes('statusBarKeyguardShowing=true');
    };

    const powerState = await adbShell(deviceId, 'dumpsys power');
    const screenOn = powerState.includes('Display Power: state=ON');

    if (screenOn && !(await isKeyguardShowing())) {
      log(`Device ${deviceId} already unlocked, skipping`);
      return;
    }

    if (!screenOn) {
      await adbShell(deviceId, 'input keyevent KEYCODE_WAKEUP');
      await new Promise(r => setTimeout(r, 500));
    }

    // Re-check keyguard after waking — try multiple dismiss strategies
    if (!(await isKeyguardShowing())) {
      log(`Device ${deviceId} screen woken, no lock screen to dismiss`);
      return;
    }

    // Strategy 1: wm dismiss-keyguard (Android 8+, most reliable)
    try {
      await adbShell(deviceId, 'wm dismiss-keyguard');
      await new Promise(r => setTimeout(r, 500));
      if (!(await isKeyguardShowing())) {
        log(`Unlocked device ${deviceId} via wm dismiss-keyguard`);
        return;
      }
    } catch { /* not available on older devices */ }

    // Strategy 2: KEYCODE_MENU (82) — standard keyguard dismiss
    await adbShell(deviceId, 'input keyevent 82');
    await new Promise(r => setTimeout(r, 500));
    if (!(await isKeyguardShowing())) {
      log(`Unlocked device ${deviceId} via KEYCODE_MENU`);
      return;
    }

    // Strategy 3: swipe up (for swipe-to-unlock screens)
    const wmOutput = await adbShell(deviceId, 'wm size');
    const match = wmOutput.match(/(\d+)x(\d+)/);
    const w = match ? parseInt(match[1], 10) : 1080;
    const h = match ? parseInt(match[2], 10) : 1920;
    await adbShell(deviceId, `input swipe ${Math.round(w / 2)} ${Math.round(h * 0.8)} ${Math.round(w / 2)} ${Math.round(h * 0.2)} 300`);
    await new Promise(r => setTimeout(r, 500));

    // Retry swipe once if still locked (may have hit notification shade first time)
    if (await isKeyguardShowing()) {
      await adbShell(deviceId, `input swipe ${Math.round(w / 2)} ${Math.round(h * 0.8)} ${Math.round(w / 2)} ${Math.round(h * 0.2)} 300`);
      await new Promise(r => setTimeout(r, 500));
    }

    log(`Unlocked device ${deviceId} via swipe`);
  }

  /**
   * Force-stop all third-party (non-system) apps on the device.
   */
  async stopAllApps(deviceId: string): Promise<void> {
    this.recordInteraction(deviceId);
    const output = await adbShell(deviceId, 'pm list packages -3');
    const packages = output
      .split('\n')
      .map(line => line.replace('package:', '').trim())
      .filter(pkg => pkg.length > 0);

    for (const pkg of packages) {
      try {
        await adbShell(deviceId, `am force-stop ${pkg}`);
      } catch {
        // some packages may refuse to stop, continue
      }
    }
    log(`Stopped ${packages.length} third-party apps on device ${deviceId}`);
  }

  private static readonly WG_DEVICE_PATH = '/data/local/tmp/wg';
  private static readonly WG_GO_DEVICE_PATH = '/data/local/tmp/wireguard-go';
  private static readonly WG_UAPI_DEVICE_PATH = '/data/local/tmp/wg-uapi';

  /**
   * Find the `wg` tool path on the device.
   * Checks system PATH first, then our pushed binary at /data/local/tmp/wg.
   */
  async findWgTool(deviceId: string): Promise<string | null> {
    // 1. Check system PATH
    try {
      const result = await adbShell(deviceId, `"su -c 'which wg'"`);
      if (result && !result.includes('not found')) {
        return result.trim();
      }
    } catch {
      // not in PATH
    }

    // 2. Check our pushed binary
    try {
      const result = await adbShell(deviceId, `"su -c 'test -x ${DeviceManager.WG_DEVICE_PATH} && echo ok'"`);
      if (result && result.includes('ok')) {
        return DeviceManager.WG_DEVICE_PATH;
      }
    } catch {
      // not there
    }

    return null;
  }

  /**
   * Push the pre-extracted `wg` binary to the device.
   * Binaries are at data/apks/wg-binaries/<abi>.so, pre-extracted from the WireGuard APK.
   */
  async pushWgBinary(deviceId: string): Promise<void> {
    // Detect device architecture
    const abi = await adbShell(deviceId, 'getprop ro.product.cpu.abi');
    const arch = abi.trim(); // e.g. "arm64-v8a", "armeabi-v7a", "x86_64", "x86"
    // arch e.g. "arm64-v8a", "armeabi-v7a", "x86_64"

    const binaryPath = path.resolve(`data/apks/wg-binaries/${arch}.so`);
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `WireGuard wg binary not found for arch ${arch}. Expected at ${binaryPath}`,
      );
    }

    // Push to device and make executable
    await adbCommand(['-s', deviceId, 'push', binaryPath, DeviceManager.WG_DEVICE_PATH]);
    await adbShell(deviceId, `"su -c 'chmod 755 ${DeviceManager.WG_DEVICE_PATH}'"`);
    log(`Pushed wg binary to ${deviceId} (${arch})`);
  }

  /**
   * Ensure the `wg` tool is available on the device.
   * Extracts from our bundled APK and pushes via ADB if needed.
   */
  async ensureWgTool(deviceId: string): Promise<string> {
    let wgPath = await this.findWgTool(deviceId);
    if (wgPath) return wgPath;

    await this.pushWgBinary(deviceId);
    wgPath = await this.findWgTool(deviceId);
    if (wgPath) return wgPath;

    throw new Error(`wg tool not found on device ${deviceId} even after pushing binary`);
  }

  /**
   * Check whether the device kernel supports WireGuard natively.
   * Result is cached per device (cleared on disconnect).
   */
  async hasKernelWireGuard(deviceId: string): Promise<boolean> {
    const cached = this.kernelWgSupport.get(deviceId);
    if (cached !== undefined) return cached;

    try {
      await adbShell(
        deviceId,
        `"su -c 'ip link add wg_test type wireguard && ip link del wg_test'"`,
      );
      log(`Device ${deviceId}: kernel WireGuard support confirmed`);
      this.kernelWgSupport.set(deviceId, true);
      return true;
    } catch {
      log(`Device ${deviceId}: kernel WireGuard not available, will use wireguard-go`);
      this.kernelWgSupport.set(deviceId, false);
      return false;
    }
  }

  /**
   * Find the `wireguard-go` tool on the device.
   */
  async findWgGoTool(deviceId: string): Promise<string | null> {
    try {
      const result = await adbShell(
        deviceId,
        `"su -c 'test -x ${DeviceManager.WG_GO_DEVICE_PATH} && echo ok'"`,
      );
      if (result && result.includes('ok')) {
        return DeviceManager.WG_GO_DEVICE_PATH;
      }
    } catch {
      // not there
    }
    return null;
  }

  /**
   * Push the wireguard-go binary to the device.
   * Binaries are at data/apks/wg-binaries/wireguard-go-<abi>.
   */
  async pushWgGoBinary(deviceId: string): Promise<void> {
    const abi = (await adbShell(deviceId, 'getprop ro.product.cpu.abi')).trim();

    const binaryPath = path.resolve(`data/apks/wg-binaries/wireguard-go-${abi}`);
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `wireguard-go binary not found for arch ${abi}. Expected at ${binaryPath}. ` +
        `Build with: bash scripts/build-wireguard-go.sh`,
      );
    }

    await adbCommand(['-s', deviceId, 'push', binaryPath, DeviceManager.WG_GO_DEVICE_PATH]);
    await adbShell(deviceId, `"su -c 'chmod 755 ${DeviceManager.WG_GO_DEVICE_PATH}'"`);
    log(`Pushed wireguard-go binary to ${deviceId} (${abi})`);
  }

  /**
   * Ensure the `wireguard-go` tool is available on the device.
   */
  async ensureWgGoTool(deviceId: string): Promise<string> {
    let wgGoPath = await this.findWgGoTool(deviceId);
    if (wgGoPath) return wgGoPath;

    await this.pushWgGoBinary(deviceId);
    wgGoPath = await this.findWgGoTool(deviceId);
    if (wgGoPath) return wgGoPath;

    throw new Error(
      `wireguard-go not found on device ${deviceId} even after pushing binary. ` +
      `Build with: bash scripts/build-wireguard-go.sh`,
    );
  }

  /**
   * Find the `wg-uapi` tool on the device.
   */
  async findWgUapiTool(deviceId: string): Promise<string | null> {
    try {
      const result = await adbShell(
        deviceId,
        `"su -c 'test -x ${DeviceManager.WG_UAPI_DEVICE_PATH} && echo ok'"`,
      );
      if (result && result.includes('ok')) {
        return DeviceManager.WG_UAPI_DEVICE_PATH;
      }
    } catch {
      // not there
    }
    return null;
  }

  /**
   * Push the wg-uapi binary to the device.
   */
  async pushWgUapiBinary(deviceId: string): Promise<void> {
    const abi = (await adbShell(deviceId, 'getprop ro.product.cpu.abi')).trim();

    const binaryPath = path.resolve(`data/apks/wg-binaries/wg-uapi-${abi}`);
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `wg-uapi binary not found for arch ${abi}. Expected at ${binaryPath}. ` +
        `Build with: bash scripts/build-wireguard-go.sh`,
      );
    }

    await adbCommand(['-s', deviceId, 'push', binaryPath, DeviceManager.WG_UAPI_DEVICE_PATH]);
    await adbShell(deviceId, `"su -c 'chmod 755 ${DeviceManager.WG_UAPI_DEVICE_PATH}'"`);
    log(`Pushed wg-uapi binary to ${deviceId} (${abi})`);
  }

  /**
   * Ensure the `wg-uapi` tool is available on the device.
   */
  async ensureWgUapiTool(deviceId: string): Promise<string> {
    let wgUapiPath = await this.findWgUapiTool(deviceId);
    if (wgUapiPath) return wgUapiPath;

    await this.pushWgUapiBinary(deviceId);
    wgUapiPath = await this.findWgUapiTool(deviceId);
    if (wgUapiPath) return wgUapiPath;

    throw new Error(
      `wg-uapi not found on device ${deviceId} even after pushing binary. ` +
      `Build with: bash scripts/build-wireguard-go.sh`,
    );
  }

  /**
   * Activate a WireGuard tunnel on the device to route traffic through mitmproxy.
   */
  async activateWireGuardTunnel(
    deviceId: string,
    tunnelInfo: WireGuardTunnelInfo,
  ): Promise<void> {
    const useKernel = await this.hasKernelWireGuard(deviceId);
    const mode = useKernel ? 'kernel' : 'wireguard-go userspace';
    log(`Activating WireGuard tunnel on ${deviceId} (${mode})`);

    // Get wg tool path (kernel mode uses the APK's wg binary)
    const wgPath = await this.ensureWgTool(deviceId);

    // If kernel WireGuard not available, ensure wireguard-go and wg-uapi are on device.
    // wg-uapi is needed because the APK's wg binary only supports kernel netlink —
    // it cannot communicate with wireguard-go's UAPI socket.
    let wgGoPath: string | undefined;
    let wgUapiPath: string | undefined;
    if (!useKernel) {
      wgGoPath = await this.ensureWgGoTool(deviceId);
      wgUapiPath = await this.ensureWgUapiTool(deviceId);
    }

    // Write wg setconf config to a local temp file and push it to the device.
    // This avoids echo/escape issues across Windows → adb → su shell layers.
    const peerConf = [
      '[Interface]',
      `PrivateKey = ${tunnelInfo.clientPrivateKey}`,
      '',
      '[Peer]',
      `PublicKey = ${tunnelInfo.serverPublicKey}`,
      `Endpoint = ${tunnelInfo.serverEndpoint}`,
      'AllowedIPs = 0.0.0.0/0',
      'PersistentKeepalive = 25',
    ].join('\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-conf-'));
    const tmpConf = path.join(tmpDir, 'wg_peer.conf');
    try {
      fs.writeFileSync(tmpConf, peerConf, 'utf-8');
      await adbCommand(['-s', deviceId, 'push', tmpConf, '/data/local/tmp/wg_peer.conf']);
    } finally {
      try { fs.unlinkSync(tmpConf); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }

    // Android uses per-interface routing tables checked via `ip rule` BEFORE
    // the main table. Routes in main are never consulted. We must use a custom
    // routing table (51820) with a high-priority rule to override this.
    // fwmark 51820 on the wg socket prevents routing loops for WG's own UDP packets.
    //
    // IMPORTANT: Android replaces the default Linux routing rules (32766/32767
    // for main/default table lookups) with `32000: from all unreachable`.
    // WireGuard's encrypted UDP packets carry fwmark 0xca6c (51820), which
    // doesn't match any Android per-network routing rule → hits unreachable.
    // We add an explicit rule at priority 90 to route fwmark 0xca6c packets
    // through the main table (which has the LAN route to the WG server).
    const WG_TABLE = '51820';
    const WG_FWMARK = '51820';

    // wireguard-go creates the TUN interface and forks to background.
    // After forking, the interface exists and all standard wg/ip commands work.
    // On Android, wireguard-go needs:
    //   1. /tmp/run/wireguard/ for the UAPI socket (rootfs is read-only on
    //      modern Android, so we use /tmp which is tmpfs)
    //   2. SELinux permissive (shell_data_file context blocks TUN/socket creation)
    const createInterfaceCmd = useKernel
      ? 'ip link add dev wg0 type wireguard'
      : `setenforce 0 && mkdir -p /tmp/run/wireguard && ${wgGoPath} wg0`;

    // In userspace mode, use wg-uapi to configure via the UAPI socket.
    // The APK's wg binary only supports kernel netlink and cannot talk to wireguard-go.
    const setconfCmd = useKernel
      ? `${wgPath} setconf wg0 /data/local/tmp/wg_peer.conf`
      : `${wgUapiPath} setconf wg0 /data/local/tmp/wg_peer.conf`;
    const fwmarkCmd = useKernel
      ? `${wgPath} set wg0 fwmark ${WG_FWMARK}`
      : `${wgUapiPath} set wg0 fwmark ${WG_FWMARK}`;

    const commands = [
      // Teardown any existing tunnel and restore IPv6 (may have been disabled by earlier run)
      `killall wireguard-go 2>/dev/null; ip link del wg0 2>/dev/null; ip rule del table ${WG_TABLE} 2>/dev/null; ip rule del fwmark 0xca6c lookup main 2>/dev/null; sysctl -w net.ipv6.conf.all.disable_ipv6=0 2>/dev/null; true`,
      // Create interface (kernel module or wireguard-go userspace)
      createInterfaceCmd,
      setconfCmd,
      `ip addr add ${tunnelInfo.clientAddress} dev wg0`,
      'ip link set mtu 1280 up dev wg0',
      // Set fwmark so WG's own encrypted UDP packets bypass our routing rule
      fwmarkCmd,
      // Route all traffic through wg0 via custom table
      `ip route add default dev wg0 table ${WG_TABLE}`,
      // Route WG's own encrypted packets (fwmark 0xca6c) through the main table
      // so they reach the WG server via wlan0. Without this, Android's
      // `32000: from all unreachable` rule drops them.
      `ip rule add fwmark ${WG_FWMARK} lookup main priority 90`,
      // High-priority rule (priority 100, checked before wlan0 at ~22000):
      // all traffic EXCEPT WG's own packets uses our table
      `ip rule add not fwmark ${WG_FWMARK} table ${WG_TABLE} priority 100`,
      'rm -f /data/local/tmp/wg_peer.conf',
    ];

    await adbShell(deviceId, `"su -c '${commands.join(' && ')}'"`);

    log(`WireGuard tunnel activated on ${deviceId} (${mode})`);
  }

  /**
   * Test tunnel connectivity by making an HTTPS request from the device.
   * Tries curl, then wget. Returns the HTTP status or response body snippet.
   * Returns null if no HTTP client is available on the device.
   */
  async testTunnelConnectivity(
    deviceId: string,
    testUrl: string = 'https://detectportal.firefox.com/success.txt',
  ): Promise<{ success: boolean; details: string }> {
    // Try curl first (fast and reliable when available)
    try {
      const result = await adbShell(
        deviceId,
        `"su -c 'curl -sf --max-time 10 ${testUrl}'"`,
      );
      if (result && result.trim().length > 0) {
        return { success: true, details: result.substring(0, 200) };
      }
    } catch {
      // curl not available or request failed
    }

    // Fallback: check WireGuard handshake recency and transfer counters.
    // This is more reliable than nc/wget since mitmproxy's transparent proxy
    // makes raw TCP tests unreliable, and many Android devices lack curl/wget.
    try {
      const wgPath = await this.findWgTool(deviceId);
      if (wgPath) {
        const result = await adbShell(
          deviceId,
          `"su -c '${wgPath} show wg0 latest-handshakes'"`,
        );
        if (result) {
          const ts = parseInt(result.trim().split('\t')[1], 10);
          if (ts > 0) {
            const age = Math.floor(Date.now() / 1000) - ts;
            if (age < 180) {
              return { success: true, details: `WireGuard handshake ${age}s ago` };
            }
          }
        }
      }
    } catch {
      // wg tool not available
    }

    return { success: false, details: 'connectivity test failed (no curl, no recent WireGuard handshake)' };
  }

  /**
   * Deactivate the WireGuard tunnel on the device.
   * Swallows errors since the interface may not exist.
   */
  async deactivateWireGuardTunnel(deviceId: string): Promise<void> {
    log(`Deactivating WireGuard tunnel on ${deviceId}`);
    try {
      await adbShell(
        deviceId,
        `"su -c 'ip link del wg0 2>/dev/null; killall wireguard-go 2>/dev/null; ip rule del table 51820 2>/dev/null; ip rule del fwmark 0xca6c lookup main 2>/dev/null; ip route flush table 51820 2>/dev/null; setenforce 1 2>/dev/null; true'"`,
      );
    } catch {
      // Interface may not exist — that's fine
    }
    log(`WireGuard tunnel deactivated on ${deviceId}`);
  }

  /**
   * Configure an emulator (docker-android or AVD with userdebug build) to
   * route HTTPS traffic through a host-side mitmproxy.
   *
   * Steps:
   *  1. `adb root` to make adbd run as root (works on userdebug/eng builds)
   *  2. push mitmproxy's CA cert into the user trust store
   *     (`/data/misc/user/0/cacerts-added/<hash>.0`). The E2E fixture
   *     (and any app that opts in via `networkSecurityConfig` trusting
   *     user CAs) will then validate mitmproxy's intercepted TLS.
   *  3. `adb reverse tcp:<port> tcp:<port>` so the emulator can reach the
   *     host's mitmproxy via the device's own localhost
   *  4. `adb shell settings put global http_proxy 127.0.0.1:<port>`
   *
   * Differs from `injectMitmproxyCaCert` in two important ways:
   *  - Uses `adb root` instead of `su -c` (emulators don't have Magisk)
   *  - Installs as a USER cert (no /system remount, no APEX namespace
   *    bind-mounts) — paired with the fixture's networkSecurityConfig,
   *    this is the minimum needed for the E2E to validate the chain.
   */
  async setupEmulatorHttpProxy(deviceId: string, proxyPort: number): Promise<void> {
    const certPath = path.join(getMitmproxyConfdir(), 'mitmproxy-ca-cert.pem');
    if (!fs.existsSync(certPath)) {
      throw new Error(`mitmproxy CA cert not found at ${certPath}. Start mitmproxy at least once to generate it.`);
    }

    log(`Elevating adbd to root on ${deviceId}`);
    // `adb root` restarts adbd; the connection drops and reconnects.
    // Bake in a wait-for-device so subsequent shell commands succeed.
    await adbCommand(['-s', deviceId, 'root'], 10_000).catch(() => {
      // `adb root` returns success even when adbd is already root.
      // Some emulator images print "adbd is already running as root"
      // on stderr — that's fine.
    });
    await adbCommand(['-s', deviceId, 'wait-for-device'], 10_000);
    // Confirm we have root. On user-build emulators `adb root` is a no-op
    // and `id` still returns shell uid; fail fast in that case.
    const idOut = await adbShell(deviceId, 'id', 5_000);
    if (!idOut.includes('uid=0')) {
      throw new Error(`Failed to elevate adbd to root on ${deviceId} — emulator may be a "user" build (need userdebug/eng). id=${idOut}`);
    }

    const certPem = fs.readFileSync(certPath, 'utf-8');
    const certHash = computeSubjectHashOld(certPem);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emu-cert-'));
    const tmpCert = path.join(tmpDir, `${certHash}.0`);
    try {
      fs.copyFileSync(certPath, tmpCert);
      // Push into the user trust store. Path is fixed across modern Android.
      log(`Pushing user CA cert ${certHash}.0 to ${deviceId}`);
      await adbCommand(['-s', deviceId, 'shell', 'mkdir', '-p', '/data/misc/user/0/cacerts-added'], 5_000);
      await adbCommand(['-s', deviceId, 'push', tmpCert, `/data/misc/user/0/cacerts-added/${certHash}.0`]);
      await adbShell(deviceId, `chmod 644 /data/misc/user/0/cacerts-added/${certHash}.0`, 5_000);
      await adbShell(deviceId, `chown system:system /data/misc/user/0/cacerts-added/${certHash}.0`, 5_000);
    } finally {
      try { fs.unlinkSync(tmpCert); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }

    // Forward emulator-localhost:<port> back to host:<port> so the emulator
    // can reach the host's mitmproxy via its own loopback. adb reverse uses
    // the existing adb transport — no docker networking changes needed.
    log(`adb reverse tcp:${proxyPort} tcp:${proxyPort} for ${deviceId}`);
    await adbCommand(['-s', deviceId, 'reverse', `tcp:${proxyPort}`, `tcp:${proxyPort}`], 5_000);

    log(`Setting global http_proxy=127.0.0.1:${proxyPort} on ${deviceId}`);
    await adbShell(deviceId, `settings put global http_proxy 127.0.0.1:${proxyPort}`, 5_000);
  }

  /**
   * Inject mitmproxy's CA certificate into the device's system trust store.
   * Requires root. Skips if the cert file doesn't exist yet.
   */
  async injectMitmproxyCaCert(deviceId: string): Promise<void> {
    const certPath = path.join(getMitmproxyConfdir(), 'mitmproxy-ca-cert.pem');
    if (!fs.existsSync(certPath)) {
      throw new Error(`mitmproxy CA cert not found at ${certPath}. Start mitmproxy at least once to generate it.`);
    }

    log(`Injecting CA cert on ${deviceId}`);

    // Quick root check — fails fast (3s) instead of hanging 30s on Magisk prompt
    try {
      await adbShell(deviceId, '"su -c id"', 3000);
    } catch {
      throw new Error(
        'Root access unavailable — check the phone for a Magisk superuser prompt, or grant shell permanent su access in Magisk settings',
      );
    }

    const certPem = fs.readFileSync(certPath, 'utf-8');
    const certHash = computeSubjectHashOld(certPem);

    // Push cert with correct filename directly
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cert-'));
    const tmpCert = path.join(tmpDir2, `${certHash}.0`);
    try {
      fs.copyFileSync(certPath, tmpCert);
      if (!fs.existsSync(tmpCert)) {
        throw new Error(`Failed to copy cert to temp path: ${tmpCert}`);
      }
      log(`Pushing cert ${certHash}.0 (${fs.statSync(tmpCert).size} bytes) to device ${deviceId}`);
      await adbCommand(['-s', deviceId, 'push', tmpCert, `/data/local/tmp/${certHash}.0`]);
    } finally {
      try { fs.unlinkSync(tmpCert); } catch {}
      try { fs.rmdirSync(tmpDir2); } catch {}
    }

    // Injection script modelled after HTTP Toolkit's proven approach:
    // 1. Copy existing certs to temp dir BEFORE mounting tmpfs (originals hidden after mount)
    // 2. Mount tmpfs on /system/etc/security/cacerts and populate from temp copy + our cert
    // 3. nsenter bind-mount into Zygote + running app namespaces (Android 14+ APEX)
    // Written as a script file to avoid shell escaping issues across Windows→adb→su.
    // Each critical step uses `|| { echo "..."; exit 1; }` instead of `set -e`
    // because Android's mksh doesn't support bash's `trap ... ERR`.
    const injectScript = [
      '#!/system/bin/sh',
      'CACERTS=/system/etc/security/cacerts',
      'APEX=/apex/com.android.conscrypt/cacerts',
      `HASH=${certHash}`,
      '',
      '# Verify root',
      'id | grep -q "uid=0" || { echo "FAIL: not running as root ($(id))"; exit 1; }',
      '',
      '# Verify cert was pushed',
      '[ -f "/data/local/tmp/$HASH.0" ] || { echo "FAIL: cert file /data/local/tmp/$HASH.0 not found"; exit 1; }',
      '',
      '# Stage existing certs into a temp dir before we mount over them',
      'mkdir -p /data/local/tmp/darkride-ca-copy',
      'rm -rf /data/local/tmp/darkride-ca-copy/*',
      '',
      '# Copy from APEX (Android 14+) or system path',
      'if [ -d "$APEX" ]; then',
      '  cp "$APEX"/* /data/local/tmp/darkride-ca-copy/ 2>/dev/null || true',
      'fi',
      'if [ -d "$CACERTS" ]; then',
      '  cp "$CACERTS"/* /data/local/tmp/darkride-ca-copy/ 2>/dev/null || true',
      'fi',
      '',
      '# Unmount all previous tmpfs layers (may have stacked from repeated injections)',
      'while umount $CACERTS 2>/dev/null; do :; done',
      'mount -t tmpfs tmpfs $CACERTS || { echo "FAIL: mount tmpfs on $CACERTS: $(mount -t tmpfs tmpfs $CACERTS 2>&1)"; exit 1; }',
      '',
      '# Populate with existing certs + our new cert',
      'mv /data/local/tmp/darkride-ca-copy/* $CACERTS/ 2>/dev/null || true',
      'mv /data/local/tmp/$HASH.0 $CACERTS/ || { echo "FAIL: mv cert to $CACERTS"; exit 1; }',
      '',
      '# Fix permissions and SELinux labels',
      'chown root:root $CACERTS/*',
      'chmod 644 $CACERTS/*',
      'chcon u:object_r:system_file:s0 $CACERTS 2>/dev/null || true',
      'chcon u:object_r:system_file:s0 $CACERTS/* 2>/dev/null || true',
      '',
      '# Android 14+: bind-mount into APEX namespace for each process.',
      '# IMPORTANT: unmount ALL stacked mounts before adding a new one.',
      '# Each capture start previously stacked another mount; after several',
      '# captures the stack grows until Conscrypt/apps break.',
      'if [ -d "$APEX" ]; then',
      '  # Unmount all stacked mounts in the global namespace',
      '  while umount $APEX 2>/dev/null; do :; done',
      '  mount --bind $CACERTS $APEX || { echo "FAIL: bind-mount $CACERTS on $APEX"; exit 1; }',
      '',
      '  ZYGOTE_PID=$(pidof zygote || true)',
      '  ZYGOTE64_PID=$(pidof zygote64 || true)',
      '  for z in $ZYGOTE_PID $ZYGOTE64_PID; do',
      '    if [ -n "$z" ]; then',
      '      # Unmount stacked mounts from previous injections',
      '      while nsenter --mount=/proc/$z/ns/mnt -- /bin/umount $APEX 2>/dev/null; do :; done',
      '      nsenter --mount=/proc/$z/ns/mnt -- /bin/mount --bind $CACERTS $APEX 2>/dev/null || true',
      '    fi',
      '  done',
      '',
      '  APP_PIDS=$(echo $ZYGOTE_PID $ZYGOTE64_PID | xargs -n1 ps -o PID -P 2>/dev/null | grep -v PID || true)',
      '  for p in $APP_PIDS; do',
      '    while nsenter --mount=/proc/$p/ns/mnt -- /bin/umount $APEX 2>/dev/null; do :; done',
      '    nsenter --mount=/proc/$p/ns/mnt -- /bin/mount --bind $CACERTS $APEX 2>/dev/null &',
      '  done',
      '  wait',
      'fi',
      '',
      '# Cleanup',
      'rm -rf /data/local/tmp/darkride-ca-copy',
      'echo "OK: cert $HASH.0 injected"',
    ].join('\n');

    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-script-'));
    const tmpScript = path.join(tmpDir3, 'inject_cert.sh');
    try {
      fs.writeFileSync(tmpScript, injectScript, 'utf-8');
      await adbCommand(['-s', deviceId, 'push', tmpScript, '/data/local/tmp/inject_cert.sh']);
    } finally {
      try { fs.unlinkSync(tmpScript); } catch {}
      try { fs.rmdirSync(tmpDir3); } catch {}
    }

    await adbShell(deviceId, `"su -c 'chmod +x /data/local/tmp/inject_cert.sh && /data/local/tmp/inject_cert.sh 2>&1 && rm /data/local/tmp/inject_cert.sh'"`, 30000);
    log(`CA cert injected on ${deviceId}`);
  }
}

export { CURRENT_SETUP_VERSION, STANDBY_TIMEOUT, MAX_BUSY_IDLE, BUSY_IDLE_WARNING, MIN_BATTERY_LEVEL };
