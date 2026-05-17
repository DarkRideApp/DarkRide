import { eq } from 'drizzle-orm';
import { automationSessions, devices as devicesTable, settings } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import type { MitmproxyManager } from './mitmproxy-manager';
import type { Socks5Proxy } from './mitmproxy-manager';
import type { DeviceManager } from './device-manager';
import type { IosDeviceManager } from './ios-device-manager';
import type { AutomationRunner } from './automation-runner';
import type { TrafficHookRegistry } from './traffic-hook-registry';
import type { CaptureStatusMessage, CaptureSubsystemStatus } from '../../shared/types/websocket';
import type { HookBus } from '@darkrideapp/plugin-sdk';

const { log, error } = createLoggers('capture-session-manager');

interface ActiveCapture {
  sessionId: number;
  deviceId: string;
  tunnelActivated: boolean;
  subsystems?: CaptureSubsystemStatus;
}

export class CaptureSessionManager {
  private activeSessions = new Map<string, ActiveCapture>();
  private iosDeviceManager?: IosDeviceManager;
  private hookBus: HookBus | null = null;

  constructor(
    private db: AppDatabase,
    private mitmproxyManager: MitmproxyManager,
    private deviceManager: DeviceManager,
    private automationRunner?: AutomationRunner,
    private trafficHookRegistry?: TrafficHookRegistry,
  ) {}

  setHookBus(bus: HookBus): void {
    this.hookBus = bus;
  }

  setIosDeviceManager(iosManager: IosDeviceManager): void {
    this.iosDeviceManager = iosManager;
  }

  private getDevicePlatform(deviceId: string): 'android' | 'ios' {
    const device = this.db.select().from(devicesTable).where(eq(devicesTable.id, deviceId)).all()[0];
    return (device?.platform as 'android' | 'ios') ?? 'android';
  }

