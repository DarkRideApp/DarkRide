import { resolve } from 'path';
import { existsSync } from 'fs';
import { eq } from 'drizzle-orm';
import { devices } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';
import { broadcastToAll } from '../websocket/index';
import type { DOMNode, Selector } from '../../shared/types/automation';
import type { DeviceStatus } from './device-manager';

const { log, error } = createLoggers('ios-device-manager');

const IOS_POLL_INTERVAL = 5000;
const IOS_POLL_BACKOFF_INTERVAL = 60_000; // 60s when usbmuxd / bridge unavailable
const IOS_DOM_CACHE_TTL_MS = 3000; // 3s TTL for DOM caching (WDA responses take 1-10s)

interface IosBridgeDevice {
  udid: string;
  device_name: string | null;
  product_type: string | null;
  model_name: string | null;
  model_number: string | null;
  ios_version: string | null;
  build_version: string | null;
  paired: boolean;
}

interface IosBridgeDeviceInfo {
  udid: string;
  device_name: string | null;
  product_type: string | null;
  model_name: string | null;
  model_number: string | null;
  hardware_model: string | null;
  ios_version: string | null;
  build_version: string | null;
  serial_number: string | null;
  wifi_address: string | null;
  wifi_ssid: string | null;
  bluetooth_address: string | null;
  phone_number: string | null;
  cpu_architecture: string | null;
  battery: { level: number | null; charging: boolean } | Record<string, never>;
  storage: { total_gb: number; available_gb: number } | Record<string, never>;
  paired: boolean;
}

export interface SyslogEntry {
  timestamp: string;
  pid: number;
  process: string;
  level: string;
  message: string;
  subsystem: string;
  category: string;
}

export class IosDeviceManager {
  private onlineDevices = new Set<string>();
  private busyDevices = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private bridgePort: number | null = null;
  private bridgeProcess: import('child_process').ChildProcess | null = null;
  private bridgeReady = false;
  private bridgeFailCount = 0;
  private bridgeLastFailTime = 0;
  private lastStderrLine = '';
  private pollBackoff = false;

  // DOM cache per device: { dom, fetchedAt }
  private domCache = new Map<string, { dom: DOMNode; fetchedAt: number }>();

  constructor(private db: AppDatabase) {}

  start(): void {
    log('Starting iOS device manager');
    this.poll().finally(() => this.schedulePoll());
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopBridge();
    log('iOS device manager stopped');
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const interval = this.pollBackoff ? IOS_POLL_BACKOFF_INTERVAL : IOS_POLL_INTERVAL;
    this.pollTimer = setTimeout(() => {
      this.poll().finally(() => this.schedulePoll());
    }, interval);
  }

  private bridgeStarting: Promise<number> | null = null;

  private async startBridge(): Promise<number> {
    if (this.bridgeReady && this.bridgePort) return this.bridgePort;
    // Prevent concurrent spawn attempts — if one is already in progress, wait for it
    if (this.bridgeStarting) return this.bridgeStarting;
    this.bridgeStarting = this.doStartBridge().finally(() => { this.bridgeStarting = null; });
    return this.bridgeStarting;
  }

