import { describe, it, expect, vi } from 'vitest';
import { makeCaptureHandlers } from './capture-handlers';

function deps() {
  return {
    mitmproxyManager: {
      startCapture: vi.fn().mockResolvedValue({ wgConfig: 'x' }),
      startHttpProxyCapture: vi.fn().mockResolvedValue({ port: 8081 }),
      isCapturing: vi.fn().mockReturnValue(true),
    },
    deviceManager: {
      injectMitmproxyCaCert: vi.fn().mockResolvedValue(undefined),
      activateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      setupEmulatorHttpProxy: vi.fn().mockResolvedValue(undefined),
    },
    spawnContainerHttpForwarder: vi.fn().mockResolvedValue(undefined),
    getActiveDockerClient: vi.fn().mockReturnValue({}),
    lookupRuntimeId: vi.fn().mockReturnValue('container123'),
    waitForTunnelReady: vi.fn().mockResolvedValue(true),
    getActiveSessionId: vi.fn().mockReturnValue(1),
    ensureConfigs: vi.fn().mockReturnValue({
      clientPrivateKey: 'client-priv',
      serverPublicKey: 'server-pub',
      clientAddress: '10.0.0.2/32',
      serverEndpoint: '203.0.113.1:51820',
      serverConfigPath: '/tmp/wg-config.json',
    }),
  };
}
const ctx = (over = {}) => ({
  deviceId: 'localhost:32770', sessionId: 1, platform: 'android' as const,
  mode: 'wireguard', mitmOptions: {}, setSubsystem: vi.fn(), ...over,
});