  async startCapture(deviceId: string, proxyOptions?: { mode: 'none' | 'normal' | 'nordvpn'; country?: string }, tlsProfile?: string): Promise<{ sessionId: number }> {
    // Guard: already capturing
    const existing = this.activeSessions.get(deviceId);
    if (existing) {
      return { sessionId: existing.sessionId };
    }

    // Guard: reject if device is already busy (e.g. an automation is running)
    const platform = this.getDevicePlatform(deviceId);
    if (platform === 'ios' && this.iosDeviceManager) {
      this.iosDeviceManager.markBusy(deviceId);
    } else {
      const acquired = this.deviceManager.tryAcquireBusy(deviceId);
      if (!acquired) {
        throw new Error(`Device ${deviceId} is busy — cannot start capture while an automation is running`);
      }
    }

    // Create session row. Use lastInsertRowid rather than .all().pop()! — the
    // old pattern race-conditioned under concurrent inserts because two callers
    // sharing the same synchronous better-sqlite3 handle could observe each
    // other's rows. Flagged 3× in the pre-launch review (R-3, P-3, Q-1).
    const insertResult = this.db
      .insert(automationSessions)
      .values({
        automationId: null,
        deviceId,
        name: `Capture — ${deviceId}`,
        status: 'running',
        triggerType: 'capture',
        startedAt: new Date(),
      })
      .run();

    const sessionId = Number(insertResult.lastInsertRowid);
    this.hookBus?.emit('session:created', { sessionId, deviceId, triggerType: 'capture' });
    let tunnelActivated = false;

    const subsystems: CaptureSubsystemStatus = {
      mitmproxy: 'pending',
      certInjection: 'pending',
      wireguard: 'pending',
      connectivity: 'pending',
    };

    // Check if capture rules exist
    const hasCaptureRules = this.automationRunner
      ? this.automationRunner.getCaptureRules().length > 0
      : false;

    try {
      // Build mitmproxy options with proxy configuration
      const mitmOptions: any = { sessionId, deviceId, tlsProfile };
      if (hasCaptureRules) {
        mitmOptions.interceptHooks = true;
      }
      if (proxyOptions?.mode === 'nordvpn' && proxyOptions.country) {
        const usernameRow = this.db
          .select().from(settings)
          .where(eq(settings.key, 'nordvpn_username')).all()[0];
        const passwordRow = this.db
          .select().from(settings)
          .where(eq(settings.key, 'nordvpn_password')).all()[0];
        if (!usernameRow || !passwordRow) {
          throw new Error('NordVPN credentials not configured. Set them in Settings.');
        }
        mitmOptions.socks5Proxy = {
          host: `${proxyOptions.country}.socks.nordhold.net`,
          port: 1080,
          username: usernameRow.value,
          password: passwordRow.value,
        } as Socks5Proxy;
        mitmOptions.useProxy = false;
      } else if (proxyOptions?.mode === 'normal') {
        mitmOptions.useProxy = true;
      } else if (proxyOptions?.mode === 'none') {
        mitmOptions.useProxy = false;
      }

      // Start mitmproxy capture
      const tunnelInfo = await this.mitmproxyManager.startCapture(deviceId, mitmOptions);
      subsystems.mitmproxy = 'ok';
      this.broadcastStatus(deviceId, 'capturing', sessionId, undefined, subsystems);

      if (tunnelInfo && platform === 'android') {
        // Inject CA cert
        await this.deviceManager.injectMitmproxyCaCert(deviceId);
        subsystems.certInjection = 'ok';
        this.broadcastStatus(deviceId, 'capturing', sessionId, undefined, subsystems);

        // Activate WireGuard tunnel
        await this.deviceManager.activateWireGuardTunnel(deviceId, tunnelInfo);
        tunnelActivated = true;
        subsystems.wireguard = 'ok';
        this.broadcastStatus(deviceId, 'capturing', sessionId, undefined, subsystems);

        // Sanity-check: ensure mitmproxy didn't crash during cert/tunnel setup
        if (!this.mitmproxyManager.isCapturing(deviceId)) {
          subsystems.mitmproxy = 'error';
          throw new Error('mitmproxy process exited during capture startup');
        }

        // Wait for tunnel connectivity
        const ready = await this.waitForTunnelReady(deviceId);
        subsystems.connectivity = ready ? 'ok' : 'warning';
        if (!ready) {
          log(`Tunnel connectivity not confirmed for device ${deviceId}, proceeding anyway`);
        }
      } else {
        // iOS: user configures WireGuard manually via QR code
        subsystems.certInjection = 'skipped';
        subsystems.wireguard = 'skipped';
        subsystems.connectivity = 'skipped';
      }

      this.activeSessions.set(deviceId, { sessionId, deviceId, tunnelActivated, subsystems });

      this.broadcastStatus(deviceId, 'capturing', sessionId, undefined, subsystems);
      log(`Capture started for device ${deviceId} (session ${sessionId})`);

      // Run capture rules in background (don't block the API response)
      if (hasCaptureRules && this.automationRunner) {
        const runner = this.automationRunner;
        runner.runCaptureRules(deviceId, sessionId).catch((err: any) => {
          error(`Capture rules failed (continuing anyway): ${err.message}`);
        });
      }

      return { sessionId };
    } catch (err: any) {
      // Cleanup on error
      error(`Failed to start capture for device ${deviceId}: ${err.message}`);

      // Mark any still-pending subsystems as error
      for (const key of Object.keys(subsystems) as (keyof CaptureSubsystemStatus)[]) {
        if (subsystems[key] === 'pending') {
          (subsystems as any)[key] = 'error';
        }
      }

      if (tunnelActivated) {
        try { await this.deviceManager.deactivateWireGuardTunnel(deviceId); }
        catch (e: any) { error(`Failed to deactivate tunnel: ${e.message}`); }
      }

      try { await this.mitmproxyManager.stopCapture(deviceId); }
      catch (e: any) { error(`Failed to stop mitmproxy: ${e.message}`); }

      // Mark session as failed
      this.db
        .update(automationSessions)
        .set({ status: 'failed', completedAt: new Date() })
        .where(eq(automationSessions.id, sessionId))
        .run();

      // Mark device as idle since capture failed
      if (platform === 'ios' && this.iosDeviceManager) {
        this.iosDeviceManager.markIdle(deviceId);
      } else {
        this.deviceManager.markIdle(deviceId);
      }

      this.broadcastStatus(deviceId, 'error', sessionId, err.message, subsystems);
      throw err;
    }
  }

