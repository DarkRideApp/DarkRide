import { eq, and, asc } from 'drizzle-orm';
import { automations, automationSessions, settings, fridaScripts, interceptRules, clientCerts, devices } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { AutomationCompiler } from './automation-compiler';
import type { SandboxHandle } from './automation-sandbox';
import { PythonBridgeManager, type PythonBridge } from './python-bridge';
import { DeviceAPIImpl } from './device-api';
import { HttpAPIImpl } from './http-api';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import type { MitmproxyManager } from './mitmproxy-manager';
import type { DeviceManager } from './device-manager';
import type { TrafficHookRegistry } from './traffic-hook-registry';
import { syncInterceptConfig } from './intercept-config-writer';
import type { NotificationService } from './notification-service';
import type { AiToolRegistry } from './ai-tools';
import type { IosDeviceManager } from './ios-device-manager';
import type { AutomationRunner as IAutomationRunner } from '@darkrideapp/plugin-sdk';
import type { SessionStatusUpdate } from '../../shared/types/websocket';
import type { TriggerType } from '../../shared/types/api';
import { DocumentStore } from './document-store';
import type { HookBus } from '@darkrideapp/plugin-sdk';

const { log, error } = createLoggers('automation-runner');

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class AutomationRunner implements IAutomationRunner {
  private compiler: AutomationCompiler;
  private runningRules = new Set<string>();
  private notificationService?: NotificationService;
  private iosDeviceManager?: IosDeviceManager;
  private toolRegistry: AiToolRegistry | null = null;
  private hookBus: HookBus | null = null;
  // Persistent sandbox isolates for capture rules, keyed by deviceId.
  // Each handle keeps its isolate alive so registered hook callbacks can fire
  // after the rule's top-level code has returned. Disposed when capture stops
  // or capture rules are re-run for the device.
  private captureRuleIsolates = new Map<string, SandboxHandle[]>();
  // Active automation runs keyed by sessionId. The AbortController lets the
  // /v1/automation/session/:id/cancel endpoint (and the cancel_automation_run
  // tool) terminate a run mid-flight by killing the V8 isolate.
  private activeRuns = new Map<number, AbortController>();

  constructor(
    private db: AppDatabase,
    private bridgeManager: PythonBridgeManager,
    compiler?: AutomationCompiler,
    private mitmproxyManager?: MitmproxyManager,
    private deviceManager?: DeviceManager,
    private trafficHookRegistry?: TrafficHookRegistry,
  ) {
    this.compiler = compiler || new AutomationCompiler();
  }

  setHookBus(bus: HookBus): void {
    this.hookBus = bus;
  }

  setNotificationService(service: NotificationService) {
    this.notificationService = service;
  }

  /**
   * Cancel an in-flight automation run by sessionId. Returns true if a run
   * was found and aborted; false if no active run matches. The session row
   * is updated asynchronously to status='cancelled' by the runAutomation
   * catch block once the abort propagates.
   */
  cancelRun(sessionId: number): boolean {
    const controller = this.activeRuns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Currently-running session IDs. */
  getActiveRunSessionIds(): number[] {
    return [...this.activeRuns.keys()];
  }

  setIosDeviceManager(manager: IosDeviceManager) {
    this.iosDeviceManager = manager;
  }

  setToolRegistry(registry: AiToolRegistry): void {
    this.toolRegistry = registry;
  }

  private buildToolsProxy(): Record<string, (params: any) => Promise<any>> {
    if (!this.toolRegistry) return {};
    const registry = this.toolRegistry;
    return new Proxy({} as Record<string, (params: any) => Promise<any>>, {
      get(_target, prop: string) {
        return (params: any) => registry.executeTool(prop, params);
      },
    });
  }

  async runAutomation(
    automationId: number,
    deviceId: string | undefined,
    triggerType: TriggerType,
  ): Promise<{ sessionId: number; success: boolean; error?: string }> {
    // 1. Fetch automation from DB
    const automation = this.db
      .select()
      .from(automations)
      .where(eq(automations.id, automationId))
      .all()[0];

    if (!automation) {
      throw new Error(`Automation ${automationId} not found`);
    }

    const needsDevice = automation.requiresDevice !== false;

    if (needsDevice && !deviceId) {
      throw new Error(`Automation "${automation.name}" requires a device but none was provided`);
    }

    // Guard: reject if device is already busy (prevents concurrent automations)
    let busyAcquired = false;
    if (needsDevice && deviceId && this.deviceManager) {
      const acquired = this.deviceManager.tryAcquireBusy(deviceId);
      if (!acquired) {
        throw new Error(`Device ${deviceId} is busy — another automation or capture is running`);
      }
      busyAcquired = true;

      // Defense-in-depth: also reject if mitmproxy is actively capturing for this device.
      // tryAcquireBusy above catches the normal case; this guards against any code path
      // that bypasses the busy lock (e.g. a legacy markBusy caller).
      if (this.mitmproxyManager?.isCapturing(deviceId)) {
        this.deviceManager.markIdle(deviceId);
        throw new Error(`Device ${deviceId} has an active capture session — stop it before running an automation`);
      }
    }

    // Outer try wraps all post-acquire setup (session insert, broadcast, keep-alives,
    // capture setup) so that any throw here still releases the busy lock. Without it,
    // a DB-locked insert or a crash in the capture startup would leave the device
    // permanently stuck in the "busy" state. The inner try/finally around the VM
    // execution handles its own cleanup; this wrapper only handles the pre-inner path.
    try {

    // 2. Create automation session
    const insertResult = this.db
      .insert(automationSessions)
      .values({
        automationId,
        deviceId: deviceId ?? null,
        name: automation.name,
        status: 'running',
        triggerType,
        startedAt: new Date(),
      })
      .run();

    // Use lastInsertRowid rather than .all().pop()! — the old pattern race-conditioned
    // under concurrent inserts to automation_sessions because better-sqlite3 runs
    // synchronously but unrelated callers on the same handle could land a row
    // between the insert and the select. Flagged independently 3× in the pre-launch
    // review (R-3, P-3, Q-1).
    const sessionId = Number(insertResult.lastInsertRowid);
    this.hookBus?.emit('session:created', { sessionId, deviceId, triggerType });
    this.hookBus?.emit('automation:started', { sessionId, automationId, deviceId, triggerType });

    // Broadcast running status
    this.broadcastSessionStatus(sessionId, 'running', automationId, deviceId, triggerType);

    log(`Starting automation "${automation.name}" (session ${sessionId})${deviceId ? ` on device ${deviceId}` : ' (deviceless)'}`);

    // Keep-alive: periodically refresh the busy timestamp so MAX_BUSY_IDLE
    // doesn't force-idle the device during long-running automations
    const busyKeepAlive = (needsDevice && deviceId && this.deviceManager)
      ? setInterval(() => this.deviceManager!.refreshBusy(deviceId), 60_000)
      : null;

    // Screen keep-alive: periodically check screen is on and re-wake if needed
    const screenKeepAlive = (needsDevice && deviceId && this.deviceManager)
      ? setInterval(async () => {
          try {
            const powerState = await this.deviceManager!.executeShellCommand(deviceId, 'dumpsys power | grep "Display Power"');
            if (powerState.includes('OFF')) {
              log(`Screen off during automation on ${deviceId}, re-waking`);
              await this.deviceManager!.unlockDevice(deviceId);
            }
          } catch {
            // Non-fatal — device may be temporarily unresponsive
          }
        }, 30_000)
      : null;

    // Create capture handlers early so initial startup can use shared TLS profile state
    const captureHandlers = (needsDevice && deviceId && this.mitmproxyManager && this.deviceManager)
      ? this.createCaptureHandlers(deviceId, sessionId)
      : null;

    // Start HTTPS traffic capture if required
    let captureStarted = false;
    let tunnelActivated = false;
    if (needsDevice && deviceId && automation.requiresHttpsCapture && this.mitmproxyManager) {
      try {
        const tlsProfile = captureHandlers?.getTlsProfile();
        const tunnelInfo = await this.mitmproxyManager.startCapture(deviceId, {
          sessionId,
          deviceId,
          ...(tlsProfile ? { tlsProfile } : {}),
          interceptHooks: true,
        });
        captureStarted = true;

        // Activate WireGuard tunnel on the device
        if (tunnelInfo && this.deviceManager) {
          try {
            await this.deviceManager.injectMitmproxyCaCert(deviceId);
            await this.deviceManager.activateWireGuardTunnel(deviceId, tunnelInfo);
            tunnelActivated = true;

            // Wait for full interception pipeline to be ready
            const interceptReady = await this.waitForInterceptReady(deviceId, sessionId);
            if (!interceptReady) {
              log(`HTTPS interception not confirmed for session ${sessionId}, proceeding anyway`);
            }
          } catch (tunnelErr: any) {
            log(`WireGuard tunnel failed (continuing anyway): ${tunnelErr.message}`);
          }
        }
      } catch (err: any) {
        log(`Failed to start HTTPS capture (continuing anyway): ${err.message}`);
      }
    }

    // Run capture rules if HTTPS capture was started
    if (captureStarted && deviceId) {
      try {
        await this.runCaptureRules(deviceId, sessionId);
      } catch (err: any) {
        log(`Capture rules failed (continuing anyway): ${err.message}`);
      }
    }

    let deviceAPI: DeviceAPIImpl | null = null;
    let bridge: PythonBridge | null = null;
    let httpAPI: HttpAPIImpl | null = null;

    try {
      // 3. Compile automation code
      const compiled = this.compiler.compileWithCache(
        automation.code,
        automationId.toString(),
      );

      // 4. Check for compilation errors
      const compileErrors = (compiled.diagnostics || []).filter(
        (d) => d.category === 1, // ts.DiagnosticCategory.Error
      );

      if (compileErrors.length > 0) {
        const errorMsg = compileErrors.map((d) =>
          typeof d.messageText === 'string'
            ? d.messageText
            : d.messageText.messageText,
        ).join('; ');

        this.updateSession(sessionId, 'failed', `Compilation errors: ${errorMsg}`);
        this.broadcastSessionStatus(sessionId, 'failed', automationId, deviceId, triggerType, errorMsg);
        return { sessionId, success: false, error: errorMsg };
      }

      // 5. Detect device platform
      let devicePlatform: 'android' | 'ios' = 'android';
      if (needsDevice && deviceId) {
        const deviceRow = this.db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
        if (deviceRow?.platform === 'ios') {
          devicePlatform = 'ios';
        }
      }

      // 5b. Start Python bridge (only if device is needed and platform is Android)
      if (needsDevice && deviceId && devicePlatform === 'android') {
        bridge = await this.bridgeManager.getBridge(deviceId);
        bridge.disableIdleTimeout();
      }

      // 6. Create DeviceAPI instance + the server-side HttpAPI.
      //
      // We always create both — even for deviceless automations — so methods
      // that don't actually need a device (httpGet/httpPost/sleep/
      // getCredentials, http.*) still work. The DeviceAPIImpl constructor
      // takes `''` for deviceId and `0` for bridgePort in the deviceless
      // case; callBridge throws a clear "device required" error if those
      // device-only methods are called.
      const canCreateBridge = needsDevice && deviceId && (bridge || (devicePlatform === 'ios' && this.iosDeviceManager));
      deviceAPI = new DeviceAPIImpl(
        deviceId ?? '',
        bridge?.port ?? 0,
        sessionId,
        this.db,
        undefined,
        this.trafficHookRegistry,
        devicePlatform,
        canCreateBridge ? this.iosDeviceManager : null,
      );
      const execLogEarly = deviceAPI.getExecutionLog();
      httpAPI = new HttpAPIImpl(execLogEarly, this.db);

      // 6a. Wire proxy + TLS profile handlers.
      // Device-attached path uses the existing mitmproxy + WireGuard chain;
      // deviceless path delegates to httpAPI.setProxy so server-side fetch
      // (http.* and device.httpGet aliases) is routed through the proxy.
      // The user's automation calls device.setProxy(...) either way.
      if (canCreateBridge && captureHandlers) {
        deviceAPI.setProxyHandler(captureHandlers.proxyHandler);
        deviceAPI.setTlsProfileHandler(captureHandlers.tlsProfileHandler);
      } else {
        const httpApiRef = httpAPI;
        deviceAPI.setProxyHandler(async (mode, options) => {
          await httpApiRef.setProxy(mode, options);
        });
        // TLS profile spoofing for deviceless: route through the
        // server-side mitmproxy pool so outbound TLS uses the same
        // Python-side fingerprint logic as device traffic.
        deviceAPI.setTlsProfileHandler(async (profile) => {
          await httpApiRef.setTlsProfile(profile as 'default' | 'chrome' | 'okhttp');
        });
      }

      if (canCreateBridge && deviceId) {

        // 6b. Wire rules runner into DeviceAPI (skip for rules — they ARE the recovery mechanism)
        if (!automation.isRule) {
          deviceAPI.setRulesRunner(() => this.runRules(deviceAPI!));
        }

        // Wire Frida script resolver
        deviceAPI.setFridaScriptResolver(async (name: string) => {
          const script = this.db.select().from(fridaScripts)
            .where(eq(fridaScripts.name, name)).all()[0];
          return script?.code ?? null;
        });

        // 6c. Enable ATX-free mode for non-rule automations (3-4x faster DOM fetches)
        if (!automation.isRule) {
          try {
            await deviceAPI.setATXFree(true);
          } catch (err: any) {
            log(`Failed to enable ATX-free mode (continuing normally): ${err.message}`);
          }
        }

        // 6d. Wake screen and dismiss lock screen
        try {
          await deviceAPI.wakeAndUnlock();
        } catch (err: any) {
          log(`Wake/unlock failed (continuing anyway): ${err.message}`);
        }
      }

      // 7. Execute with timeout
      const timeoutMs = automation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const rawDocStore = new DocumentStore(this.db);
      // For deviceless automations, create a minimal execution log
      const execLog = deviceAPI ? deviceAPI.getExecutionLog() : [] as any[];
      const documentStore = {
        async getDoc(docId: string) {
          const start = Date.now();
          try {
            const result = await rawDocStore.getDoc(docId);
            execLog.push({ timestamp: new Date().toISOString(), method: 'getDoc', params: { docId }, result, durationMs: Date.now() - start });
            return result;
          } catch (err: any) {
            execLog.push({ timestamp: new Date().toISOString(), method: 'getDoc', params: { docId }, error: err.message, durationMs: Date.now() - start });
            throw err;
          }
        },
        async putDoc(docId: string, doc: any) {
          const start = Date.now();
          try {
            const result = await rawDocStore.putDoc(docId, doc);
            execLog.push({ timestamp: new Date().toISOString(), method: 'putDoc', params: { docId }, result, durationMs: Date.now() - start });
            return result;
          } catch (err: any) {
            execLog.push({ timestamp: new Date().toISOString(), method: 'putDoc', params: { docId }, error: err.message, durationMs: Date.now() - start });
            throw err;
          }
        },
      };

      // Build a console that logs to both the system logger and the execution timeline
      const automationLogger = createLoggers('automation');
      const makeConsoleMethod = (severity: 'log' | 'warn' | 'error') => (...args: any[]) => {
        const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        if (severity === 'error') automationLogger.error(message);
        else automationLogger.log(message);
        execLog.push({
          timestamp: new Date().toISOString(),
          method: `console.${severity}`,
          params: { message },
          durationMs: 0,
        });
      };
      const automationConsole = {
        log: makeConsoleMethod('log'),
        warn: makeConsoleMethod('warn'),
        error: makeConsoleMethod('error'),
      };

      // For deviceless automations we still pass a DeviceAPIImpl (created
      // above with bridgePort=0) so device-independent methods like
      // device.httpGet / device.sleep / device.getCredentials work. Device-
      // only methods throw a clear "requires device" error via callBridge.
      const apiForExecution = deviceAPI ?? { getExecutionLog: () => execLog } as any;
      // httpAPI was created earlier (step 6) so the proxy handler could be
      // wired before execute() runs.

      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Automation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      // Per-run AbortController — lets cancelRun(sessionId) kill the
      // V8 isolate mid-flight. Stored on the runner so the API endpoint
      // and AI tool can reach it.
      const abortController = new AbortController();
      this.activeRuns.set(sessionId, abortController);
      try {
        await Promise.race([
          this.compiler.execute(compiled.code, apiForExecution, {
            documentStore, console: automationConsole, tools: this.buildToolsProxy(), httpAPI,
          }, { signal: abortController.signal }),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timeoutHandle!);
        this.activeRuns.delete(sessionId);
      }

      // 8. Success — save execution log
      const executionLog = JSON.stringify(deviceAPI ? deviceAPI.getExecutionLog() : execLog);
      this.updateSession(sessionId, 'success', executionLog);
      this.broadcastSessionStatus(sessionId, 'success', automationId, deviceId, triggerType);
      this.hookBus?.emit('automation:completed', { sessionId, automationId, deviceId, success: true });
      log(`Automation "${automation.name}" (session ${sessionId}) completed successfully`);
      return { sessionId, success: true };
    } catch (err: any) {
      // 9. Failure — capture error screenshot and save execution log.
      // AbortError gets the dedicated 'cancelled' status so the UI can
      // distinguish user-requested stops from real failures.
      const errorMsg = err.message || 'Unknown error';
      const isCancelled = err?.name === 'AbortError';
      const finalStatus: 'cancelled' | 'failed' = isCancelled ? 'cancelled' : 'failed';
      if (isCancelled) {
        log(`Automation "${automation.name}" (session ${sessionId}) cancelled`);
      } else {
        error(`Automation "${automation.name}" (session ${sessionId}) failed: ${errorMsg}`);
      }
      const logEntries = deviceAPI ? deviceAPI.getExecutionLog() : [];

      // Try to capture a screenshot showing the device state at the time of error
      let errorScreenshot: string | undefined;
      if (deviceAPI && !isCancelled) {
        try {
          errorScreenshot = await deviceAPI.takeScreenshot('error');
        } catch { /* ignore screenshot failure */ }
      }

      logEntries.push({
        timestamp: new Date().toISOString(),
        method: isCancelled ? '__cancelled__' : '__error__',
        params: {},
        error: errorMsg,
        durationMs: 0,
        ...(errorScreenshot ? { screenshotFilename: errorScreenshot } : {}),
      });
      this.updateSession(sessionId, finalStatus, JSON.stringify(logEntries));
      this.broadcastSessionStatus(sessionId, finalStatus, automationId, deviceId, triggerType, errorMsg);
      this.hookBus?.emit('automation:completed', { sessionId, automationId, deviceId, success: false, error: errorMsg });
      return { sessionId, success: false, error: errorMsg };
    } finally {
      // Stop keep-alive timers
      if (busyKeepAlive) clearInterval(busyKeepAlive);
      if (screenKeepAlive) clearInterval(screenKeepAlive);
      // Clean up Frida sessions
      if (deviceAPI) {
        try {
          const fridaImpl = deviceAPI.frida as any;
          if (fridaImpl?.cleanup) await fridaImpl.cleanup();
        } catch (err: any) { error(`Failed to clean up Frida: ${err.message}`); }
      }
      // Clear any traffic hooks registered by this automation
      if (deviceId && this.trafficHookRegistry) {
        this.trafficHookRegistry.clearHooks(deviceId);
      }
      // Clean up session-scoped intercept rules and client certs
      try {
        this.db.delete(interceptRules).where(eq(interceptRules.sessionId, sessionId)).run();
        this.db.delete(clientCerts).where(eq(clientCerts.sessionId, sessionId)).run();
        syncInterceptConfig(this.db);
      } catch (err: any) {
        error(`Failed to clean up session-scoped intercept rules/certs: ${err.message}`);
      }
      // Re-enable bridge idle timeout so it gets cleaned up after automation
      if (bridge && bridge.isRunning()) {
        bridge.enableIdleTimeout();
      }
      // Release any proxy dispatcher sockets held by HttpAPI.
      try { await httpAPI?.dispose(); } catch { /* best-effort */ }
      // Disable ATX-free mode (restart ATX for live streaming).
      // Only matters when we actually attached to an Android device — the
      // matching enable at startup is gated on canCreateBridge && !isRule.
      // For deviceless / iOS runs there's nothing to undo.
      if (deviceAPI && !automation.isRule && bridge) {
        try { await deviceAPI.setATXFree(false); }
        catch (err: any) { error(`Failed to disable ATX-free mode: ${err.message}`); }
      }
      if (deviceId && tunnelActivated && this.deviceManager) {
        try { await this.deviceManager.deactivateWireGuardTunnel(deviceId); }
        catch (err: any) { error(`Failed to deactivate WireGuard tunnel: ${err.message}`); }
      }
      // Clean up mitmproxy — covers both requiresHttpsCapture and setProxy paths
      // Only stop capture if THIS automation started it (captureStarted flag); prevents
      // killing a user-initiated capture session that was already running before the automation.
      if (captureStarted && deviceId && this.mitmproxyManager?.isCapturing(deviceId)) {
        try { await this.mitmproxyManager.stopCapture(deviceId); }
        catch (err: any) { error(`Failed to stop HTTPS capture: ${err.message}`); }
      }
      // Also deactivate WireGuard if setProxy activated it (tunnelActivated only covers requiresHttpsCapture)
      if (deviceId && !tunnelActivated && this.deviceManager) {
        try { await this.deviceManager.deactivateWireGuardTunnel(deviceId); }
        catch (err: any) { /* tunnel may not have been activated by setProxy, ignore */ }
      }
      // Mark device as idle so standby timer can manage it again
      if (deviceId) {
        this.deviceManager?.markIdle(deviceId);
      }
      // Turn screen off after scheduled automations to save battery
      if (deviceId && triggerType === 'schedule' && this.deviceManager) {
        try { await this.deviceManager.executeShellCommand(deviceId, 'input keyevent KEYCODE_SLEEP'); }
        catch (err: any) { error(`Failed to turn screen off after scheduled automation: ${err.message}`); }
      }
    }

    } catch (outerErr: any) {
      // Something threw before the inner try/catch/finally could cover it
      // (e.g. session insert failed on a locked DB, or startCapture crashed).
      // The inner finally's markIdle hasn't run because we never reached the
      // inner try block — release the busy lock here so the device isn't
      // permanently stuck.
      if (busyAcquired && deviceId) {
        try { this.deviceManager?.markIdle(deviceId); }
        catch { /* best-effort — device may already be gone */ }
      }
      throw outerErr;
    }
  }

  // Rule system

  getRules(): Array<{
    id: number;
    name: string;
    code: string;
    priority: number | null;
  }> {
    return this.db
      .select({ id: automations.id, name: automations.name, code: automations.code, priority: automations.priority })
      .from(automations)
      .where(and(eq(automations.isRule, true), eq(automations.enabled, true)))
      .orderBy(asc(automations.priority))
      .all();
  }

  getCaptureRules(): Array<{
    id: number;
    name: string;
    code: string;
    priority: number | null;
  }> {
    return this.db
      .select({ id: automations.id, name: automations.name, code: automations.code, priority: automations.priority })
      .from(automations)
      .where(and(eq(automations.isCaptureRule, true), eq(automations.enabled, true)))
      .orderBy(asc(automations.priority))
      .all();
  }

  async runCaptureRules(deviceId: string, sessionId: number): Promise<void> {
    // Clear existing hooks and dispose any still-alive rule isolates from a
    // previous run — new rules replace them atomically.
    if (this.trafficHookRegistry) {
      this.trafficHookRegistry.clearHooks(deviceId);
    }
    this.disposeCaptureRuleIsolates(deviceId);

    const captureRules = this.getCaptureRules();
    if (captureRules.length === 0) return;

    log(`Running ${captureRules.length} capture rule(s) for device ${deviceId}`);

    let bridge: PythonBridge | null = null;
    try {
      // Detect device platform
      let rulePlatform: 'android' | 'ios' = 'android';
      const deviceRow = this.db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
      if (deviceRow?.platform === 'ios') {
        rulePlatform = 'ios';
      }

      if (rulePlatform === 'android') {
        bridge = await this.bridgeManager.getBridge(deviceId);
        bridge.disableIdleTimeout();
      }

      const deviceAPI = new DeviceAPIImpl(
        deviceId,
        bridge?.port ?? 0, // 0 is safe: iOS path never calls callBridge()
        sessionId,
        this.db,
        undefined,
        this.trafficHookRegistry,
        rulePlatform,
        this.iosDeviceManager,
      );
      const documentStore = new DocumentStore(this.db);

      for (const rule of captureRules) {
        try {
          const compiled = this.compiler.compileWithCache(rule.code, `capture-rule-${rule.id}`);
          if (compiled.diagnostics?.some((d) => d.category === 1)) {
            error(`Capture rule "${rule.name}" has compilation errors, skipping`);
            continue;
          }
          // Capture rules register traffic hooks whose callbacks fire AFTER
          // the rule's top-level code returns. The isolate must stay alive
          // for those callbacks to run, so we retain the dispose handle.
          const handle = await this.compiler.execute(
            compiled.code,
            deviceAPI,
            { documentStore, tools: this.buildToolsProxy() },
            { keepAlive: true },
          );
          const handles = this.captureRuleIsolates.get(deviceId) ?? [];
          handles.push(handle);
          this.captureRuleIsolates.set(deviceId, handles);
          log(`Capture rule "${rule.name}" executed successfully`);
        } catch (err: any) {
          error(`Capture rule "${rule.name}" failed: ${err.message}`);
        }
      }
    } catch (err: any) {
      error(`Failed to run capture rules: ${err.message}`);
    } finally {
      if (bridge && bridge.isRunning()) {
        bridge.enableIdleTimeout();
      }
    }
  }

  /**
   * Dispose every persistent capture-rule isolate for a device. Called when
   * capture stops or when rules are re-run. Safe to call when there are no
   * active isolates.
   */
  disposeCaptureRuleIsolates(deviceId: string): void {
    const handles = this.captureRuleIsolates.get(deviceId);
    if (!handles) return;
    for (const h of handles) {
      try { h.dispose(); } catch (err: any) {
        error(`Failed to dispose capture-rule isolate for ${deviceId}: ${err.message}`);
      }
    }
    this.captureRuleIsolates.delete(deviceId);
  }

  async runRules(deviceAPI: DeviceAPIImpl): Promise<void> {
    const did = deviceAPI.getDeviceId();
    // Non-recursive guard (per-device)
    if (this.runningRules.has(did)) return;
    this.runningRules.add(did);

    try {
      const rules = this.getRules();
      if (rules.length === 0) return;

      // Capture DOM once for all rules to avoid repeated dump_hierarchy calls
      const dom = await deviceAPI.getDOM();
      deviceAPI.setCachedDOM(dom);

      const documentStore = new DocumentStore(this.db);

      for (const rule of rules) {
        try {
          const compiled = this.compiler.compileWithCache(
            rule.code,
            `rule-${rule.id}`,
          );

          if (compiled.diagnostics?.some((d) => d.category === 1)) {
            error(`Rule "${rule.name}" has compilation errors, skipping`);
            continue;
          }

          await this.compiler.execute(compiled.code, deviceAPI, { documentStore, tools: this.buildToolsProxy() });
        } catch (err: any) {
          error(`Rule "${rule.name}" failed: ${err.message}`);
        }
      }
    } finally {
      deviceAPI.clearCachedDOM();
      this.runningRules.delete(did);
    }
  }

  /**
   * Create proxy and TLS profile handler closures that share state.
   */
  private createCaptureHandlers(deviceId: string, sessionId: number) {
    let currentTlsProfile: string = 'default';

    const proxyHandler = async (mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }) => {
      if (!this.mitmproxyManager || !this.deviceManager) {
        throw new Error('Proxy infrastructure not available');
      }

      if (mode === 'none') {
        // Tear down proxy if running
        if (this.mitmproxyManager.isCapturing(deviceId)) {
          await this.mitmproxyManager.stopCapture(deviceId);
          try { await this.deviceManager.deactivateWireGuardTunnel(deviceId); }
          catch { /* tunnel may not be active */ }
          log(`setProxy('none'): stopped proxy for ${deviceId}`);
        }
        return;
      }

      // Build mitmproxy options
      const mitmOptions: any = { sessionId, deviceId, tlsProfile: currentTlsProfile, interceptHooks: true };

      if (mode === 'nordvpn') {
        // Read NordVPN credentials from settings
        const usernameRow = this.db
          .select()
          .from(settings)
          .where(eq(settings.key, 'nordvpn_username'))
          .all()[0];
        const passwordRow = this.db
          .select()
          .from(settings)
          .where(eq(settings.key, 'nordvpn_password'))
          .all()[0];

        if (!usernameRow || !passwordRow) {
          throw new Error('NordVPN credentials not configured. Set them in Settings.');
        }

        mitmOptions.socks5Proxy = {
          host: `${options!.country}.socks.nordhold.net`,
          port: 1080,
          username: usernameRow.value,
          password: passwordRow.value,
        };
        mitmOptions.useProxy = false; // Skip normal proxy rotation
      } else {
        // mode === 'normal': use existing proxy rotation
        mitmOptions.useProxy = true;
      }

      if (this.mitmproxyManager.isCapturing(deviceId)) {
        // Restart with new config
        const tunnelInfo = await this.mitmproxyManager.restartCapture(deviceId, mitmOptions);
        if (tunnelInfo) {
          try {
            await this.deviceManager.activateWireGuardTunnel(deviceId, tunnelInfo);
          } catch (err: any) {
            log(`WireGuard reactivation failed: ${err.message}`);
          }
        }
      } else {
        // First time — full WireGuard + mitmproxy startup
        const tunnelInfo = await this.mitmproxyManager.startCapture(deviceId, mitmOptions);
        if (tunnelInfo) {
          try {
            await this.deviceManager.injectMitmproxyCaCert(deviceId);
            await this.deviceManager.activateWireGuardTunnel(deviceId, tunnelInfo);
            await this.waitForInterceptReady(deviceId, sessionId);
          } catch (err: any) {
            log(`WireGuard tunnel setup failed: ${err.message}`);
          }
        }
      }

      log(`setProxy('${mode}'${options?.country ? `, country=${options.country}` : ''}): configured for ${deviceId}`);
    };

    const tlsProfileHandler = async (profile: string) => {
      currentTlsProfile = profile;

      if (this.mitmproxyManager?.isCapturing(deviceId)) {
        const tunnelInfo = await this.mitmproxyManager.restartCapture(deviceId, {
          sessionId,
          deviceId,
          tlsProfile: profile,
          interceptHooks: true,
        });
        if (tunnelInfo && this.deviceManager) {
          try {
            await this.deviceManager.activateWireGuardTunnel(deviceId, tunnelInfo);
          } catch (err: any) {
            log(`WireGuard reactivation failed after TLS profile change: ${err.message}`);
          }
        }
        log(`setTlsProfile('${profile}'): restarted capture for ${deviceId}`);
      } else {
        log(`setTlsProfile('${profile}'): stored for next capture start on ${deviceId}`);
      }
    };

    return { proxyHandler, tlsProfileHandler, getTlsProfile: () => currentTlsProfile };
  }

  /**
   * Wait for tunnel connectivity by making a test HTTP request from the device.
   * Retries until curl succeeds, confirming the tunnel is routing traffic.
   */
  private async waitForInterceptReady(
    deviceId: string,
    _sessionId: number,
    maxAttempts: number = 5,
    intervalMs: number = 1000,
  ): Promise<boolean> {
    if (!this.deviceManager) return false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.deviceManager.testTunnelConnectivity(deviceId);
      if (result.success) {
        log(`Tunnel ready (attempt ${attempt}/${maxAttempts})`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return false;
  }

  private updateSession(
    sessionId: number,
    status: 'success' | 'failed' | 'cancelled',
    logs?: string,
  ): void {
    const updates: Record<string, any> = {
      status,
      completedAt: new Date(),
    };
    if (logs !== undefined) updates.logs = logs;

    this.db
      .update(automationSessions)
      .set(updates)
      .where(eq(automationSessions.id, sessionId))
      .run();
  }

  /**
   * Record a "this automation was queued but never got to run" outcome as a
   * regular failed automation_sessions row + broadcast + notification.
   *
   * Called by AutomationScheduler when a queued entry waits past its deadline
   * (default 5 min) without a matching available device. The operator then
   * sees it in the normal automation session history with the reason, instead
   * of having to inspect the live queue tab to notice things are stuck.
   */
  recordQueueTimeout(
    automationId: number,
    triggerType: TriggerType,
    errorMsg: string,
  ): void {
    const automation = this.db
      .select({ name: automations.name })
      .from(automations)
      .where(eq(automations.id, automationId))
      .all()[0];
    const name = automation?.name ?? `Automation #${automationId}`;
    const now = new Date();
    // If the automation row was deleted while the entry sat in the queue,
    // the FK from automation_sessions.automation_id would reject our insert
    // and the timeout would never get surfaced. Schema marks the column
    // nullable for exactly this case — fall back to null so the failed
    // session still shows up in history under its captured name.
    const automationIdForRow = automation ? automationId : null;

    const insertResult = this.db
      .insert(automationSessions)
      .values({
        automationId: automationIdForRow,
        deviceId: null,
        name,
        status: 'failed',
        triggerType,
        startedAt: now,
        completedAt: now,
        // The schema doesn't have a dedicated error column — runner uses `logs`
        // for both successful execution traces and failure reasons (see
        // updateSession()), so do the same here.
        logs: errorMsg,
      })
      .run();
    const sessionId = Number(insertResult.lastInsertRowid);

    error(`Automation "${name}" (session ${sessionId}) dropped from queue: ${errorMsg}`);

    // broadcastSessionStatus also fires the notificationService for failed
    // status, so operators get the same push/desktop notification as a
    // regular run failure — no separate notification path.
    this.broadcastSessionStatus(
      sessionId,
      'failed',
      automationIdForRow ?? undefined,
      undefined,
      triggerType,
      errorMsg,
    );
  }

  private broadcastSessionStatus(
    sessionId: number,
    status: 'running' | 'success' | 'failed' | 'cancelled',
    automationId?: number,
    deviceId?: string,
    triggerType?: TriggerType,
    errorMsg?: string,
  ): void {
    const message: SessionStatusUpdate = {
      type: 'session-status',
      sessionId,
      automationId,
      deviceId,
      status,
      triggerType,
      completedAt: status !== 'running' ? new Date().toISOString() : undefined,
    };
    broadcastToAll(message);

    // Emit notifications for terminal states
    if (this.notificationService && (status === 'success' || status === 'failed')) {
      const automationName = automationId
        ? this.db.select({ name: automations.name }).from(automations)
            .where(eq(automations.id, automationId)).all()[0]?.name || `#${automationId}`
        : `Session #${sessionId}`;

      this.notificationService.emit({
        type: status === 'success' ? 'automation:success' : 'automation:failure',
        title: status === 'success'
          ? `Automation "${automationName}" completed`
          : `Automation "${automationName}" failed`,
        body: status === 'failed' && errorMsg ? errorMsg : '',
        sourceType: 'automation',
        sourceId: String(sessionId),
        url: `/ui/automations/session/${sessionId}`,
      });
    }
  }
}
