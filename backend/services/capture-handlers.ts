import { createLoggers } from '../logs';
import type { CaptureHandler, CaptureModeContext, CaptureModeResult } from './capture-mode-registry';
import type { MitmproxyOptions, MitmproxyManager } from './mitmproxy-manager';
import type { DeviceManager } from './device-manager';
import type { WireGuardTunnelInfo } from './wireguard-config';
import type { DockerLike } from './providers/docker-helpers';

const { log } = createLoggers('capture-handlers');

/**
 * Host-side dependencies a capture-mode handler needs. Every handle here is a
 * pure function or a manager method — no `this`, no DB access. The orchestrator
 * (CaptureSessionManager, Task 6) builds these from its own managers and the
 * docker-helpers module, then passes them once to {@link makeCaptureHandlers}.
 *
 * `lookupRuntimeId` and `waitForTunnelReady` are deliberately narrow so the
 * handlers stay decoupled from the DB and the manager's private helpers: the
 * orchestrator owns those lookups and threads the results through.
 */
export interface CaptureHandlerDeps {
  mitmproxyManager: Pick<MitmproxyManager, 'startCapture' | 'startHttpProxyCapture' | 'isCapturing'>;
  deviceManager: Pick<
    DeviceManager,
    'injectMitmproxyCaCert' | 'activateWireGuardTunnel' | 'setupEmulatorHttpProxy'
  >;
  spawnContainerHttpForwarder: (
    d: DockerLike,
    containerId: string,
    listenPort: number,
    targetHost: string,
    targetPort: number,
  ) => Promise<void>;
  getActiveDockerClient: () => DockerLike | null;
  /** Resolve the docker runtime (container) id for a device, if it has one. */
  lookupRuntimeId: (deviceId: string) => string | undefined;
  /** Probe tunnel connectivity; resolves true once reachable. */
  waitForTunnelReady: (deviceId: string) => Promise<boolean>;
}

export type CaptureMode = 'wireguard' | 'emu-http-proxy' | 'ios-bridge';

/**
 * Build the three built-in capture-mode handlers from host-side deps.
 *
 * These are a behavior-preserving extraction of the inline branches that used
 * to live in `CaptureSessionManager.startCapture`:
 *   - `wireguard`       <- the `platform === 'android'` (physical) branch
 *   - `emu-http-proxy`  <- the `isDockerAndroid && android` branch
 *   - `ios-bridge`      <- the `else` (iOS) branch
 *
 * Same calls, same order, same throws/log messages. The only translation is
 * `subsystems.X = Y; this.broadcastStatus(...)` pairs become
 * `ctx.setSubsystem('X', Y)`, and the branch returns a {@link CaptureModeResult}
 * instead of mutating `tunnelActivated`/`emuHttpProxy` closures.
 */