  async stopCapture(deviceId: string): Promise<void> {
    const capture = this.activeSessions.get(deviceId);
    if (!capture) {
      log(`No active capture for device ${deviceId}`);
      return;
    }

    // Clear traffic hooks and dispose the persistent rule isolates that own
    // their callbacks. Both must happen — hooks alone leaves the isolates
    // leaking; isolates alone leaves dead references in the registry.
    if (this.trafficHookRegistry) {
      this.trafficHookRegistry.clearHooks(deviceId);
    }
    if (this.automationRunner) {
      this.automationRunner.disposeCaptureRuleIsolates(deviceId);
    }

    // Deactivate tunnel
    if (capture.tunnelActivated) {
      try { await this.deviceManager.deactivateWireGuardTunnel(deviceId); }
      catch (err: any) { error(`Failed to deactivate tunnel: ${err.message}`); }
    }

    // Stop mitmproxy
    try { await this.mitmproxyManager.stopCapture(deviceId); }
    catch (err: any) { error(`Failed to stop mitmproxy: ${err.message}`); }

    // Update session status
    this.db
      .update(automationSessions)
      .set({ status: 'success', completedAt: new Date() })
      .where(eq(automationSessions.id, capture.sessionId))
      .run();

    this.activeSessions.delete(deviceId);

    // Mark device as idle so standby timer can manage it again
    const platform = this.getDevicePlatform(deviceId);
    if (platform === 'ios' && this.iosDeviceManager) {
      this.iosDeviceManager.markIdle(deviceId);
    } else {
      this.deviceManager.markIdle(deviceId);
    }

    this.broadcastStatus(deviceId, 'stopped');
    log(`Capture stopped for device ${deviceId} (session ${capture.sessionId})`);
  }

  isCapturing(deviceId: string): boolean {
    return this.activeSessions.has(deviceId);
  }

  getSessionId(deviceId: string): number | undefined {
    return this.activeSessions.get(deviceId)?.sessionId;
  }

  getSubsystems(deviceId: string): CaptureSubsystemStatus | undefined {
    return this.activeSessions.get(deviceId)?.subsystems;
  }

  getCapturingDeviceIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  async stopAll(): Promise<void> {
    const deviceIds = [...this.activeSessions.keys()];
    for (const deviceId of deviceIds) {
      try { await this.stopCapture(deviceId); }
      catch (err: any) { error(`Failed to stop capture for ${deviceId}: ${err.message}`); }
    }
  }

  private async waitForTunnelReady(
    deviceId: string,
    maxAttempts: number = 5,
    intervalMs: number = 1000,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.deviceManager.testTunnelConnectivity(deviceId);
      if (result.success) {
        log(`Tunnel ready for device ${deviceId} (attempt ${attempt}/${maxAttempts})`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  private broadcastStatus(
    deviceId: string,
    status: 'capturing' | 'stopped' | 'error',
    sessionId?: number,
    errorMsg?: string,
    subsystems?: CaptureSubsystemStatus,
  ): void {
    const message: CaptureStatusMessage = {
      type: 'capture-status',
      deviceId,
      status,
      sessionId,
      error: errorMsg,
      subsystems: subsystems ? { ...subsystems } : undefined,
    };
    broadcastToAll(message);
  }
}
