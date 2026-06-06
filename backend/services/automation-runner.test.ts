import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { AutomationRunner } from './automation-runner';
import { AutomationCompiler } from './automation-compiler';
import { PythonBridgeManager } from './python-bridge';
import { TrafficHookRegistry } from './traffic-hook-registry';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

// Mock broadcastToAll
vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

describe('AutomationRunner', () => {
  let db: AppDatabase;
  let runner: AutomationRunner;
  let compiler: AutomationCompiler;
  let bridgeManager: PythonBridgeManager;

  beforeEach(() => {
    db = createTestDb();
    compiler = new AutomationCompiler();
    bridgeManager = new PythonBridgeManager(db);

    // Mock getBridge to return a fake bridge
    vi.spyOn(bridgeManager, 'getBridge').mockResolvedValue({
      deviceId: 'test-device',
      port: 9100,
      process: {} as any,
      isRunning: () => true,
      resetIdleTimer: vi.fn(),
      disableIdleTimeout: vi.fn(),
      enableIdleTimeout: vi.fn(),
      stop: vi.fn(),
    });

    runner = new AutomationRunner(db, bridgeManager, compiler);

    // Insert test device
    db.insert(schema.devices).values({
      id: 'test-device',
      name: 'Test Device',
    }).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAutomation(code: string, opts?: { isRule?: boolean; isCaptureRule?: boolean; priority?: number; timeoutMs?: number; requiresHttpsCapture?: boolean; enabled?: boolean; name?: string; managedBy?: string; managedKey?: string }) {
    const now = new Date();
    db.insert(schema.automations).values({
      name: opts?.name ?? 'Test Automation',
      code,
      passcode: 'test-pass',
      isRule: opts?.isRule ?? false,
      isCaptureRule: opts?.isCaptureRule ?? false,
      priority: opts?.priority ?? 0,
      timeoutMs: opts?.timeoutMs ?? 300000,
      requiresHttpsCapture: opts?.requiresHttpsCapture ?? false,
      enabled: opts?.enabled ?? true,
      managedBy: opts?.managedBy ?? null,
      managedKey: opts?.managedKey ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return db.select().from(schema.automations).all().pop()!;
  }

  describe('runAutomation', () => {
    it('creates session and runs automation successfully', async () => {
      const auto = createAutomation(`
        export default async function(device: any) {
          // Simple automation that does nothing
        }
      `);

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();

      // Check session was created and updated
      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId))
        .all()[0];
      expect(session.status).toBe('success');
      expect(session.completedAt).toBeDefined();
    });

    it('marks session as failed on compilation error', async () => {
      // TypeScript transpileModule doesn't normally produce errors for runtime issues,
      // but we can test the failure path by mocking the compiler
      const mockCompiler = new AutomationCompiler();
      vi.spyOn(mockCompiler, 'compileWithCache').mockReturnValue({
        code: '',
        diagnostics: [{
          category: 1, // Error
          messageText: 'Type error',
          code: 2322,
          file: undefined,
          start: undefined,
          length: undefined,
        } as any],
      });

      const failRunner = new AutomationRunner(db, bridgeManager, mockCompiler);
      const auto = createAutomation('invalid code');

      const result = await failRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Type error');

      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId))
        .all()[0];
      expect(session.status).toBe('failed');
    });

    it('marks session as failed when automation throws', async () => {
      const auto = createAutomation(`
        export default async function(device: any) {
          throw new Error('Something went wrong');
        }
      `);

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Something went wrong');
    });

    it('throws when automation not found', async () => {
      await expect(
        runner.runAutomation(9999, 'test-device', 'manual'),
      ).rejects.toThrow('Automation 9999 not found');
    });

    it('denormalises sessions.managed = true for a managed automation row', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { managedBy: 'plugin-x', managedKey: 'poller' },
      );
      const result = await runner.runAutomation(auto.id, 'test-device', 'schedule');
      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId)).all()[0];
      expect(session.managed).toBe(true);
    });

    it('denormalises sessions.managed = false for an ordinary automation row', async () => {
      const auto = createAutomation(`export default async function(d: any) { }`);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');
      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId)).all()[0];
      expect(session.managed).toBe(false);
    });

    it('handles timeout', async () => {
      const auto = createAutomation(
        `export default async function(device: any) {
          await new Promise(r => setTimeout(r, 60000));
        }`,
        { timeoutMs: 100 },
      );

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('skips rulesRunner for rule automations but still wakes screen', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { isRule: true },
      );

      // Spy on DeviceAPIImpl prototype to track calls
      const { DeviceAPIImpl } = await import('./device-api');
      const wakeAndUnlockSpy = vi.spyOn(DeviceAPIImpl.prototype, 'wakeAndUnlock').mockResolvedValue();
      const setRulesRunnerSpy = vi.spyOn(DeviceAPIImpl.prototype, 'setRulesRunner');

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(wakeAndUnlockSpy).toHaveBeenCalledOnce();
      expect(setRulesRunnerSpy).not.toHaveBeenCalled();
      wakeAndUnlockSpy.mockRestore();
      setRulesRunnerSpy.mockRestore();
    });

    it('calls wakeAndUnlock for non-rule automations', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { isRule: false },
      );

      const { DeviceAPIImpl } = await import('./device-api');
      const wakeAndUnlockSpy = vi.spyOn(DeviceAPIImpl.prototype, 'wakeAndUnlock').mockResolvedValue();

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(wakeAndUnlockSpy).toHaveBeenCalledOnce();
      wakeAndUnlockSpy.mockRestore();
    });

    it('enables ATX-free mode for non-rule automations and disables in cleanup', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { isRule: false },
      );

      const { DeviceAPIImpl } = await import('./device-api');
      const setATXFreeSpy = vi.spyOn(DeviceAPIImpl.prototype, 'setATXFree').mockResolvedValue();

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      // Called twice: enable (true) then disable (false)
      expect(setATXFreeSpy).toHaveBeenCalledTimes(2);
      expect(setATXFreeSpy.mock.calls[0][0]).toBe(true);
      expect(setATXFreeSpy.mock.calls[1][0]).toBe(false);
      setATXFreeSpy.mockRestore();
    });

    it('disables ATX-free in finally even on failure', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { throw new Error('fail'); }`,
        { isRule: false },
      );

      const { DeviceAPIImpl } = await import('./device-api');
      const setATXFreeSpy = vi.spyOn(DeviceAPIImpl.prototype, 'setATXFree').mockResolvedValue();

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      // Still called twice: enable + cleanup disable
      expect(setATXFreeSpy).toHaveBeenCalledTimes(2);
      expect(setATXFreeSpy.mock.calls[1][0]).toBe(false);
      setATXFreeSpy.mockRestore();
    });

    it('skips ATX-free for rule automations', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { isRule: true },
      );

      const { DeviceAPIImpl } = await import('./device-api');
      const setATXFreeSpy = vi.spyOn(DeviceAPIImpl.prototype, 'setATXFree').mockResolvedValue();

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(setATXFreeSpy).not.toHaveBeenCalled();
      setATXFreeSpy.mockRestore();
    });

    it('continues if setATXFree enable fails', async () => {
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { isRule: false },
      );

      const { DeviceAPIImpl } = await import('./device-api');
      const setATXFreeSpy = vi.spyOn(DeviceAPIImpl.prototype, 'setATXFree')
        .mockRejectedValueOnce(new Error('bridge unreachable'))
        .mockResolvedValueOnce(undefined); // cleanup call

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      // Automation should still succeed despite ATX-free setup failure
      expect(result.success).toBe(true);
      setATXFreeSpy.mockRestore();
    });

    it('records trigger type in session', async () => {
      const auto = createAutomation(`export default async function(d: any) { }`);

      const result = await runner.runAutomation(auto.id, 'test-device', 'schedule');

      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId))
        .all()[0];
      expect(session.triggerType).toBe('schedule');
    });

    it('turns screen off after scheduled automation', async () => {
      const mockDm = {
        tryAcquireBusy: vi.fn().mockReturnValue(true),
        markIdle: vi.fn(),
        refreshBusy: vi.fn(),
        executeShellCommand: vi.fn().mockResolvedValue(''),
        deactivateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      };
      const schedRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, mockDm as any);

      const auto = createAutomation(`export default async function(d: any) { }`);
      const result = await schedRunner.runAutomation(auto.id, 'test-device', 'schedule');

      expect(result.success).toBe(true);
      expect(mockDm.executeShellCommand).toHaveBeenCalledWith('test-device', 'input keyevent KEYCODE_SLEEP');
    });

    it('does not turn screen off after manual automation', async () => {
      const mockDm = {
        tryAcquireBusy: vi.fn().mockReturnValue(true),
        markIdle: vi.fn(),
        refreshBusy: vi.fn(),
        executeShellCommand: vi.fn().mockResolvedValue(''),
        deactivateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      };
      const manualRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, mockDm as any);

      const auto = createAutomation(`export default async function(d: any) { }`);
      const result = await manualRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(mockDm.executeShellCommand).not.toHaveBeenCalledWith('test-device', 'input keyevent KEYCODE_SLEEP');
    });

    it('marks device busy during automation and idle after', async () => {
      const mockDm = {
        tryAcquireBusy: vi.fn().mockReturnValue(true),
        markIdle: vi.fn(),
        refreshBusy: vi.fn(),
        executeShellCommand: vi.fn().mockResolvedValue(''),
        deactivateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      };
      const busyRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, mockDm as any);

      const auto = createAutomation(`export default async function(d: any) { }`);
      const result = await busyRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(mockDm.tryAcquireBusy).toHaveBeenCalledWith('test-device');
      expect(mockDm.markIdle).toHaveBeenCalledWith('test-device');
      // tryAcquireBusy called before markIdle
      expect(mockDm.tryAcquireBusy.mock.invocationCallOrder[0])
        .toBeLessThan(mockDm.markIdle.mock.invocationCallOrder[0]);
    });

    it('marks device idle even when automation fails', async () => {
      const mockDm = {
        tryAcquireBusy: vi.fn().mockReturnValue(true),
        markIdle: vi.fn(),
        refreshBusy: vi.fn(),
        executeShellCommand: vi.fn().mockResolvedValue(''),
        deactivateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      };
      const busyRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, mockDm as any);

      const auto = createAutomation(`export default async function(d: any) { throw new Error('boom'); }`);
      const result = await busyRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(mockDm.tryAcquireBusy).toHaveBeenCalledWith('test-device');
      expect(mockDm.markIdle).toHaveBeenCalledWith('test-device');
    });

    it('rejects if device is already busy', async () => {
      const mockDm = {
        tryAcquireBusy: vi.fn().mockReturnValue(false),
        markIdle: vi.fn(),
        refreshBusy: vi.fn(),
        executeShellCommand: vi.fn().mockResolvedValue(''),
        deactivateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      };
      const busyRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, mockDm as any);

      const auto = createAutomation(`export default async function(d: any) { }`);
      await expect(
        busyRunner.runAutomation(auto.id, 'test-device', 'manual'),
      ).rejects.toThrow('Device test-device is busy');

      expect(mockDm.markIdle).not.toHaveBeenCalled();
    });
  });

  describe('getRules', () => {
    it('returns rules ordered by priority', () => {
      createAutomation('export default async function(d: any) {}', { isRule: true, priority: 10 });
      createAutomation('export default async function(d: any) {}', { isRule: true, priority: 1 });
      createAutomation('export default async function(d: any) {}', { isRule: false, priority: 5 });

      const rules = runner.getRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].priority).toBe(1);
      expect(rules[1].priority).toBe(10);
    });

    it('returns empty array when no rules exist', () => {
      createAutomation('export default async function(d: any) {}', { isRule: false });

      const rules = runner.getRules();
      expect(rules).toHaveLength(0);
    });
  });

  describe('execution log persistence', () => {
    it('saves execution log to session on success', async () => {
      const auto = createAutomation(`
        export default async function(device: any) {
          // Simple automation
        }
      `);

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');
      expect(result.success).toBe(true);

      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId))
        .all()[0];
      expect(session.logs).toBeDefined();
      const logs = JSON.parse(session.logs!);
      expect(Array.isArray(logs)).toBe(true);
    });

    it('saves execution log with __error__ entry on failure', async () => {
      const auto = createAutomation(`
        export default async function(device: any) {
          throw new Error('Deliberate failure');
        }
      `);

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');
      expect(result.success).toBe(false);

      const session = db.select().from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, result.sessionId))
        .all()[0];
      expect(session.logs).toBeDefined();
      const logs = JSON.parse(session.logs!);
      expect(Array.isArray(logs)).toBe(true);
      const errorEntry = logs.find((e: any) => e.method === '__error__');
      expect(errorEntry).toBeDefined();
      expect(errorEntry.error).toContain('Deliberate failure');
    });
  });

  describe('HTTPS traffic capture', () => {
    const mockTunnelInfo = {
      clientPrivateKey: 'test-client-key',
      serverPublicKey: 'test-server-key',
      clientAddress: '10.0.0.2/32',
      serverEndpoint: '192.168.1.100:51820',
    };

    function createMockMitmproxyManager() {
      let capturing = false;
      return {
        startCapture: vi.fn().mockImplementation(async () => { capturing = true; return mockTunnelInfo; }),
        stopCapture: vi.fn().mockImplementation(async () => { capturing = false; }),
        isCapturing: vi.fn().mockImplementation(() => capturing),
        restartCapture: vi.fn().mockImplementation(async () => { return mockTunnelInfo; }),
        stopAll: vi.fn(),
      };
    }

    function createMockDeviceManager() {
      return {
        tryAcquireBusy: vi.fn().mockReturnValue(true),
        markBusy: vi.fn(),
        markIdle: vi.fn(),
        refreshBusy: vi.fn(),
        injectMitmproxyCaCert: vi.fn().mockResolvedValue(undefined),
        activateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
        deactivateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
        testTunnelConnectivity: vi.fn().mockResolvedValue({ success: true, details: 'ok' }),
      };
    }

    it('starts capture when requiresHttpsCapture is true', async () => {
      const mockMitm = createMockMitmproxyManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(mockMitm.startCapture).toHaveBeenCalledWith('test-device', {
        sessionId: result.sessionId,
        deviceId: 'test-device',
        interceptHooks: true,
      });
    });

    it('activates tunnel after startCapture when deviceManager is provided', async () => {
      const mockMitm = createMockMitmproxyManager();
      const mockDm = createMockDeviceManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any, mockDm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(mockMitm.startCapture).toHaveBeenCalled();
      expect(mockDm.activateWireGuardTunnel).toHaveBeenCalledWith('test-device', mockTunnelInfo);
    });

    it('deactivates tunnel before stopCapture in finally', async () => {
      const mockMitm = createMockMitmproxyManager();
      const mockDm = createMockDeviceManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any, mockDm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      // Deactivate should be called before stopCapture
      expect(mockDm.deactivateWireGuardTunnel).toHaveBeenCalledWith('test-device');
      expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');

      // Verify order: deactivate before stop
      const deactivateOrder = mockDm.deactivateWireGuardTunnel.mock.invocationCallOrder[0];
      const stopOrder = mockMitm.stopCapture.mock.invocationCallOrder[0];
      expect(deactivateOrder).toBeLessThan(stopOrder);
    });

    it('continues automation if tunnel activation fails', async () => {
      const mockMitm = createMockMitmproxyManager();
      const mockDm = createMockDeviceManager();
      mockDm.activateWireGuardTunnel.mockRejectedValue(new Error('tunnel failed'));
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any, mockDm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      // Automation should still succeed — tunnel failure is not fatal
      expect(result.success).toBe(true);
      expect(mockDm.activateWireGuardTunnel).toHaveBeenCalled();
    });

    it('stops capture in finally on success', async () => {
      const mockMitm = createMockMitmproxyManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');
    });

    it('stops capture in finally on failure', async () => {
      const mockMitm = createMockMitmproxyManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any);

      const auto = createAutomation(
        `export default async function(d: any) { throw new Error('fail'); }`,
        { requiresHttpsCapture: true },
      );

      const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');
    });

    it('stops capture in finally on timeout', async () => {
      const mockMitm = createMockMitmproxyManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any);

      const auto = createAutomation(
        `export default async function(d: any) { await new Promise(r => setTimeout(r, 60000)); }`,
        { requiresHttpsCapture: true, timeoutMs: 100 },
      );

      const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');
    });

    it('does not start capture when requiresHttpsCapture is false', async () => {
      const mockMitm = createMockMitmproxyManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: false },
      );

      await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(mockMitm.startCapture).not.toHaveBeenCalled();
      expect(mockMitm.stopCapture).not.toHaveBeenCalled();
    });

    it('does not start capture when no mitmproxyManager is provided', async () => {
      // Default runner has no mitmproxyManager
      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');
      expect(result.success).toBe(true);
      // No error thrown — just silently skips capture
    });

    it('passes interceptHooks=true in mitmproxy options', async () => {
      const mockMitm = createMockMitmproxyManager();
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
        { requiresHttpsCapture: true },
      );

      await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(mockMitm.startCapture).toHaveBeenCalled();
      const captureOptions = mockMitm.startCapture.mock.calls[0][1];
      expect(captureOptions.interceptHooks).toBe(true);
    });

    it('clears hooks in finally block', async () => {
      const registry = new TrafficHookRegistry();
      const clearSpy = vi.spyOn(registry, 'clearHooks');
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, undefined, registry);

      const auto = createAutomation(
        `export default async function(d: any) { }`,
      );

      await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

      expect(clearSpy).toHaveBeenCalledWith('test-device');
    });
  });

  describe('runRules', () => {
    const emptyDom = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
    };

    function createMockDevice(extra?: Record<string, any>) {
      return {
        getDeviceId: vi.fn().mockReturnValue('test-device'),
        getDOM: vi.fn().mockResolvedValue(emptyDom),
        setCachedDOM: vi.fn(),
        clearCachedDOM: vi.fn(),
        ...extra,
      } as any;
    }

    it('executes rules in priority order', async () => {
      const ruleOrder: number[] = [];
      createAutomation(`
        export default async function(d: any) {
          await d.trackRule(2);
        }
      `, { isRule: true, priority: 2 });

      createAutomation(`
        export default async function(d: any) {
          await d.trackRule(1);
        }
      `, { isRule: true, priority: 1 });

      const mockDevice = createMockDevice({ trackRule: vi.fn(async (n: number) => { ruleOrder.push(n); }) });
      await runner.runRules(mockDevice);

      expect(ruleOrder).toEqual([1, 2]);
    });

    it('captures DOM once and caches it for all rules', async () => {
      createAutomation(`
        export default async function(d: any) {}
      `, { isRule: true, priority: 1 });
      createAutomation(`
        export default async function(d: any) {}
      `, { isRule: true, priority: 2 });

      const mockDevice = createMockDevice();
      await runner.runRules(mockDevice);

      expect(mockDevice.getDOM).toHaveBeenCalledOnce();
      expect(mockDevice.setCachedDOM).toHaveBeenCalledWith(emptyDom);
      expect(mockDevice.clearCachedDOM).toHaveBeenCalledOnce();
    });

    it('clears cached DOM even when a rule throws', async () => {
      createAutomation(`
        export default async function(d: any) {
          throw new Error('Rule fails');
        }
      `, { isRule: true, priority: 1 });

      const mockDevice = createMockDevice();
      await runner.runRules(mockDevice);

      expect(mockDevice.clearCachedDOM).toHaveBeenCalledOnce();
    });

    it('does not recurse when running rules', async () => {
      let callCount = 0;
      createAutomation(`
        export default async function(d: any) {
          await d.trackCall();
        }
      `, { isRule: true, priority: 1 });

      const mockDevice = createMockDevice({ trackCall: vi.fn(async () => { callCount++; }) });

      // Simulate concurrent rule execution
      await Promise.all([
        runner.runRules(mockDevice),
        runner.runRules(mockDevice),
      ]);

      // Should only execute once due to non-recursive guard
      expect(callCount).toBe(1);
    });

    it('continues executing remaining rules if one fails', async () => {
      let rule2Ran = false;
      createAutomation(`
        export default async function(d: any) {
          throw new Error('Rule 1 fails');
        }
      `, { isRule: true, priority: 1 });

      createAutomation(`
        export default async function(d: any) {
          await d.trackRule2();
        }
      `, { isRule: true, priority: 2 });

      const mockDevice = createMockDevice({ trackRule2: vi.fn(async () => { rule2Ran = true; }) });
      await runner.runRules(mockDevice);

      expect(rule2Ran).toBe(true);
    });

    it('excludes disabled rules from getRules', () => {
      createAutomation('export default async function(d: any) {}', { isRule: true, priority: 1, enabled: true });
      createAutomation('export default async function(d: any) {}', { isRule: true, priority: 2, enabled: false });

      const rules = runner.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].priority).toBe(1);
    });
  });

  describe('getCaptureRules', () => {
    it('returns enabled capture rules ordered by priority', () => {
      createAutomation('export default async function(d: any) {}', { isCaptureRule: true, priority: 10, name: 'CR High' });
      createAutomation('export default async function(d: any) {}', { isCaptureRule: true, priority: 1, name: 'CR Low' });
      createAutomation('export default async function(d: any) {}', { isRule: true, priority: 5, name: 'Regular Rule' });
      createAutomation('export default async function(d: any) {}', { priority: 0, name: 'Regular Auto' });

      const captureRules = runner.getCaptureRules();
      expect(captureRules).toHaveLength(2);
      expect(captureRules[0].priority).toBe(1);
      expect(captureRules[1].priority).toBe(10);
    });

    it('excludes disabled capture rules', () => {
      createAutomation('export default async function(d: any) {}', { isCaptureRule: true, priority: 1, enabled: true });
      createAutomation('export default async function(d: any) {}', { isCaptureRule: true, priority: 2, enabled: false });

      const captureRules = runner.getCaptureRules();
      expect(captureRules).toHaveLength(1);
      expect(captureRules[0].priority).toBe(1);
    });

    it('returns empty array when no capture rules exist', () => {
      createAutomation('export default async function(d: any) {}', { isRule: true });
      createAutomation('export default async function(d: any) {}');

      const captureRules = runner.getCaptureRules();
      expect(captureRules).toHaveLength(0);
    });
  });

  describe('runCaptureRules', () => {
    it('executes capture rules', async () => {
      createAutomation(`
        export default async function(d: any) {
          d.__captureRule1 = true;
        }
      `, { isCaptureRule: true, priority: 1 });

      // Create a session for the run
      db.insert(schema.automationSessions).values({
        deviceId: 'test-device',
        status: 'running',
        triggerType: 'capture',
        startedAt: new Date(),
      }).run();
      const session = db.select().from(schema.automationSessions).all().pop()!;

      await runner.runCaptureRules('test-device', session.id);

      // The rule executed without error (DeviceAPIImpl constructor is called internally)
      // We can't easily check side effects on the internal DeviceAPI, but we verify no throw
    });

    it('clears hooks before executing capture rules', async () => {
      const registry = new TrafficHookRegistry();
      const clearSpy = vi.spyOn(registry, 'clearHooks');
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, undefined, registry);

      createAutomation(`
        export default async function(d: any) {}
      `, { isCaptureRule: true, priority: 1 });

      db.insert(schema.automationSessions).values({
        deviceId: 'test-device',
        status: 'running',
        triggerType: 'capture',
        startedAt: new Date(),
      }).run();
      const session = db.select().from(schema.automationSessions).all().pop()!;

      await captureRunner.runCaptureRules('test-device', session.id);

      expect(clearSpy).toHaveBeenCalledWith('test-device');
    });

    it('clears hooks even when no capture rules exist', async () => {
      const registry = new TrafficHookRegistry();
      const clearSpy = vi.spyOn(registry, 'clearHooks');
      const captureRunner = new AutomationRunner(db, bridgeManager, compiler, undefined, undefined, registry);

      await captureRunner.runCaptureRules('test-device', 1);

      expect(clearSpy).toHaveBeenCalledWith('test-device');
    });

    it('skips when no capture rules exist', async () => {
      createAutomation('export default async function(d: any) {}', { isRule: true });

      // Should return immediately without acquiring bridge
      await runner.runCaptureRules('test-device', 1);

      // getBridge should not have been called
      expect(bridgeManager.getBridge).not.toHaveBeenCalled();
    });

    it('continues if one capture rule fails', async () => {
      createAutomation(`
        export default async function(d: any) {
          throw new Error('fail');
        }
      `, { isCaptureRule: true, priority: 1, name: 'Failing CR' });

      createAutomation(`
        export default async function(d: any) {
          // second rule should still run
        }
      `, { isCaptureRule: true, priority: 2, name: 'Good CR' });

      db.insert(schema.automationSessions).values({
        deviceId: 'test-device',
        status: 'running',
        triggerType: 'capture',
        startedAt: new Date(),
      }).run();
      const session = db.select().from(schema.automationSessions).all().pop()!;

      // Should not throw
      await runner.runCaptureRules('test-device', session.id);
    });

    it('re-enables bridge idle timeout after execution', async () => {
      const mockBridge = {
        deviceId: 'test-device',
        port: 9100,
        process: {} as any,
        isRunning: () => true,
        resetIdleTimer: vi.fn(),
        disableIdleTimeout: vi.fn(),
        enableIdleTimeout: vi.fn(),
        stop: vi.fn(),
      };
      vi.spyOn(bridgeManager, 'getBridge').mockResolvedValue(mockBridge);

      createAutomation(`
        export default async function(d: any) {}
      `, { isCaptureRule: true, priority: 1 });

      db.insert(schema.automationSessions).values({
        deviceId: 'test-device',
        status: 'running',
        triggerType: 'capture',
        startedAt: new Date(),
      }).run();
      const session = db.select().from(schema.automationSessions).all().pop()!;

      await runner.runCaptureRules('test-device', session.id);

      expect(mockBridge.disableIdleTimeout).toHaveBeenCalled();
      expect(mockBridge.enableIdleTimeout).toHaveBeenCalled();
    });
  });

  describe('hookBus lifecycle hooks', () => {
    function makeBus() {
      return { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    }

    it('emits session:created and automation:started when automation begins', async () => {
      const bus = makeBus();
      runner.setHookBus(bus as any);

      const auto = createAutomation(`export default async function(d: any) {}`);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(bus.emit).toHaveBeenCalledWith('session:created', expect.objectContaining({
        sessionId: result.sessionId,
        deviceId: 'test-device',
        triggerType: 'manual',
      }));
      expect(bus.emit).toHaveBeenCalledWith('automation:started', expect.objectContaining({
        sessionId: result.sessionId,
        automationId: auto.id,
        deviceId: 'test-device',
        triggerType: 'manual',
      }));
    });

    it('emits automation:completed with success=true on successful run', async () => {
      const bus = makeBus();
      runner.setHookBus(bus as any);

      const auto = createAutomation(`export default async function(d: any) {}`);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(bus.emit).toHaveBeenCalledWith('automation:completed', {
        sessionId: result.sessionId,
        automationId: auto.id,
        deviceId: 'test-device',
        success: true,
      });
    });

    it('emits automation:completed with success=false on failure', async () => {
      const bus = makeBus();
      runner.setHookBus(bus as any);

      const auto = createAutomation(`
        export default async function(d: any) {
          throw new Error('intentional failure');
        }
      `);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(bus.emit).toHaveBeenCalledWith('automation:completed', {
        sessionId: result.sessionId,
        automationId: auto.id,
        deviceId: 'test-device',
        success: false,
        error: 'intentional failure',
      });
    });

    it('does not throw when no hookBus is wired', async () => {
      // No setHookBus — hookBus stays null, optional chaining guards all emits
      const auto = createAutomation(`export default async function(d: any) {}`);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');
      expect(result.success).toBe(true);
    });
  });
});