export function makeCaptureHandlers(deps: CaptureHandlerDeps): Record<CaptureMode, CaptureHandler> {
  const {
    mitmproxyManager,
    deviceManager,
    spawnContainerHttpForwarder,
    getActiveDockerClient,
    lookupRuntimeId,
    waitForTunnelReady,
  } = deps;

  const wireguard: CaptureHandler = async (ctx: CaptureModeContext): Promise<CaptureModeResult> => {
    // Physical Android device: WireGuard tunnel path.
    const tunnelInfo = await mitmproxyManager.startCapture(
      ctx.deviceId,
      ctx.mitmOptions as MitmproxyOptions,
    );
    ctx.setSubsystem('mitmproxy', 'ok');

    if (!tunnelInfo) {
      // mitmproxy reports it was already running for this device; we
      // can't set up the tunnel without fresh keys. Mark the rest of
      // the subsystems as skipped so the UI shows the right state.
      ctx.setSubsystem('certInjection', 'skipped');
      ctx.setSubsystem('wireguard', 'skipped');
      ctx.setSubsystem('connectivity', 'skipped');
      return { tunnelActivated: false };
    }

    // Inject CA cert
    await deviceManager.injectMitmproxyCaCert(ctx.deviceId);
    ctx.setSubsystem('certInjection', 'ok');

    // Activate WireGuard tunnel
    await deviceManager.activateWireGuardTunnel(ctx.deviceId, tunnelInfo as WireGuardTunnelInfo);
    const tunnelActivated = true;
    ctx.setSubsystem('wireguard', 'ok');

    // Sanity-check: ensure mitmproxy didn't crash during cert/tunnel setup
    if (!mitmproxyManager.isCapturing(ctx.deviceId)) {
      ctx.setSubsystem('mitmproxy', 'error');
      throw new Error('mitmproxy process exited during capture startup');
    }

    // Wait for tunnel connectivity
    const ready = await waitForTunnelReady(ctx.deviceId);
    ctx.setSubsystem('connectivity', ready ? 'ok' : 'warning');
    if (!ready) {
      log(`Tunnel connectivity not confirmed for device ${ctx.deviceId}, proceeding anyway`);
    }

    return { tunnelActivated };
  };

  const emuHttpProxy: CaptureHandler = async (ctx: CaptureModeContext): Promise<CaptureModeResult> => {
    // Start mitmproxy in regular HTTP forward-proxy mode on a free port.
    const { port } = await mitmproxyManager.startHttpProxyCapture(
      ctx.deviceId,
      ctx.mitmOptions as MitmproxyOptions,
    );

    // The Android emulator's QEMU NAT filters RFC1918 private IPs —
    // confirmed by an explicit `nc -z 172.17.0.1 <port>` probe from
    // inside the emulator returning failure even when the host can
    // reach the same address. Only 10.0.2.2 (the QEMU host = our
    // container) is reliably reachable from inside the emulator.
    //
    // Workaround: spawn a Python TCP forwarder INSIDE the container
    // that listens on the same port and relays to the host's docker-
    // bridge gateway (where mitmproxy actually lives). The emulator
    // then targets 10.0.2.2:<port> and the chain becomes:
    //   emulator -> 10.0.2.2 (QEMU NAT to container)
    //            -> container's forwarder
    //            -> 172.17.0.1:<port> (host bridge gateway)
    //            -> mitmproxy
    const gateway = process.env.DARKRIDE_DOCKER_BRIDGE_GATEWAY || '172.17.0.1';
    const docker = getActiveDockerClient();
    const runtimeId = lookupRuntimeId(ctx.deviceId);
    if (!docker || !runtimeId) {
      throw new Error(
        `docker-android device ${ctx.deviceId} has no container handle (docker=${!!docker} runtimeId=${runtimeId ?? 'null'})`,
      );
    }
    log(`Spawning in-container TCP forwarder for ${ctx.deviceId}: 0.0.0.0:${port} -> ${gateway}:${port}`);
    await spawnContainerHttpForwarder(docker, runtimeId, port, gateway, port);
    // The forwarder listens on the container's interfaces; the
    // emulator reaches it via 10.0.2.2 (QEMU's pseudonym for the
    // container).
    const emuHttpProxyEndpoint = { host: '10.0.2.2', port };
    ctx.setSubsystem('mitmproxy', 'ok');

    // adb root, push user CA cert, set system http_proxy. The system
    // setting is best-effort (HttpURLConnection ignores it) — the
    // E2E fixture targets the proxy explicitly via Intent extra.
    await deviceManager.setupEmulatorHttpProxy(ctx.deviceId, '10.0.2.2', port);
    ctx.setSubsystem('certInjection', 'ok');
    // WireGuard is conceptually skipped here, but the subsystems shape
    // is shared with physical-device flows — mark it as skipped rather
    // than failing.
    ctx.setSubsystem('wireguard', 'skipped');

    if (!mitmproxyManager.isCapturing(ctx.deviceId)) {
      ctx.setSubsystem('mitmproxy', 'error');
      throw new Error('mitmproxy process exited during capture startup');
    }
    ctx.setSubsystem('connectivity', 'ok');

    return { tunnelActivated: false, emuHttpProxy: emuHttpProxyEndpoint };
  };

  const iosBridge: CaptureHandler = async (ctx: CaptureModeContext): Promise<CaptureModeResult> => {
    // iOS: start mitmproxy in WireGuard mode but skip the on-device
    // setup — the user scans a QR code to install the tunnel manually.
    await mitmproxyManager.startCapture(ctx.deviceId, ctx.mitmOptions as MitmproxyOptions);
    ctx.setSubsystem('mitmproxy', 'ok');
    ctx.setSubsystem('certInjection', 'skipped');
    ctx.setSubsystem('wireguard', 'skipped');
    ctx.setSubsystem('connectivity', 'skipped');

    return { tunnelActivated: false };
  };

  return {
    wireguard,
    'emu-http-proxy': emuHttpProxy,
    'ios-bridge': iosBridge,
  };
}
