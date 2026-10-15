import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { AutomationRunner } from './automation-runner';
import { AutomationCompiler } from './automation-compiler';
import { PythonBridgeManager } from './python-bridge';
import { TrafficHookRegistry } from './traffic-hook-registry';
import { AiToolRegistry } from './ai-tools';
import { recordAuthor, clearAuthor } from './automation-authors';
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

  let userCount = 0;

  function addUser(scopes: string[], enabled = true) {
    const now = new Date();
    db.insert(schema.users).values({
      username: `author${++userCount}`, providerId: 'core.local', scopes, enabled, createdAt: now, updatedAt: now,
    }).run();
    return db.select().from(schema.users).all().pop()!;
  }

  function author(automationId: number, userScopes: string[], snapshot: string[], enabled = true) {
    const user = addUser(userScopes, enabled);
    recordAuthor(db, automationId, { userId: user.id, effectiveScopes: new Set(snapshot) });
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

    it('suppresses automation:failure notification for a managed run that did not opt in', async () => {
      const emit = vi.fn();
      runner.setNotificationService({ emit } as any);
      const auto = createAutomation(
        `export default async function(d: any) { throw new Error("boom"); }`,
        { managedBy: 'plugin-x', managedKey: 'poller' },
      );
      await runner.runAutomation(auto.id, 'test-device', 'manual');
      const failureEmits = emit.mock.calls.filter(
        ([ev]) => ev?.type === 'automation:failure',
      );
      expect(failureEmits).toHaveLength(0);
    });

    it('still fires automation:failure for a managed run that DID opt in', async () => {
      const emit = vi.fn();
      runner.setNotificationService({ emit } as any);
      const auto = createAutomation(
        `export default async function(d: any) { throw new Error("boom"); }`,
        { managedBy: 'plugin-x', managedKey: 'poller' },
      );
      // Flip the opt-in column directly (mirrors what reconcile would do
      // when the def's emitFailureNotification is true).
      db.update(schema.automations).set({ emitFailureNotification: true })
        .where(eq(schema.automations.id, auto.id)).run();

      await runner.runAutomation(auto.id, 'test-device', 'manual');
      const failureEmits = emit.mock.calls.filter(
        ([ev]) => ev?.type === 'automation:failure',
      );
      expect(failureEmits).toHaveLength(1);
    });

    it('always fires automation:failure for ORDINARY (non-managed) runs (regression)', async () => {
      const emit = vi.fn();
      runner.setNotificationService({ emit } as any);
      const auto = createAutomation(
        `export default async function(d: any) { throw new Error("boom"); }`,
      );
      await runner.runAutomation(auto.id, 'test-device', 'manual');
      const failureEmits = emit.mock.calls.filter(
        ([ev]) => ev?.type === 'automation:failure',
      );
      expect(failureEmits).toHaveLength(1);
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

  describe('tools access from scripts', () => {
    const SHELL = 'core.devices:shell';
    const script = `
      declare const tools: any;
      export default async function(device: any) {
        await tools.needs_shell({ x: 1 });
      }
    `;
    let shellTool: ReturnType<typeof vi.fn>;
    let openTool: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      shellTool = vi.fn(async () => ({ ok: true }));
      openTool = vi.fn(async () => ({ ok: true }));
      const registry = new AiToolRegistry();
      registry.register({ name: 'needs_shell', description: 'd', inputSchema: { type: 'object', properties: {} }, context: ['x'], requiredScope: SHELL, execute: shellTool });
      registry.register({ name: 'open_tool', description: 'd', inputSchema: { type: 'object', properties: {} }, context: ['x'], execute: openTool });
      runner.setToolRegistry(registry);
    });

    it('refuses a script nobody has claimed, without running the tool', async () => {
      const auto = createAutomation(script);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no author on record/i);
      expect(shellTool).not.toHaveBeenCalled();
    });

    it('runs the tool when the saving credential and the author both hold the scope', async () => {
      const auto = createAutomation(script);
      author(auto.id, [SHELL], [SHELL]);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(shellTool).toHaveBeenCalledWith({ x: 1 });
    });

    it('accepts a wildcard grant on either side', async () => {
      const auto = createAutomation(script);
      author(auto.id, ['core.devices:*'], ['core.devices:*']);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(shellTool).toHaveBeenCalled();
    });

    it('refuses when the author no longer holds the scope, even though the saved snapshot did', async () => {
      const auto = createAutomation(script);
      author(auto.id, ['core.apk:read'], [SHELL]);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient scope: core.devices:shell required for tool needs_shell');
      expect(shellTool).not.toHaveBeenCalled();
    });

    it('refuses when the author holds the scope but the key that saved the script did not', async () => {
      const auto = createAutomation(script);
      author(auto.id, [SHELL], ['core.automations:edit']);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient scope: core.devices:shell required for tool needs_shell');
      expect(shellTool).not.toHaveBeenCalled();
    });

    it('refuses when the author\'s account is disabled', async () => {
      const auto = createAutomation(script);
      author(auto.id, [SHELL], [SHELL], false);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disabled/i);
      expect(shellTool).not.toHaveBeenCalled();
    });

    it('lets the script catch the refusal and carry on', async () => {
      const auto = createAutomation(`
        declare const tools: any;
        export default async function(device: any) {
          try { await tools.needs_shell({}); } catch (e) { await tools.open_tool({ after: 'refusal' }); }
        }
      `);
      author(auto.id, ['core.apk:read'], ['core.apk:read']);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(shellTool).not.toHaveBeenCalled();
      expect(openTool).toHaveBeenCalledWith({ after: 'refusal' });
    });

    it('still needs an author for a tool that asks for no scope', async () => {
      const auto = createAutomation(`
        declare const tools: any;
        export default async function(device: any) { await tools.open_tool({}); }
      `);
      expect((await runner.runAutomation(auto.id, 'test-device', 'manual')).success).toBe(false);
      expect(openTool).not.toHaveBeenCalled();

      author(auto.id, [], []);
      expect((await runner.runAutomation(auto.id, 'test-device', 'manual')).success).toBe(true);
      expect(openTool).toHaveBeenCalled();
    });

    // The reconciler keeps a managed script's code equal to the default the plugin ships.
    function createManaged(code: string) {
      const auto = createAutomation(code, { managedBy: 'some-plugin', managedKey: 'k' });
      db.update(schema.automations).set({ currentDefaultCode: code }).where(eq(schema.automations.id, auto.id)).run();
      return auto;
    }

    it('trusts a plugin-managed script that the operator has not overridden', async () => {
      const auto = createManaged(script);
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(true);
      expect(shellTool).toHaveBeenCalled();
    });

    it('stops trusting a managed script whose code was rewritten without the override flag', async () => {
      const auto = createManaged(script);
      db.update(schema.automations).set({ code: script.replace('x: 1', 'x: 2') }).where(eq(schema.automations.id, auto.id)).run();
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no author on record/i);
      expect(shellTool).not.toHaveBeenCalled();
    });

    it('stops trusting a managed script once the operator overrides it', async () => {
      const auto = createManaged(script);
      db.update(schema.automations).set({ isOverridden: true }).where(eq(schema.automations.id, auto.id)).run();
      const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

      expect(result.success).toBe(false);
      expect(shellTool).not.toHaveBeenCalled();
    });

    describe('when the script is saved while a run is in flight', () => {
      // The proxy is built when a run starts and used for the whole run.
      const proxyFor = (id: number) => (runner as any).buildToolsProxy(id) as Record<string, (p: any) => Promise<any>>;

      it('refuses further calls once someone else has saved the script, so old code never inherits their authority', async () => {
        const auto = createAutomation(script);
        author(auto.id, ['core.apk:read'], ['core.apk:read']);
        const proxy = proxyFor(auto.id);

        author(auto.id, [SHELL], [SHELL]);

        await expect(proxy.needs_shell({})).rejects.toThrow(/saved by someone else while it was running/i);
        expect(shellTool).not.toHaveBeenCalled();
      });

      it('refuses further calls once the author was removed mid-run', async () => {
        const auto = createAutomation(script);
        author(auto.id, [SHELL], [SHELL]);
        const proxy = proxyFor(auto.id);

        clearAuthor(db, auto.id);

        await expect(proxy.needs_shell({})).rejects.toThrow();
        expect(shellTool).not.toHaveBeenCalled();
      });

      it('keeps working when the same person saves it again', async () => {
        const auto = createAutomation(script);
        const user = addUser([SHELL]);
        recordAuthor(db, auto.id, { userId: user.id, effectiveScopes: new Set([SHELL]) });
        const proxy = proxyFor(auto.id);

        recordAuthor(db, auto.id, { userId: user.id, effectiveScopes: new Set([SHELL]) });

        await expect(proxy.needs_shell({ x: 1 })).resolves.toEqual({ ok: true });
      });
    });

    it('applies the same check to rules', async () => {
      const rule = createAutomation(script, { isRule: true });
      const device = {
        getDeviceId: vi.fn().mockReturnValue('test-device'),
        getDOM: vi.fn().mockResolvedValue({ className: 'FrameLayout', text: '', resourceId: '', description: '', bounds: [0, 0, 1, 1], clickable: false, enabled: true, children: [] }),
        setCachedDOM: vi.fn(),
        clearCachedDOM: vi.fn(),
      } as any;

      await runner.runRules(device);
      expect(shellTool).not.toHaveBeenCalled();

      author(rule.id, [SHELL], [SHELL]);
      await runner.runRules(device);
      expect(shellTool).toHaveBeenCalledTimes(1);
    });

    it('applies the same check to capture rules', async () => {
      const rule = createAutomation(script, { isCaptureRule: true });
      db.insert(schema.automationSessions).values({ deviceId: 'test-device', status: 'running', triggerType: 'capture', startedAt: new Date() }).run();
      const session = db.select().from(schema.automationSessions).all().pop()!;

      await runner.runCaptureRules('test-device', session.id);
      expect(shellTool).not.toHaveBeenCalled();

      author(rule.id, [SHELL], [SHELL]);
      await runner.runCaptureRules('test-device', session.id);
      expect(shellTool).toHaveBeenCalledTimes(1);
    });

    it('does not apply the unattended restriction to scripts', async () => {
      const registry = new AiToolRegistry();
      const execute = vi.fn(async () => ({ ok: true }));
      registry.register({ name: 'needs_shell', description: 'd', inputSchema: { type: 'object', properties: {} }, context: ['x'], requiredScope: SHELL, allowUnattended: false, execute });
      runner.setToolRegistry(registry);
      const auto = createAutomation(script);
      author(auto.id, [SHELL], [SHELL]);

      const result = await runner.runAutomation(auto.id, 'test-device', 'schedule');
      expect(result.success).toBe(true);
      expect(execute).toHaveBeenCalled();
    });
  });

  describe('device API access from scripts', () => {
    const CREDENTIALS = 'core.credentials:read';
    const PROXIES = 'core.proxies:manage';
    const credentialScript = `
      export default async function(device: any) {
        const c = await device.getCredentials('com.example');
        if (c.password !== 's3cret') throw new Error('wrong credential');
      }
    `;
    const deviceProxyScript = `export default async function(device: any) { await device.setProxy('none'); }`;
    const httpProxyScript = `declare const http: any; export default async function(device: any) { await http.setProxy('none'); }`;
    const deviceless = (code: string) => {
      const auto = createAutomation(code);
      db.update(schema.automations).set({ requiresDevice: false }).where(eq(schema.automations.id, auto.id)).run();
      return auto;
    };

    function addCredential() {
      const now = new Date();
      db.insert(schema.credentials).values({ appId: 'com.example', username: 'alice', password: 's3cret', createdAt: now, updatedAt: now }).run();
    }
    const credentialLastUsed = () => db.select().from(schema.credentials).all()[0].lastUsedAt;

    beforeEach(() => addCredential());

    describe('getCredentials', () => {
      it('refuses a script nobody has claimed, without reading the credential', async () => {
        const auto = createAutomation(credentialScript);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no author on record/i);
        expect(credentialLastUsed()).toBeNull();
      });

      it('refuses when the author does not hold the credentials scope', async () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, ['core.automations:edit'], ['core.automations:edit']);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Insufficient scope: core.credentials:read required for device.getCredentials');
        expect(credentialLastUsed()).toBeNull();
      });

      it('refuses when the author holds the scope now but the key that saved the script did not', async () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, [CREDENTIALS], ['core.automations:edit']);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Insufficient scope: core.credentials:read');
      });

      it('refuses when the author lost the scope after saving', async () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, [], [CREDENTIALS]);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Insufficient scope: core.credentials:read');
      });

      it('refuses when the author\'s account is disabled', async () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, [CREDENTIALS], [CREDENTIALS], false);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/disabled/i);
      });

      it('returns the credential to a script whose author holds the scope', async () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, [CREDENTIALS], [CREDENTIALS]);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(credentialLastUsed()).not.toBeNull();
      });

      it('keeps working for a script saved by an administrator', async () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, ['core.admin:*'], ['core.admin:*']);
        expect((await runner.runAutomation(auto.id, 'test-device', 'manual')).success).toBe(true);
      });

      it('lets the script catch the refusal and carry on', async () => {
        const auto = createAutomation(`
          export default async function(device: any) {
            try { await device.getCredentials('com.example'); } catch (e: any) { if (!/Insufficient scope/.test(e.message)) throw e; }
          }
        `);
        author(auto.id, [], []);
        expect((await runner.runAutomation(auto.id, 'test-device', 'manual')).success).toBe(true);
        expect(credentialLastUsed()).toBeNull();
      });

      it('trusts a plugin-managed script the operator has not changed', async () => {
        const auto = createAutomation(credentialScript, { managedBy: 'some-plugin', managedKey: 'k' });
        db.update(schema.automations).set({ currentDefaultCode: credentialScript }).where(eq(schema.automations.id, auto.id)).run();

        expect((await runner.runAutomation(auto.id, 'test-device', 'manual')).success).toBe(true);
      });
    });

    describe('setProxy', () => {
      it('refuses device.setProxy for a script nobody has claimed', async () => {
        const auto = createAutomation(deviceProxyScript);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no author on record/i);
      });

      it('refuses device.setProxy when the author does not hold the proxies scope', async () => {
        const auto = createAutomation(deviceProxyScript);
        author(auto.id, ['core.automations:edit'], ['core.automations:edit']);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Insufficient scope: core.proxies:manage required for device.setProxy');
      });

      it('lets device.setProxy through when the author holds the proxies scope', async () => {
        const auto = createAutomation(deviceProxyScript);
        author(auto.id, [PROXIES], [PROXIES]);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
      });

      it('refuses http.setProxy for a script nobody has claimed', async () => {
        const auto = deviceless(httpProxyScript);
        const result = await runner.runAutomation(auto.id, undefined, 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no author on record/i);
      });

      it('refuses http.setProxy when the author does not hold the proxies scope', async () => {
        const auto = deviceless(httpProxyScript);
        author(auto.id, ['core.automations:edit'], ['core.automations:edit']);
        const result = await runner.runAutomation(auto.id, undefined, 'manual');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Insufficient scope: core.proxies:manage required for http.setProxy');
      });

      it('lets http.setProxy through when the author holds the proxies scope', async () => {
        const auto = deviceless(httpProxyScript);
        author(auto.id, [PROXIES], [PROXIES]);
        const result = await runner.runAutomation(auto.id, undefined, 'manual');

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
      });
    });

    describe('outbound HTTP', () => {
      it('stays open to a script nobody has claimed, because it is what automations are for', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'));
        const auto = createAutomation(`
          declare const http: any;
          export default async function(device: any) {
            await device.httpGet('https://example.test/a');
            await device.httpPost('https://example.test/b', { x: 1 });
            await http.get('https://example.test/c');
            await http.post('https://example.test/d', { x: 1 });
          }
        `);
        const result = await runner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        // The runner makes its own requests to the device bridge; only the script's count here.
        const scriptCalls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('https://example.test'));
        expect(scriptCalls).toHaveLength(4);
      });
    });

    describe('ordinary device calls', () => {
      it('do not need an author', async () => {
        const auto = createAutomation(`export default async function(device: any) { await device.sleep(1); }`);
        expect((await runner.runAutomation(auto.id, 'test-device', 'manual')).success).toBe(true);
      });
    });

    describe('when the script is saved while a run is in flight', () => {
      const gateFor = (id: number) => (runner as any).buildHostGate(id) as (target: string, method: string) => void;

      it('refuses further gated calls once someone else has saved the script', () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, [CREDENTIALS], [CREDENTIALS]);
        const gate = gateFor(auto.id);

        author(auto.id, ['core.admin:*'], ['core.admin:*']);

        expect(() => gate('device', 'getCredentials')).toThrow(/saved by someone else while it was running/i);
      });

      it('refuses further gated calls once the author was removed mid-run', () => {
        const auto = createAutomation(credentialScript);
        author(auto.id, [CREDENTIALS], [CREDENTIALS]);
        const gate = gateFor(auto.id);

        clearAuthor(db, auto.id);

        expect(() => gate('device', 'getCredentials')).toThrow();
      });

      it('keeps working when the same person saves it again', () => {
        const auto = createAutomation(credentialScript);
        const user = addUser([CREDENTIALS]);
        recordAuthor(db, auto.id, { userId: user.id, effectiveScopes: new Set([CREDENTIALS]) });
        const gate = gateFor(auto.id);

        recordAuthor(db, auto.id, { userId: user.id, effectiveScopes: new Set([CREDENTIALS]) });

        expect(() => gate('device', 'getCredentials')).not.toThrow();
      });

      it('does not look anything up for a call that needs no scope', () => {
        const auto = createAutomation(credentialScript);
        const gate = gateFor(auto.id);

        clearAuthor(db, auto.id);

        expect(() => gate('device', 'click')).not.toThrow();
        expect(() => gate('device', 'httpGet')).not.toThrow();
      });
    });

    it('applies the same check to rules', async () => {
      const rule = createAutomation(credentialScript, { isRule: true });
      const device = {
        getDeviceId: vi.fn().mockReturnValue('test-device'),
        getDOM: vi.fn().mockResolvedValue({ className: 'FrameLayout', text: '', resourceId: '', description: '', bounds: [0, 0, 1, 1], clickable: false, enabled: true, children: [] }),
        setCachedDOM: vi.fn(),
        clearCachedDOM: vi.fn(),
        getCredentials: vi.fn(),
      } as any;

      await runner.runRules(device);
      expect(device.getCredentials).not.toHaveBeenCalled();

      author(rule.id, [CREDENTIALS], [CREDENTIALS]);
      await runner.runRules(device);
      expect(device.getCredentials).toHaveBeenCalledTimes(1);
    });

    it('applies the same check to capture rules', async () => {
      const rule = createAutomation(credentialScript, { isCaptureRule: true });
      db.insert(schema.automationSessions).values({ deviceId: 'test-device', status: 'running', triggerType: 'capture', startedAt: new Date() }).run();
      const session = db.select().from(schema.automationSessions).all().pop()!;

      await runner.runCaptureRules('test-device', session.id);
      expect(credentialLastUsed()).toBeNull();

      author(rule.id, [CREDENTIALS], [CREDENTIALS]);
      await runner.runCaptureRules('test-device', session.id);
      expect(credentialLastUsed()).not.toBeNull();
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

    // Captures started by the script itself via device.setProxy() (issue #69).
    // requiresHttpsCapture is false in all of these, so the only capture on
    // the device is the one the script's proxyHandler started.
    describe('script-started capture (device.setProxy)', () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // setProxy needs an author who holds the proxies scope.
      function createAdminScript(code: string, opts?: Parameters<typeof createAutomation>[1]) {
        const auto = createAutomation(code, opts);
        author(auto.id, ['core.admin:*'], ['core.admin:*']);
        return auto;
      }

      function setup() {
        const mockMitm = createMockMitmproxyManager();
        const mockDm = createMockDeviceManager();
        const captureRunner = new AutomationRunner(db, bridgeManager, compiler, mockMitm as any, mockDm as any);
        return { mockMitm, mockDm, captureRunner };
      }

      it('stops the capture when the script throws after setProxy', async () => {
        const { mockMitm, mockDm, captureRunner } = setup();
        const auto = createAdminScript(`
          export default async function(d: any) {
            await d.setProxy('normal');
            throw new Error('script failed mid-capture');
          }
        `);

        const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(mockMitm.startCapture).toHaveBeenCalledTimes(1);
        expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');
        expect(mockMitm.isCapturing('test-device')).toBe(false);
        expect(mockDm.markIdle).toHaveBeenCalledWith('test-device');
      });

      it('deactivates the tunnel before stopping a script-started capture', async () => {
        const { mockMitm, mockDm, captureRunner } = setup();
        const auto = createAdminScript(`
          export default async function(d: any) {
            await d.setProxy('normal');
            throw new Error('boom');
          }
        `);

        await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

        const deactivateOrders = mockDm.deactivateWireGuardTunnel.mock.invocationCallOrder;
        const stopOrder = mockMitm.stopCapture.mock.invocationCallOrder[0];
        expect(stopOrder).toBeDefined();
        expect(Math.min(...deactivateOrders)).toBeLessThan(stopOrder);
      });

      it('stops the capture when the script times out after setProxy', async () => {
        const { mockMitm, captureRunner } = setup();
        const auto = createAdminScript(`
          export default async function(d: any) {
            await d.setProxy('normal');
            await new Promise(r => setTimeout(r, 60000));
          }
        `, { timeoutMs: 200 });

        const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(false);
        expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');
        expect(mockMitm.isCapturing('test-device')).toBe(false);
      });

      it('stops the capture when the run is cancelled after setProxy', async () => {
        const { mockMitm, captureRunner } = setup();
        const auto = createAdminScript(`
          export default async function(d: any) {
            await d.setProxy('normal');
            await new Promise(r => setTimeout(r, 60000));
          }
        `);

        const runPromise = captureRunner.runAutomation(auto.id, 'test-device', 'manual');
        await vi.waitFor(() => expect(mockMitm.isCapturing('test-device')).toBe(true));
        const [sessionId] = captureRunner.getActiveRunSessionIds();
        expect(captureRunner.cancelRun(sessionId)).toBe(true);
        const result = await runPromise;

        expect(result.success).toBe(false);
        const session = db.select().from(schema.automationSessions)
          .where(eq(schema.automationSessions.id, result.sessionId)).all()[0];
        expect(session.status).toBe('cancelled');
        expect(mockMitm.stopCapture).toHaveBeenCalledWith('test-device');
        expect(mockMitm.isCapturing('test-device')).toBe(false);
      });

      it('does not stop again when the script already called setProxy("none")', async () => {
        const { mockMitm, captureRunner } = setup();
        const auto = createAdminScript(`
          export default async function(d: any) {
            await d.setProxy('normal');
            await d.setProxy('none');
          }
        `);

        const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');

        expect(result.success).toBe(true);
        expect(mockMitm.stopCapture).toHaveBeenCalledTimes(1);
      });

      it('kills a timed-out script so it cannot start a capture after cleanup', async () => {
        const { mockMitm, captureRunner } = setup();
        const auto = createAdminScript(`
          export default async function(d: any) {
            await new Promise(r => setTimeout(r, 400));
            await d.setProxy('normal');
          }
        `, { timeoutMs: 100 });

        const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');
        expect(result.success).toBe(false);
        const session = db.select().from(schema.automationSessions)
          .where(eq(schema.automationSessions.id, result.sessionId)).all()[0];
        expect(session.status).toBe('failed');
        expect(session.logs).toContain('timed out');

        // Give a surviving isolate time to wake up and call setProxy.
        await sleep(600);
        expect(mockMitm.startCapture).not.toHaveBeenCalled();
        expect(mockMitm.isCapturing('test-device')).toBe(false);
      });

      it('tears down a capture whose startup was still in flight when the run ended', async () => {
        const { mockMitm, mockDm, captureRunner } = setup();
        // startCapture takes longer than the automation timeout, so the
        // runner's cleanup runs before mitmproxy reports it is capturing.
        let capturing = false;
        mockMitm.isCapturing.mockImplementation(() => capturing);
        mockMitm.stopCapture.mockImplementation(async () => { capturing = false; });
        mockMitm.startCapture.mockImplementation(async () => {
          await sleep(400);
          capturing = true;
          return mockTunnelInfo;
        });
        const auto = createAdminScript(`
          export default async function(d: any) {
            await d.setProxy('normal');
          }
        `, { timeoutMs: 100 });

        const result = await captureRunner.runAutomation(auto.id, 'test-device', 'manual');
        expect(result.success).toBe(false);

        await vi.waitFor(() => expect(mockMitm.startCapture).toHaveBeenCalled());
        await sleep(600);
        expect(mockMitm.isCapturing('test-device')).toBe(false);
        expect(mockDm.activateWireGuardTunnel).not.toHaveBeenCalled();
      });
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