describe('capture handlers', () => {
  it('wireguard: starts capture, injects CA, activates tunnel, returns tunnelActivated', async () => {
    const d = deps(); const h = makeCaptureHandlers(d as any);
    const r = await h.wireguard(ctx());
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.deviceManager.injectMitmproxyCaCert).toHaveBeenCalledWith('localhost:32770');
    expect(d.deviceManager.activateWireGuardTunnel).toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(true);
  });

  it('wireguard: returns without awaiting the connectivity probe (so a slow probe cannot time out the capture-start response)', async () => {
    // Regression for "gets to 3/4 and times out": the connectivity probe is a
    // slow best-effort confirmation, and awaiting it kept the HTTP response
    // pending past the frontend's 30s cutoff. The handler must resolve as soon
    // as the tunnel is active, even if the probe never resolves.
    const d = deps();
    d.waitForTunnelReady = vi.fn().mockReturnValue(new Promise<boolean>(() => {})); // never resolves
    const h = makeCaptureHandlers(d as any);

    const r = await h.wireguard(ctx()); // must not hang on the probe

    expect(r.tunnelActivated).toBe(true);
    expect(d.deviceManager.activateWireGuardTunnel).toHaveBeenCalled();
  });

  it('wireguard: reports connectivity over the subsystem channel after the detached probe finishes', async () => {
    const d = deps();
    let resolveProbe!: (v: boolean) => void;
    d.waitForTunnelReady = vi.fn().mockReturnValue(new Promise<boolean>((res) => { resolveProbe = res; }));
    const h = makeCaptureHandlers(d as any);
    const setSubsystem = vi.fn();

    await h.wireguard(ctx({ setSubsystem }));
    // Not reported yet — probe is still in flight, capture already "started".
    expect(setSubsystem).not.toHaveBeenCalledWith('connectivity', expect.anything());

    resolveProbe(true);
    await vi.waitFor(() => expect(setSubsystem).toHaveBeenCalledWith('connectivity', 'ok'));
  });

  it('wireguard: a detached probe that finishes after capture stopped does not re-broadcast connectivity', async () => {
    const d = deps();
    let resolveProbe!: (v: boolean) => void;
    d.waitForTunnelReady = vi.fn().mockReturnValue(new Promise<boolean>((res) => { resolveProbe = res; }));
    // Read through a variable: makeCaptureHandlers destructures the dep, so
    // reassigning d.getActiveSessionId afterwards would not reach the closure.
    let activeSession: number | undefined = 1;
    d.getActiveSessionId = vi.fn(() => activeSession);
    const h = makeCaptureHandlers(d as any);
    const setSubsystem = vi.fn();

    await h.wireguard(ctx({ sessionId: 1, setSubsystem }));
    // Simulate the user stopping capture before the probe resolves: no session
    // is active on the device any more.
    d.mitmproxyManager.isCapturing = vi.fn().mockReturnValue(false);
    activeSession = undefined;

    resolveProbe(true);
    // Give the detached task a chance to run, then assert it stayed quiet.
    await new Promise((r) => setTimeout(r, 0));
    expect(setSubsystem).not.toHaveBeenCalledWith('connectivity', expect.anything());
  });

  it('wireguard: a probe from a stopped session never reports into the session that replaced it', async () => {
    // stop + start inside the probe window. `isCapturing(deviceId)` is true
    // again by then (a NEW capture owns the device), so a device-scoped guard
    // would publish session 1's stale subsystem snapshot over session 2's.
    const d = deps();
    let release: (v: boolean) => void = () => {};
    d.waitForTunnelReady = vi.fn().mockReturnValue(new Promise<boolean>((r) => { release = r; }));
    d.getActiveSessionId = vi.fn().mockReturnValue(2); // session 2 is live now
    const setSubsystem = vi.fn();
    const h = makeCaptureHandlers(d as any);

    await h.wireguard(ctx({ sessionId: 1, setSubsystem }));
    setSubsystem.mockClear();
    release(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(setSubsystem).not.toHaveBeenCalled();
  });

  it('wireguard: the detached probe still reports into its own session', async () => {
    const d = deps();
    d.getActiveSessionId = vi.fn().mockReturnValue(7);
    const setSubsystem = vi.fn();
    const h = makeCaptureHandlers(d as any);

    await h.wireguard(ctx({ sessionId: 7, setSubsystem }));
    await new Promise((r) => setTimeout(r, 0));

    expect(setSubsystem).toHaveBeenCalledWith('connectivity', 'ok');
  });

  it('wireguard: already-running (no tunnelInfo) skips on-device setup, tunnelActivated false', async () => {
    const d = deps();
    d.mitmproxyManager.startCapture = vi.fn().mockResolvedValue(undefined);
    const h = makeCaptureHandlers(d as any);
    const r = await h.wireguard(ctx());
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.deviceManager.injectMitmproxyCaCert).not.toHaveBeenCalled();
    expect(d.deviceManager.activateWireGuardTunnel).not.toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(false);
  });

  it('wireguard: re-activates the device tunnel when mitmproxy is already running but the tunnel is down', async () => {
    const d = deps();
    d.mitmproxyManager.startCapture = vi.fn().mockResolvedValue(undefined);
    d.waitForTunnelReady = vi.fn().mockResolvedValue(false);
    const h = makeCaptureHandlers(d as any);
    const r = await h.wireguard(ctx());
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.ensureConfigs).toHaveBeenCalledWith('localhost:32770', expect.anything());
    expect(d.deviceManager.injectMitmproxyCaCert).toHaveBeenCalledWith('localhost:32770');
    expect(d.deviceManager.activateWireGuardTunnel).toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(true);
  });

  it('wireguard: does NOT re-activate when mitmproxy is already running and the tunnel is up', async () => {
    const d = deps();
    d.mitmproxyManager.startCapture = vi.fn().mockResolvedValue(undefined);
    d.waitForTunnelReady = vi.fn().mockResolvedValue(true);
    const h = makeCaptureHandlers(d as any);
    const r = await h.wireguard(ctx());
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.deviceManager.injectMitmproxyCaCert).not.toHaveBeenCalled();
    expect(d.deviceManager.activateWireGuardTunnel).not.toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(false);
  });

  it('wireguard: throws if mitmproxy exited during cert/tunnel setup', async () => {
    const d = deps();
    d.mitmproxyManager.isCapturing = vi.fn().mockReturnValue(false);
    const h = makeCaptureHandlers(d as any);
    await expect(h.wireguard(ctx())).rejects.toThrow(/mitmproxy process exited/i);
  });

  it('emu-http-proxy: starts http proxy, spawns forwarder, returns emuHttpProxy 10.0.2.2', async () => {
    const d = deps(); const h = makeCaptureHandlers(d as any);
    const r = await h['emu-http-proxy'](ctx({ mode: 'emu-http-proxy' }));
    expect(d.mitmproxyManager.startHttpProxyCapture).toHaveBeenCalled();
    expect(d.spawnContainerHttpForwarder).toHaveBeenCalled();
    expect(d.deviceManager.setupEmulatorHttpProxy).toHaveBeenCalledWith('localhost:32770', '10.0.2.2', 8081);
    expect(r).toEqual({ tunnelActivated: false, emuHttpProxy: { host: '10.0.2.2', port: 8081 } });
  });

  it('emu-http-proxy: throws when no docker client/runtimeId', async () => {
    const d = deps(); d.getActiveDockerClient = vi.fn().mockReturnValue(null);
    const h = makeCaptureHandlers(d as any);
    await expect(h['emu-http-proxy'](ctx({ mode: 'emu-http-proxy' }))).rejects.toThrow(/no container handle/i);
  });

  it('emu-http-proxy: throws if mitmproxy exited during startup', async () => {
    const d = deps();
    d.mitmproxyManager.isCapturing = vi.fn().mockReturnValue(false);
    const h = makeCaptureHandlers(d as any);
    await expect(h['emu-http-proxy'](ctx({ mode: 'emu-http-proxy' }))).rejects.toThrow(/mitmproxy process exited/i);
  });

  it('ios-bridge: starts capture, skips on-device setup, tunnelActivated false', async () => {
    const d = deps(); const h = makeCaptureHandlers(d as any);
    const r = await h['ios-bridge'](ctx({ platform: 'ios', mode: 'ios-bridge' }));
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.deviceManager.activateWireGuardTunnel).not.toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(false);
  });
});
