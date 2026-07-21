import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as schema from '../db/schema';
import { CaptureSessionManager } from './capture-session-manager';
import { createCaptureModeRegistry } from './capture-mode-registry';
import { makeCaptureHandlers } from './capture-handlers';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

/**
 * Manager-level emu-http-proxy coverage. This is the complement to
 * capture-handlers.test.ts (which exercises the handler in isolation): here we
 * drive the FULL startCapture path for a docker-android device —
 *   resolveCaptureMode -> CaptureModeRegistry.dispatch -> emu-http-proxy handler
 *   -> startCapture return value ({ sessionId, httpProxy }).
 *
 * The dispatch hinges on resolveCaptureMode returning 'emu-http-proxy'. That
 * requires two pieces of real state:
 *   1. a `device_instances` row whose `serial` == the deviceId and
 *      `providerId` == 'docker-android' (so getProviderIdForDevice resolves it).
 *   2. a providerRegistry whose 'docker-android' provider's
 *      getNetworkConfig(serial).mode === 'emu-http-proxy'.
 * With both in place the manager dispatches to the real emu-http-proxy handler
 * built by makeCaptureHandlers, whose docker deps (getActiveDockerClient,
 * lookupRuntimeId, spawnContainerHttpForwarder) we stub here.
 */

const DEVICE = 'localhost:32770';
const RUNTIME_ID = 'container-abc123';
const PROXY_PORT = 8081;

// Mock broadcastToAll (same as the sibling manager test).
const mockBroadcastToAll = vi.fn();
vi.mock('../websocket/index', () => ({
  broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
}));

