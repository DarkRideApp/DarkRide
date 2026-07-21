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
