import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { CaptureSessionManager } from './capture-session-manager';
import { createCaptureModeRegistry } from './capture-mode-registry';
import { makeCaptureHandlers } from './capture-handlers';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

/**
 * Wire the real capture-mode handlers onto a manager using the test mocks.
 * The handlers are the behavior-preserving extraction of the old inline
 * branch, so they call the same mockMitm / mockDm methods in the same order —
 * every existing assertion on those calls still holds. waitForTunnelReady is
 * the manager's own method (which drives mockDm.testTunnelConnectivity), so the
 * connectivity-retry timing tests are preserved.
 */
function wireRegistry(
  manager: CaptureSessionManager,
  mockMitm: ReturnType<typeof createMockMitmproxyManager>,
  mockDm: ReturnType<typeof createMockDeviceManager>,
): CaptureSessionManager {
  const registry = createCaptureModeRegistry();
  const handlers = makeCaptureHandlers({
    mitmproxyManager: mockMitm as any,
    deviceManager: mockDm as any,
    spawnContainerHttpForwarder: vi.fn().mockResolvedValue(undefined) as any,
    getActiveDockerClient: () => null,
    lookupRuntimeId: () => undefined,
    waitForTunnelReady: (serial: string) => manager.waitForTunnelReady(serial),
  });
  registry.register('wireguard', handlers.wireguard);
  registry.register('emu-http-proxy', handlers['emu-http-proxy']);
  registry.register('ios-bridge', handlers['ios-bridge']);
  manager.setCaptureModeRegistry(registry);
  return manager;
}

// Mock broadcastToAll
const mockBroadcastToAll = vi.fn();
vi.mock('../websocket/index', () => ({
  broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
}));