function createMockMitmproxyManager() {
  const capturing = new Set<string>();
  return {
    startCapture: vi.fn(),
    startHttpProxyCapture: vi.fn().mockImplementation((deviceId: string) => {
      capturing.add(deviceId);
      return Promise.resolve({ port: PROXY_PORT });
    }),
    stopCapture: vi.fn().mockImplementation((deviceId: string) => {
      capturing.delete(deviceId);
      return Promise.resolve(undefined);
    }),
    isCapturing: vi.fn().mockImplementation((deviceId: string) => capturing.has(deviceId)),
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
    testTunnelConnectivity: vi.fn().mockResolvedValue({ success: true }),
    setupEmulatorHttpProxy: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Wire the real handlers with docker deps so the emu-http-proxy path can run.
 * Mirrors wireRegistry() in capture-session-manager.test.ts but supplies a real
 * (stubbed) docker client + forwarder + runtimeId lookup instead of the
 * null/no-op docker deps that test uses (it only exercises wireguard).
 */
function wireRegistry(
  manager: CaptureSessionManager,
  mockMitm: ReturnType<typeof createMockMitmproxyManager>,
  mockDm: ReturnType<typeof createMockDeviceManager>,
  spawnContainerHttpForwarder: ReturnType<typeof vi.fn>,
): CaptureSessionManager {
  const registry = createCaptureModeRegistry();
  const handlers = makeCaptureHandlers({
    mitmproxyManager: mockMitm as any,
    deviceManager: mockDm as any,
    spawnContainerHttpForwarder: spawnContainerHttpForwarder as any,
    getActiveDockerClient: () => ({} as any),
    lookupRuntimeId: (deviceId: string) => (deviceId === DEVICE ? RUNTIME_ID : undefined),
    waitForTunnelReady: (serial: string) => manager.waitForTunnelReady(serial),
    ensureConfigs: () => ({
      clientPrivateKey: 'test-client-priv',
      serverPublicKey: 'test-server-pub',
      clientAddress: '10.0.0.2/32',
      serverEndpoint: '203.0.113.1:51820',
    }),
  });
  registry.register('wireguard', handlers.wireguard);
  registry.register('emu-http-proxy', handlers['emu-http-proxy']);
  registry.register('ios-bridge', handlers['ios-bridge']);
  manager.setCaptureModeRegistry(registry);
  return manager;
}

/**
 * Minimal providerRegistry stub: a docker-android provider that reports
 * emu-http-proxy, plus an adb-device provider that reports wireguard. The
 * adb-device provider is what an emulator's serial ALSO resolves to when a
 * stale adb-device row shares the serial — the collision the running-first
 * tiebreak guards against.
 */
function createDockerAndroidProviderRegistry() {
  const provider = {
    id: 'docker-android',
    getNetworkConfig: vi.fn().mockReturnValue({ mode: 'emu-http-proxy' }),
  };
  const adbProvider = {
    id: 'adb-device',
    getNetworkConfig: vi.fn().mockReturnValue({ mode: 'wireguard' }),
  };
  return {
    registry: {
      register: vi.fn(),
      get: vi.fn().mockImplementation((id: string) =>
        id === 'docker-android' ? provider : id === 'adb-device' ? adbProvider : undefined),
      list: vi.fn().mockReturnValue([provider, adbProvider]),
      listInstancesAll: vi.fn().mockResolvedValue([]),
    },
    provider,
  };
}

describe('CaptureSessionManager — emu-http-proxy (docker-android)', () => {
  let db: AppDatabase;
  let mockMitm: ReturnType<typeof createMockMitmproxyManager>;
  let mockDm: ReturnType<typeof createMockDeviceManager>;
  let spawnContainerHttpForwarder: ReturnType<typeof vi.fn>;
  let manager: CaptureSessionManager;
  let provider: { getNetworkConfig: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createTestDb();
    mockMitm = createMockMitmproxyManager();
    mockDm = createMockDeviceManager();
    spawnContainerHttpForwarder = vi.fn().mockResolvedValue(undefined);
    manager = wireRegistry(
      new CaptureSessionManager(db, mockMitm as any, mockDm as any),
      mockMitm,
      mockDm,
      spawnContainerHttpForwarder,
    );

    const reg = createDockerAndroidProviderRegistry();
    provider = reg.provider;
    manager.setProviderRegistry(reg.registry as any);

    mockBroadcastToAll.mockClear();

    // Device row (platform android so resolveCaptureMode's fallback is wireguard,
    // but the provider lookup overrides it to emu-http-proxy).
    db.insert(schema.devices)
      .values({ id: DEVICE, name: 'Docker Emulator', platform: 'android', isRooted: false })
      .run();

    // device_instances row: serial == deviceId, providerId == 'docker-android'
    // so getProviderIdForDevice(DEVICE) -> 'docker-android'.
    db.insert(schema.deviceInstances)
      .values({
        providerId: 'docker-android',
        runtimeId: RUNTIME_ID,
        serial: DEVICE,
        state: 'running',
        spawnedByDarkride: true,
        createdAt: new Date(),
        lastStateAt: new Date(),
      })
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches docker-android to emu-http-proxy and returns the httpProxy endpoint', async () => {
    const result = await manager.startCapture(DEVICE);

    // Full manager return value: sessionId + the proxy endpoint the emu path adds.
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe('number');
    expect(result.httpProxy).toEqual({ host: '10.0.2.2', port: PROXY_PORT });

    // Mode was resolved via the provider's getNetworkConfig, keyed on the
    // instance runtime id (per the DeviceProvider contract), not the serial.
    expect(provider.getNetworkConfig).toHaveBeenCalledWith(RUNTIME_ID);

    // emu-http-proxy handler ran (not the wireguard one).
    expect(mockMitm.startHttpProxyCapture).toHaveBeenCalledWith(DEVICE, expect.any(Object));
    expect(mockMitm.startCapture).not.toHaveBeenCalled();
    expect(mockDm.activateWireGuardTunnel).not.toHaveBeenCalled();

    // On-device proxy setup + in-container forwarder were wired.
    expect(mockDm.setupEmulatorHttpProxy).toHaveBeenCalledWith(DEVICE, '10.0.2.2', PROXY_PORT);
    expect(spawnContainerHttpForwarder).toHaveBeenCalledTimes(1);
    expect(spawnContainerHttpForwarder).toHaveBeenCalledWith(
      expect.anything(),
      RUNTIME_ID,
      PROXY_PORT,
      expect.any(String),
      PROXY_PORT,
    );

    // Session is live and tracked.
    expect(manager.isCapturing(DEVICE)).toBe(true);
    const sessions = db.select().from(schema.automationSessions).all();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].deviceId).toBe(DEVICE);
    expect(sessions[0].status).toBe('running');
  });

  it('prefers the running docker-android row over a stale adb-device row sharing the serial', async () => {
    // Reproduce the serial collision: a docker-android emulator is also observed
    // by the adb-device provider, and a recycled host port can leave a stale
    // adb-device row. Here the stale adb-device row has the LOWER rowid and a
    // NEWER timestamp; only running-first resolution picks the live emulator. A
    // bare rowid-order .all()[0] would pick adb-device and mis-route to wireguard
    // (then result.httpProxy would be undefined and this test would fail).
    db.delete(schema.deviceInstances).run();
    db.insert(schema.deviceInstances).values({
      providerId: 'adb-device', runtimeId: '', serial: DEVICE, state: 'stopped',
      spawnedByDarkride: false, createdAt: new Date(), lastStateAt: new Date(2026, 5, 15, 10, 0, 0),
    }).run();
    db.insert(schema.deviceInstances).values({
      providerId: 'docker-android', runtimeId: RUNTIME_ID, serial: DEVICE, state: 'running',
      spawnedByDarkride: true, createdAt: new Date(), lastStateAt: new Date(2026, 5, 15, 9, 0, 0),
    }).run();

    const result = await manager.startCapture(DEVICE);

    // The live docker-android row won → emu-http-proxy, not the stale adb-device → wireguard.
    expect(result.httpProxy).toEqual({ host: '10.0.2.2', port: PROXY_PORT });
    expect(mockMitm.startHttpProxyCapture).toHaveBeenCalledWith(DEVICE, expect.any(Object));
    expect(mockMitm.startCapture).not.toHaveBeenCalled();
    expect(mockDm.activateWireGuardTunnel).not.toHaveBeenCalled();
  });
});