  private async doStartBridge(): Promise<number> {
    if (this.bridgeReady && this.bridgePort) return this.bridgePort;

    // Back off if bridge keeps failing — wait 30s after 1st fail, 60s after 2nd, etc.
    const now = Date.now();
    if (this.bridgeFailCount > 0) {
      const backoffMs = Math.min(this.bridgeFailCount * 30_000, 300_000); // max 5 min
      if (now - this.bridgeLastFailTime < backoffMs) {
        throw new Error('iOS bridge in backoff after repeated failures');
      }
    }

    const { spawn } = await import('child_process');
    const { ensureVenv } = await import('./python-bridge');

    const port = 9200;
    const pythonBin = ensureVenv();
    const scriptPath = resolve(process.cwd(), 'python/ios_bridge.py');

    if (!existsSync(scriptPath)) {
      throw new Error('ios_bridge.py not found');
    }

    // Kill any leftover process on the port before spawning
    this.stopBridge();

    log(`Spawning iOS bridge on port ${port}`);
    const child = spawn(pythonBin, [scriptPath, '--port', port.toString()], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.bridgeProcess = child;
    this.bridgePort = port;

    // Track early exit during startup
    let earlyExit = false;
    let earlyExitCode: number | null = null;

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && line !== this.lastStderrLine) {
        this.lastStderrLine = line;
        error(`iOS bridge: ${line}`);
      }
    });

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(`iOS bridge: ${line}`);
    });

    child.on('exit', (code) => {
      log(`iOS bridge exited with code ${code}`);
      this.bridgeReady = false;
      this.bridgeProcess = null;
      earlyExit = true;
      earlyExitCode = code;
    });

    child.on('error', (err) => {
      error(`iOS bridge error: ${err.message}`);
      this.bridgeReady = false;
      this.bridgeProcess = null;
      earlyExit = true;
    });

    // Wait for health check — abort early if process exits
    for (let i = 0; i < 20; i++) {
      if (earlyExit) {
        this.bridgeFailCount++;
        this.bridgeLastFailTime = Date.now();
        throw new Error(`iOS bridge exited immediately with code ${earlyExitCode}`);
      }
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
          this.bridgeReady = true;
          this.bridgeFailCount = 0;
          log('iOS bridge is healthy');
          return port;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.bridgeFailCount++;
    this.bridgeLastFailTime = Date.now();
    // Kill the stuck process
    if (this.bridgeProcess) {
      this.bridgeProcess.kill('SIGTERM');
      this.bridgeProcess = null;
    }
    throw new Error('iOS bridge failed health check');
  }

  private stopBridge(): void {
    if (this.bridgeProcess) {
      this.bridgeProcess.kill('SIGTERM');
      this.bridgeProcess = null;
      this.bridgeReady = false;
      this.bridgePort = null;
    }
  }

  private async rpc(method: string, params: Record<string, any> = {}): Promise<any> {
    const port = await this.startBridge();
    const response = await fetch(`http://localhost:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body: any = await response.json();
    if (body.error) {
      throw new Error(body.error.message || 'RPC error');
    }
    return body.result;
  }

  private async poll(): Promise<void> {
    try {
      const discoveredDevices: IosBridgeDevice[] = await this.rpc('list_devices');
      const discoveredIds = new Set(discoveredDevices.map((d) => d.udid));

      // Detect newly offline devices
      for (const id of this.onlineDevices) {
        if (!discoveredIds.has(id)) {
          this.onlineDevices.delete(id);
          log(`iOS device offline: ${id}`);
          broadcastToAll({ type: 'device-status', deviceId: id, status: 'offline' });
        }
      }

      for (const dev of discoveredDevices) {
        const isNew = !this.onlineDevices.has(dev.udid);
        this.onlineDevices.add(dev.udid);

        // Upsert device into DB
        const existing = this.db.select().from(devices).where(eq(devices.id, dev.udid)).all()[0];
        if (!existing) {
          const modelDisplay = dev.model_name || dev.product_type;
          this.db.insert(devices).values({
            id: dev.udid,
            name: dev.device_name,
            platform: 'ios',
            manufacturer: 'Apple',
            model: modelDisplay,
            iosVersion: dev.ios_version,
            lastSeen: new Date(),
          }).run();
          log(`iOS device discovered: ${dev.udid} (${modelDisplay})`);
        } else {
          const modelDisplay = dev.model_name || dev.product_type;
          this.db.update(devices).set({
            platform: 'ios',
            manufacturer: 'Apple',
            model: modelDisplay || existing.model,
            iosVersion: dev.ios_version || existing.iosVersion,
            lastSeen: new Date(),
          }).where(eq(devices.id, dev.udid)).run();
        }

        // Collect detailed info for newly discovered or paired devices
        if (isNew && dev.paired) {
          this.collectDeviceInfo(dev.udid).catch((err) => {
            error(`Failed to collect info for ${dev.udid}: ${err.message}`);
          });
        }

        if (isNew) {
          broadcastToAll({ type: 'device-status', deviceId: dev.udid, status: 'online' });
        }
      }
    } catch (err: any) {
      // Bridge not running or pymobiledevice3 not available — back off polling
      if (!this.pollBackoff) {
        this.pollBackoff = true;
        log(`iOS poll failed, backing off to ${IOS_POLL_BACKOFF_INTERVAL / 1000}s interval: ${err.message}`);
      }
      return;
    }
    // Poll succeeded — reset backoff
    if (this.pollBackoff) {
      this.pollBackoff = false;
      log('iOS poll recovered, resuming normal interval');
    }
  }

  private async collectDeviceInfo(udid: string): Promise<void> {
    try {
      const info: IosBridgeDeviceInfo = await this.rpc('device_info', { udid });
      const modelDisplay = info.model_name || info.product_type;
      this.db.update(devices).set({
        name: info.device_name,
        model: modelDisplay,
        iosVersion: info.ios_version,
        serialNumber: info.serial_number,
        cpuAbi: info.cpu_architecture,
      }).where(eq(devices.id, udid)).run();
      log(`Collected info for iOS device ${udid}: ${modelDisplay} iOS ${info.ios_version}`);
    } catch (err: any) {
      error(`Failed to collect device info for ${udid}: ${err.message}`);
    }
  }

  async pair(udid: string): Promise<{ success: boolean }> {
    const result = await this.rpc('pair', { udid });
    // Refresh device info after pairing
    await this.collectDeviceInfo(udid);
    return result;
  }

  async checkPaired(udid: string): Promise<{ paired: boolean }> {
    return this.rpc('check_paired', { udid });
  }

  async getDeviceInfo(udid: string): Promise<IosBridgeDeviceInfo> {
    return this.rpc('device_info', { udid });
  }

  // ---- WDA (WebDriverAgent) methods ----

  async installWda(udid: string): Promise<{ success: boolean }> {
    return this.rpc('install_wda', { udid });
  }

  async launchWda(udid: string): Promise<{ success: boolean; port?: number; already_running?: boolean }> {
    return this.rpc('launch_wda', { udid });
  }

  async stopWda(udid: string): Promise<{ success: boolean }> {
    return this.rpc('stop_wda', { udid });
  }

  async wdaStatus(udid: string): Promise<{ running: boolean; port?: number }> {
    return this.rpc('wda_status', { udid });
  }

  async wdaScreenshot(udid: string): Promise<{ image: string; format: string }> {
    return this.rpc('wda_screenshot', { udid });
  }

  async wdaDom(udid: string): Promise<{ source: string; format: string }> {
    return this.rpc('wda_dom', { udid });
  }

  async wdaTap(udid: string, x: number, y: number): Promise<{ success: boolean }> {
    return this.rpc('wda_tap', { udid, x, y });
  }

  async wdaSwipe(udid: string, startX: number, startY: number, endX: number, endY: number, duration = 0.3): Promise<{ success: boolean }> {
    return this.rpc('wda_swipe', { udid, start_x: startX, start_y: startY, end_x: endX, end_y: endY, duration });
  }

  async wdaWindowSize(udid: string): Promise<{ width: number; height: number }> {
    return this.rpc('wda_window_size', { udid });
  }

  async wdaPressButton(udid: string, button: string): Promise<{ success: boolean }> {
    return this.rpc('wda_pressbutton', { udid, button });
  }

  /**
   * Get parsed DOM (DOMNode) for an iOS device with aggressive caching.
   * WDA /source can take 1-10s, so we cache for 3s.
   */
  async wdaDomParsed(udid: string, forceRefresh = false): Promise<DOMNode> {
    if (!forceRefresh) {
      const cached = this.domCache.get(udid);
      if (cached && (Date.now() - cached.fetchedAt) < IOS_DOM_CACHE_TTL_MS) {
        return cached.dom;
      }
    }

    const dom: DOMNode = await this.rpc('wda_dom_parsed', { udid });
    this.domCache.set(udid, { dom, fetchedAt: Date.now() });
    return dom;
  }

  /** Invalidate DOM cache for a device (after mutations like tap/swipe). */
  invalidateDomCache(udid: string): void {
    this.domCache.delete(udid);
  }

  /** Find a single element via WDA server-side search. */
  async wdaFindElement(udid: string, selector: Selector): Promise<{
    elementId: string;
    bounds: [number, number, number, number];
    text: string;
    className: string;
    enabled: boolean;
    clickable: boolean;
  }> {
    return this.rpc('wda_find_element', { udid, selector });
  }

  /** Find multiple elements via WDA server-side search. */
  async wdaFindElements(udid: string, selector: Selector): Promise<Array<{
    elementId: string;
    bounds: [number, number, number, number];
    text: string;
    className: string;
  }>> {
    return this.rpc('wda_find_elements', { udid, selector });
  }

  /** Click an element by WDA element ID. */
  async wdaClickElement(udid: string, elementId: string): Promise<{ success: boolean }> {
    this.invalidateDomCache(udid);
    return this.rpc('wda_click_element', { udid, element_id: elementId });
  }

  // ---- Phase 1.5: Native (no-WDA) methods ----

  async listApps(deviceId: string): Promise<Array<{
    packageName: string;
    name: string;
    versionName: string;
    versionCode: string;
    sizeBytes: number;
  }>> {
    return this.rpc('list_apps', { udid: deviceId });
  }

  async screenshotNative(deviceId: string): Promise<{ image: string; format: string }> {
    return this.rpc('screenshot_native', { udid: deviceId });
  }

  async screenshotTunnel(deviceId: string): Promise<{ image: string; format: string }> {
    return this.rpc('screenshot_tunnel', { udid: deviceId });
  }

  async screenshotWithFallback(deviceId: string): Promise<{ image: string; format: string }> {
    // Delegates to Python's screenshot_auto which picks the best method
    // based on iOS version and available services:
    //   iOS 17+:  tunnel DVT  ->  WDA
    //   iOS < 17: WDA  ->  native (lockdown)  ->  tunnel DVT
    return this.rpc('screenshot_auto', { udid: deviceId });
  }

  async tunnelStatus(): Promise<{ available: boolean; devices: Record<string, { host: string; port: number }> }> {
    return this.rpc('tunnel_status');
  }

  async restartDevice(deviceId: string): Promise<{ status: string }> {
    return this.rpc('device_restart', { udid: deviceId });
  }

  async shutdownDevice(deviceId: string): Promise<{ status: string }> {
    return this.rpc('device_shutdown', { udid: deviceId });
  }

  async sleepDevice(deviceId: string): Promise<{ status: string }> {
    return this.rpc('device_sleep', { udid: deviceId });
  }

  async listCrashLogs(deviceId: string): Promise<Array<{ filename: string; path: string }>> {
    return this.rpc('list_crash_logs', { udid: deviceId });
  }

  async getCrashLog(deviceId: string, logPath: string): Promise<{ content: string }> {
    return this.rpc('get_crash_log', { udid: deviceId, path: logPath });
  }

  async listProcesses(deviceId: string): Promise<Array<{ pid: number; name: string }>> {
    return this.rpc('list_processes', { udid: deviceId });
  }

  // ---- Syslog streaming ----

  async startSyslog(deviceId: string): Promise<{ status: string }> {
    return this.rpc('syslog_start', { udid: deviceId });
  }

  async stopSyslog(deviceId: string): Promise<{ status: string }> {
    return this.rpc('syslog_stop', { udid: deviceId });
  }

  async pollSyslog(deviceId: string, sinceIndex: number): Promise<{
    entries: SyslogEntry[];
    running: boolean;
    nextIndex: number;
  }> {
    return this.rpc('syslog_poll', { udid: deviceId, since_index: sinceIndex });
  }

  tryAcquireBusy(deviceId: string): boolean {
    if (this.busyDevices.has(deviceId)) return false;
    this.busyDevices.add(deviceId);
    return true;
  }

  markBusy(deviceId: string): void {
    this.busyDevices.add(deviceId);
  }

  markIdle(deviceId: string): void {
    this.busyDevices.delete(deviceId);
  }

  isOnline(deviceId: string): boolean {
    return this.onlineDevices.has(deviceId);
  }

  isBusy(deviceId: string): boolean {
    return this.busyDevices.has(deviceId);
  }

  /**
   * Whether the iOS bridge prerequisites are installed on this host —
   * specifically whether the Python `ios_bridge.py` script is present in
   * the project. Returns `true` even if the bridge process is not
   * currently running (the poller starts it lazily). The `bridgeReady`
   * runtime state is a separate concern (see `start()` polling backoff)
   * and is not exposed publicly.
   *
   * Used by the `ios-device` provider's `isAvailable()` check.
   */
  isAvailable(): boolean {
    const scriptPath = resolve(process.cwd(), 'python/ios_bridge.py');
    return existsSync(scriptPath);
  }

  /**
   * Snapshot of currently-known iOS devices. Reads the UDIDs from the
   * online set and joins with the device-name cache; cheaper than another
   * round-trip to the Python bridge.
   *
   * Used by the `ios-device` provider's `listInstances()`. The shape is
   * deliberately minimal — providers map further into DeviceProviderInstance.
   */
  async getDevices(): Promise<Array<{ udid: string; name?: string | null; isOnline: boolean }>> {
    // Read the iOS devices the poller has seen, joined with their name from
    // the devices table. We don't call back into the bridge here — the
    // poller maintains onlineDevices and the devices table already has the
    // metadata. For UDIDs not in onlineDevices, treat as offline.
    const rows = this.db.select().from(devices).where(eq(devices.platform, 'ios')).all() as Array<{ id: string; name: string | null }>;
    return rows.map((r) => ({
      udid: r.id,
      name: r.name,
      isOnline: this.onlineDevices.has(r.id),
    }));
  }

  async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
    const device = this.db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
    if (!device || device.platform !== 'ios') return null;

    const isOnline = this.onlineDevices.has(device.id);
    let batteryLevel: number | null = null;
    let wifiAddress: string | null = null;
    let wifiSsid: string | null = null;
    let bluetoothAddress: string | null = null;
    let phoneNumber: string | null = null;

    if (isOnline) {
      try {
        const info: IosBridgeDeviceInfo = await this.rpc('device_info', { udid: deviceId });
        batteryLevel = info.battery?.level ?? null;
        wifiAddress = info.wifi_address ?? null;
        wifiSsid = info.wifi_ssid ?? null;
        bluetoothAddress = info.bluetooth_address ?? null;
        phoneNumber = info.phone_number ?? null;
      } catch {
        // ignore
      }
    }

    return {
      id: device.id,
      name: device.name,
      platform: 'ios',
      isRooted: false,
      setupVersion: 0,
      bridgePort: device.bridgePort,
      lastSeen: device.lastSeen,
      batteryLevel,
      needsSetup: false,
      isBusy: this.busyDevices.has(device.id),
      isOnline,
      manufacturer: 'Apple',
      model: device.model ?? null,
      androidVersion: null,
      iosVersion: device.iosVersion ?? null,
      apiLevel: null,
      cpuAbi: device.cpuAbi ?? null,
      serialNumber: device.serialNumber ?? null,
      bootloaderLocked: null,
      wifiAddress,
      wifiSsid,
      bluetoothAddress,
      phoneNumber,
    };
  }

  async getAllDeviceStatuses(): Promise<DeviceStatus[]> {
    const iosDevices = this.db.select().from(devices).where(eq(devices.platform, 'ios')).all();
    const statuses: DeviceStatus[] = [];

    for (const device of iosDevices) {
      const isOnline = this.onlineDevices.has(device.id);
      statuses.push({
        id: device.id,
        name: device.name,
        platform: 'ios',
        isRooted: false,
        setupVersion: 0,
        bridgePort: device.bridgePort,
        lastSeen: device.lastSeen,
        batteryLevel: null,
        needsSetup: false,
        isBusy: this.busyDevices.has(device.id),
        isOnline,
        manufacturer: 'Apple',
        model: device.model ?? null,
        androidVersion: null,
        iosVersion: device.iosVersion ?? null,
        apiLevel: null,
        cpuAbi: device.cpuAbi ?? null,
        serialNumber: device.serialNumber ?? null,
        bootloaderLocked: null,
      });
    }

    return statuses;
  }
}