function createMockMitmproxyManager() {
  const capturing = new Set<string>();
  const mock = {
    startCapture: vi.fn().mockImplementation((deviceId: string) => {
      capturing.add(deviceId);
      return Promise.resolve({
        clientPrivateKey: 'test-client-key',
        serverPublicKey: 'test-server-key',
        clientAddress: '10.0.0.2/32',
        serverEndpoint: '192.168.1.100:51820',
      });
    }),
    stopCapture: vi.fn().mockImplementation((deviceId: string) => {
      capturing.delete(deviceId);
      return Promise.resolve(undefined);
    }),
    isCapturing: vi.fn().mockImplementation((deviceId: string) => capturing.has(deviceId)),
    stopAll: vi.fn(),
  };
  return mock;
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
    testTunnelConnectivity: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('CaptureSessionManager', () => {
  let db: AppDatabase;
  let mockMitm: ReturnType<typeof createMockMitmproxyManager>;
  let mockDm: ReturnType<typeof createMockDeviceManager>;
  let manager: CaptureSessionManager;

  beforeEach(() => {
    db = createTestDb();
    mockMitm = createMockMitmproxyManager();
    mockDm = createMockDeviceManager();
    manager = wireRegistry(new CaptureSessionManager(db, mockMitm as any, mockDm as any), mockMitm, mockDm);
    mockBroadcastToAll.mockClear();

    // Seed a device
    db.insert(schema.devices).values({ id: 'DEV001', name: 'Test Device', isRooted: true }).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('startCapture', () => {
    it('should start capture and create session', async () => {
      const result = await manager.startCapture('DEV001');

      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe('number');

      // Session row should exist
      const sessions = db.select().from(schema.automationSessions).all();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].deviceId).toBe('DEV001');
      expect(sessions[0].status).toBe('running');
      expect(sessions[0].triggerType).toBe('capture');
      expect(sessions[0].automationId).toBeNull();
    });

    it('should call mitmproxyManager.startCapture with correct params', async () => {
      const result = await manager.startCapture('DEV001');

      expect(mockMitm.startCapture).toHaveBeenCalledWith('DEV001', {
        sessionId: result.sessionId,
        deviceId: 'DEV001',
      });
    });

    it('should inject CA cert and activate WireGuard tunnel', async () => {
      await manager.startCapture('DEV001');

      expect(mockDm.injectMitmproxyCaCert).toHaveBeenCalledWith('DEV001');
      expect(mockDm.activateWireGuardTunnel).toHaveBeenCalledWith('DEV001', {
        clientPrivateKey: 'test-client-key',
        serverPublicKey: 'test-server-key',
        clientAddress: '10.0.0.2/32',
        serverEndpoint: '192.168.1.100:51820',
      });
    });

    it('should test tunnel connectivity', async () => {
      await manager.startCapture('DEV001');

      expect(mockDm.testTunnelConnectivity).toHaveBeenCalledWith('DEV001');
    });

    it('should broadcast capturing status with subsystems', async () => {
      const result = await manager.startCapture('DEV001');

      // Final broadcast should include all subsystems as 'ok'
      expect(mockBroadcastToAll).toHaveBeenCalledWith({
        type: 'capture-status',
        deviceId: 'DEV001',
        status: 'capturing',
        sessionId: result.sessionId,
        error: undefined,
        subsystems: {
          mitmproxy: 'ok',
          certInjection: 'ok',
          wireguard: 'ok',
          connectivity: 'ok',
        },
      });
    });

    it('should return existing sessionId if already capturing', async () => {
      const first = await manager.startCapture('DEV001');
      const second = await manager.startCapture('DEV001');

      expect(second.sessionId).toBe(first.sessionId);
      // startCapture on mitmproxy should only be called once
      expect(mockMitm.startCapture).toHaveBeenCalledOnce();
    });

    it('should clean up on error and mark session as failed', async () => {
      mockDm.activateWireGuardTunnel.mockRejectedValue(new Error('tunnel failed'));

      await expect(manager.startCapture('DEV001')).rejects.toThrow('tunnel failed');

      // Session should be marked failed
      const sessions = db.select().from(schema.automationSessions).all();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('failed');

      // mitmproxy should be stopped
      expect(mockMitm.stopCapture).toHaveBeenCalledWith('DEV001');

      // Should broadcast error status
      expect(mockBroadcastToAll).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'capture-status',
          deviceId: 'DEV001',
          status: 'error',
        }),
      );

      // Should not be capturing
      expect(manager.isCapturing('DEV001')).toBe(false);
    });

    it('should handle mitmproxy returning undefined tunnelInfo', async () => {
      mockMitm.startCapture.mockResolvedValue(undefined);

      const result = await manager.startCapture('DEV001');

      expect(result.sessionId).toBeDefined();
      expect(mockDm.injectMitmproxyCaCert).not.toHaveBeenCalled();
      expect(mockDm.activateWireGuardTunnel).not.toHaveBeenCalled();
    });
  });

  describe('stopCapture', () => {
    it('should stop capture and update session', async () => {
      const { sessionId } = await manager.startCapture('DEV001');
      await manager.stopCapture('DEV001');

      // Session should be success
      const sessions = db.select().from(schema.automationSessions).all();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe('success');
      expect(sessions[0].completedAt).not.toBeNull();
    });

    it('should deactivate tunnel and stop mitmproxy', async () => {
      await manager.startCapture('DEV001');
      await manager.stopCapture('DEV001');

      expect(mockDm.deactivateWireGuardTunnel).toHaveBeenCalledWith('DEV001');
      expect(mockMitm.stopCapture).toHaveBeenCalledWith('DEV001');
    });

    it('should broadcast stopped status', async () => {
      await manager.startCapture('DEV001');
      mockBroadcastToAll.mockClear();

      await manager.stopCapture('DEV001');

      expect(mockBroadcastToAll).toHaveBeenCalledWith({
        type: 'capture-status',
        deviceId: 'DEV001',
        status: 'stopped',
        sessionId: undefined,
        error: undefined,
        subsystems: undefined,
      });
    });

    it('should be a no-op if no active capture', async () => {
      await manager.stopCapture('DEV001');

      expect(mockDm.deactivateWireGuardTunnel).not.toHaveBeenCalled();
      expect(mockMitm.stopCapture).not.toHaveBeenCalled();
    });

    it('should remove device from active sessions', async () => {
      await manager.startCapture('DEV001');
      expect(manager.isCapturing('DEV001')).toBe(true);

      await manager.stopCapture('DEV001');
      expect(manager.isCapturing('DEV001')).toBe(false);
    });
  });

  describe('isCapturing', () => {
    it('should return false when no capture is active', () => {
      expect(manager.isCapturing('DEV001')).toBe(false);
    });

    it('should return true when capture is active', async () => {
      await manager.startCapture('DEV001');
      expect(manager.isCapturing('DEV001')).toBe(true);
    });
  });

  describe('getSessionId', () => {
    it('should return undefined when no capture is active', () => {
      expect(manager.getSessionId('DEV001')).toBeUndefined();
    });

    it('should return sessionId when capture is active', async () => {
      const { sessionId } = await manager.startCapture('DEV001');
      expect(manager.getSessionId('DEV001')).toBe(sessionId);
    });
  });

  describe('getCapturingDeviceIds', () => {
    it('returns empty array when no captures are active', () => {
      expect(manager.getCapturingDeviceIds()).toEqual([]);
    });

    it('returns device IDs of active captures', async () => {
      db.insert(schema.devices).values({ id: 'DEV002', name: 'Device 2' }).run();

      await manager.startCapture('DEV001');
      await manager.startCapture('DEV002');

      const ids = manager.getCapturingDeviceIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('DEV001');
      expect(ids).toContain('DEV002');
    });

    it('excludes stopped captures', async () => {
      db.insert(schema.devices).values({ id: 'DEV002', name: 'Device 2' }).run();

      await manager.startCapture('DEV001');
      await manager.startCapture('DEV002');
      await manager.stopCapture('DEV001');

      const ids = manager.getCapturingDeviceIds();
      expect(ids).toEqual(['DEV002']);
    });
  });

  describe('stopAll', () => {
    it('should stop all active captures', async () => {
      db.insert(schema.devices).values({ id: 'DEV002', name: 'Device 2' }).run();

      await manager.startCapture('DEV001');
      await manager.startCapture('DEV002');

      expect(manager.isCapturing('DEV001')).toBe(true);
      expect(manager.isCapturing('DEV002')).toBe(true);

      await manager.stopAll();

      expect(manager.isCapturing('DEV001')).toBe(false);
      expect(manager.isCapturing('DEV002')).toBe(false);
    });
  });

  describe('tunnel connectivity retry', () => {
    it('should retry tunnel connectivity and succeed on later attempt', async () => {
      mockDm.testTunnelConnectivity
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true });

      await manager.startCapture('DEV001');

      expect(mockDm.testTunnelConnectivity).toHaveBeenCalledTimes(3);
      expect(manager.isCapturing('DEV001')).toBe(true);
    });

    it('should proceed even if tunnel connectivity never succeeds', async () => {
      mockDm.testTunnelConnectivity.mockResolvedValue({ success: false });

      await manager.startCapture('DEV001');

      expect(mockDm.testTunnelConnectivity).toHaveBeenCalledTimes(5);
      // Should still be capturing despite connectivity check failure
      expect(manager.isCapturing('DEV001')).toBe(true);
    }, 10000);
  });

  describe('subsystem status tracking', () => {
    it('should emit multiple intermediate broadcasts during startup', async () => {
      await manager.startCapture('DEV001');

      // 4 broadcasts: after mitmproxy, after cert, after wg, final
      const capturingBroadcasts = mockBroadcastToAll.mock.calls.filter(
        (c: any) => c[0].status === 'capturing',
      );
      expect(capturingBroadcasts.length).toBe(4);

      // First: mitmproxy ok, rest pending
      expect(capturingBroadcasts[0][0].subsystems).toEqual({
        mitmproxy: 'ok',
        certInjection: 'pending',
        wireguard: 'pending',
        connectivity: 'pending',
      });

      // Second: cert ok
      expect(capturingBroadcasts[1][0].subsystems.certInjection).toBe('ok');

      // Third: wireguard ok
      expect(capturingBroadcasts[2][0].subsystems.wireguard).toBe('ok');

      // Final: all ok
      expect(capturingBroadcasts[3][0].subsystems).toEqual({
        mitmproxy: 'ok',
        certInjection: 'ok',
        wireguard: 'ok',
        connectivity: 'ok',
      });
    });

    it('should mark failing subsystem as error on startup failure', async () => {
      mockDm.activateWireGuardTunnel.mockRejectedValue(new Error('wg failed'));

      await expect(manager.startCapture('DEV001')).rejects.toThrow('wg failed');

      const errorBroadcast = mockBroadcastToAll.mock.calls.find(
        (c: any) => c[0].status === 'error',
      );
      expect(errorBroadcast).toBeDefined();
      expect(errorBroadcast![0].subsystems).toEqual({
        mitmproxy: 'ok',
        certInjection: 'ok',
        wireguard: 'error',
        connectivity: 'error',
      });
    });

    it('should mark cert/wg/connectivity as skipped when no tunnel info', async () => {
      mockMitm.startCapture.mockResolvedValue(undefined);

      await manager.startCapture('DEV001');

      const finalBroadcast = mockBroadcastToAll.mock.calls
        .filter((c: any) => c[0].status === 'capturing')
        .pop();
      expect(finalBroadcast![0].subsystems).toEqual({
        mitmproxy: 'ok',
        certInjection: 'skipped',
        wireguard: 'skipped',
        connectivity: 'skipped',
      });
    });

    it('should mark connectivity as warning when tunnel test fails', async () => {
      mockDm.testTunnelConnectivity.mockResolvedValue({ success: false });

      await manager.startCapture('DEV001');

      const finalBroadcast = mockBroadcastToAll.mock.calls
        .filter((c: any) => c[0].status === 'capturing')
        .pop();
      expect(finalBroadcast![0].subsystems.connectivity).toBe('warning');
    }, 10000);

    it('getSubsystems should return stored state for active capture', async () => {
      await manager.startCapture('DEV001');

      const subsystems = manager.getSubsystems('DEV001');
      expect(subsystems).toEqual({
        mitmproxy: 'ok',
        certInjection: 'ok',
        wireguard: 'ok',
        connectivity: 'ok',
      });
    });

    it('getSubsystems should return undefined when no capture is active', () => {
      expect(manager.getSubsystems('DEV001')).toBeUndefined();
    });

    it('getSubsystems should return undefined after capture stops', async () => {
      await manager.startCapture('DEV001');
      await manager.stopCapture('DEV001');

      expect(manager.getSubsystems('DEV001')).toBeUndefined();
    });
  });

  describe('capture rules integration', () => {
    it('should run capture rules when automationRunner is provided', async () => {
      const mockRunner = {
        getCaptureRules: vi.fn().mockReturnValue([{ id: 1, name: 'CR1', code: 'code', priority: 1 }]),
        runCaptureRules: vi.fn().mockResolvedValue(undefined),
      };

      const managerWithRunner = wireRegistry(new CaptureSessionManager(
        db, mockMitm as any, mockDm as any, mockRunner as any,
      ), mockMitm, mockDm);

      await managerWithRunner.startCapture('DEV001');
      // runCaptureRules is fire-and-forget, flush microtasks
      await new Promise(r => setTimeout(r, 0));

      expect(mockRunner.getCaptureRules).toHaveBeenCalled();
      expect(mockRunner.runCaptureRules).toHaveBeenCalled();
      const [deviceId, sessionId] = mockRunner.runCaptureRules.mock.calls[0];
      expect(deviceId).toBe('DEV001');
      expect(typeof sessionId).toBe('number');
    });

    it('should set interceptHooks when capture rules exist', async () => {
      const mockRunner = {
        getCaptureRules: vi.fn().mockReturnValue([{ id: 1, name: 'CR1', code: 'code', priority: 1 }]),
        runCaptureRules: vi.fn().mockResolvedValue(undefined),
      };

      const managerWithRunner = wireRegistry(new CaptureSessionManager(
        db, mockMitm as any, mockDm as any, mockRunner as any,
      ), mockMitm, mockDm);

      await managerWithRunner.startCapture('DEV001');

      const mitmOptions = mockMitm.startCapture.mock.calls[0][1];
      expect(mitmOptions.interceptHooks).toBe(true);
    });

    it('should not set interceptHooks when no capture rules exist', async () => {
      const mockRunner = {
        getCaptureRules: vi.fn().mockReturnValue([]),
        runCaptureRules: vi.fn().mockResolvedValue(undefined),
      };

      const managerWithRunner = wireRegistry(new CaptureSessionManager(
        db, mockMitm as any, mockDm as any, mockRunner as any,
      ), mockMitm, mockDm);

      await managerWithRunner.startCapture('DEV001');

      const mitmOptions = mockMitm.startCapture.mock.calls[0][1];
      expect(mitmOptions.interceptHooks).toBeUndefined();
      expect(mockRunner.runCaptureRules).not.toHaveBeenCalled();
    });

    it('should clear hooks on stop when trafficHookRegistry is provided', async () => {
      const mockRegistry = {
        clearHooks: vi.fn(),
      };

      const managerWithRegistry = wireRegistry(new CaptureSessionManager(
        db, mockMitm as any, mockDm as any, undefined, mockRegistry as any,
      ), mockMitm, mockDm);

      await managerWithRegistry.startCapture('DEV001');
      await managerWithRegistry.stopCapture('DEV001');

      expect(mockRegistry.clearHooks).toHaveBeenCalledWith('DEV001');
    });

    it('should not fail on stop when no trafficHookRegistry', async () => {
      // Default manager has no trafficHookRegistry
      await manager.startCapture('DEV001');
      await manager.stopCapture('DEV001');

      // Should not throw
      expect(manager.isCapturing('DEV001')).toBe(false);
    });

    it('should continue capture even if runCaptureRules fails', async () => {
      const mockRunner = {
        getCaptureRules: vi.fn().mockReturnValue([{ id: 1, name: 'CR1', code: 'code', priority: 1 }]),
        runCaptureRules: vi.fn().mockRejectedValue(new Error('capture rule error')),
      };

      const managerWithRunner = wireRegistry(new CaptureSessionManager(
        db, mockMitm as any, mockDm as any, mockRunner as any,
      ), mockMitm, mockDm);

      const result = await managerWithRunner.startCapture('DEV001');
      // runCaptureRules is fire-and-forget, flush microtasks so .catch runs
      await new Promise(r => setTimeout(r, 0));

      // Capture should still be active despite rule failure
      expect(result.sessionId).toBeDefined();
      expect(managerWithRunner.isCapturing('DEV001')).toBe(true);
    });
  });

  describe('hookBus lifecycle hooks', () => {
    it('emits session:created after session row is inserted', async () => {
      const bus = { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn() };
      manager.setHookBus(bus as any);

      const result = await manager.startCapture('DEV001');

      expect(bus.emit).toHaveBeenCalledWith('session:created', {
        sessionId: result.sessionId,
        deviceId: 'DEV001',
        triggerType: 'capture',
      });
    });

    it('does not throw when no hookBus is wired', async () => {
      // hookBus is null by default — optional chaining prevents crash
      await expect(manager.startCapture('DEV001')).resolves.toBeDefined();
    });
  });
});
