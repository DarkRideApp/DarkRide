import { createLoggers } from '../logs';
import type { CaptureHandler, CaptureModeContext, CaptureModeResult } from './capture-mode-registry';
import type { MitmproxyOptions, MitmproxyManager } from './mitmproxy-manager';
import type { DeviceManager } from './device-manager';
import type { WireGuardTunnelInfo } from './wireguard-config';
import type { DockerLike } from './providers/docker-helpers';

const { log } = createLoggers('capture-handlers');

/**
 * Cap on the inline "is the existing tunnel still alive?" probe in the
 * already-running branch. Comfortably under the frontend's 30s abort for the
 * capture-start call, with room left for the re-activation that may follow.
 */
const REACTIVATION_PROBE_TIMEOUT = 12_000;

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
  /**
   * Session id of the capture currently active on a device, or undefined if
   * none. Lets the detached connectivity probe verify it is still reporting on
   * its OWN session before broadcasting — a stop/start inside the probe window
   * would otherwise publish the old session's status over the new one's.
   */
  getActiveSessionId: (deviceId: string) => number | undefined;
  /**
   * Deterministically (re)derive a device's WireGuard tunnel info without
   * touching mitmproxy. Used to recover tunnel keys/addresses when the
   * on-device tunnel needs to be re-activated but mitmproxy is already
   * running (so it won't hand back fresh `tunnelInfo` itself).
   */
  ensureConfigs: (deviceId: string, wgPort?: number) => WireGuardTunnelInfo | Promise<WireGuardTunnelInfo>;
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
    getActiveSessionId,
    ensureConfigs,
  } = deps;

  /**
   * Confirm tunnel connectivity WITHOUT blocking the capture-start response.
   *
   * Once the WireGuard tunnel is up, capture is already functional — this probe
   * is a best-effort confirmation. But it is slow: `waitForTunnelReady` runs
   * several attempts of `curl --max-time 10`, so a device whose connectivity
   * can't be confirmed keeps the probe busy for tens of seconds. Awaiting it
   * inside `startCapture` kept the HTTP response pending that whole time, and
   * the frontend aborts a REST-over-WS call at 30s — so capture reported a
   * "timeout" stuck at 3/4 (mitmproxy + certInjection + wireguard done,
   * connectivity never resolving) even though the tunnel was working.
   *
   * Instead we detach the probe: return from the handler as soon as the tunnel
   * is active, and let the probe report `connectivity` over the WS subsystem
   * channel when it finishes. The subsystem starts 'pending' (its initial
   * state) and flips to 'ok'/'warning' asynchronously.
   */
  const confirmConnectivityDetached = (ctx: CaptureModeContext): void => {
    void (async () => {
      let ready = false;
      try {
        ready = await waitForTunnelReady(ctx.deviceId);
      } catch (err: any) {
        log(`Connectivity probe errored for ${ctx.deviceId}: ${err?.message ?? err}`);
      }
      // The user may have stopped — or stopped AND restarted — the capture
      // while we were probing. `setSubsystem` broadcasts this invocation's
      // sessionId and subsystem snapshot, so publishing it late would either
      // resurrect a stopped capture or overwrite a newer session's status with
      // the previous one's.
      //
      // Two checks, because neither alone is sufficient. `isCapturing` answers
      // "is SOME capture live on this device" — it can't spot a stop+start. And
      // the session id is not registered until AFTER the handler returns, so a
      // fast probe legitimately sees `undefined` for its own still-starting
      // session; treating that as a mismatch would silence the common case.
      if (!mitmproxyManager.isCapturing(ctx.deviceId)) return;
      const activeSessionId = getActiveSessionId(ctx.deviceId);
      if (activeSessionId !== undefined && activeSessionId !== ctx.sessionId) return;
      ctx.setSubsystem('connectivity', ready ? 'ok' : 'warning');
      if (!ready) {
        log(`Tunnel connectivity not confirmed for device ${ctx.deviceId}, capture continues`);
      }
    })();
  };

  const wireguard: CaptureHandler = async (ctx: CaptureModeContext): Promise<CaptureModeResult> => {
    // Physical Android device: WireGuard tunnel path.
    const tunnelInfo = await mitmproxyManager.startCapture(
      ctx.deviceId,
      ctx.mitmOptions as MitmproxyOptions,
    );
    ctx.setSubsystem('mitmproxy', 'ok');

    if (!tunnelInfo) {
      // mitmproxy reports it was already running for this device. That
      // normally means the device's tunnel is already up too, but host
      // and device state can drift apart — e.g. the device reboots and
      // loses its tunnel interface/routes while the host-side mitmproxy
      // process keeps running untouched. Probe actual device
      // connectivity before assuming the capture is fully active; if
      // the tunnel is confirmed down, re-derive its config deterministically
      // and re-activate it on the device.
      //
      // This probe is load-bearing (it decides whether to re-activate) so it
      // can't be detached like the one above — but it must still be BOUNDED.
      // `waitForTunnelReady` is 5 attempts of `curl --max-time 10` plus 1s
      // sleeps, i.e. up to ~55s, and the frontend aborts the capture-start call
      // at 30s. Unbounded, this path reproduced the same "capture times out
      // while actually working" bug the detached probe was introduced to fix.
      // On timeout we assume the tunnel is down and re-activate: redoing
      // idempotent setup is cheap, leaving the user with a dead tunnel is not.
      const tunnelReady = await Promise.race([
        waitForTunnelReady(ctx.deviceId),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REACTIVATION_PROBE_TIMEOUT)),
      ]);
      if (tunnelReady) {
        ctx.setSubsystem('certInjection', 'skipped');
        ctx.setSubsystem('wireguard', 'skipped');
        ctx.setSubsystem('connectivity', 'skipped');
        return { tunnelActivated: false };
      }

      log(`Device tunnel for ${ctx.deviceId} is down but mitmproxy is already running; re-activating`);
      const wgPort = (ctx.mitmOptions as MitmproxyOptions)?.wgPort ?? 51820;
      const recoveredTunnelInfo = await ensureConfigs(ctx.deviceId, wgPort);

      await deviceManager.injectMitmproxyCaCert(ctx.deviceId);
      ctx.setSubsystem('certInjection', 'ok');

      await deviceManager.activateWireGuardTunnel(ctx.deviceId, recoveredTunnelInfo);
      ctx.setSubsystem('wireguard', 'ok');

      // Confirm connectivity in the background (see confirmConnectivityDetached)
      // so re-activation doesn't block the response past the client timeout.
      confirmConnectivityDetached(ctx);

      return { tunnelActivated: true };
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

    // Confirm tunnel connectivity in the background so the slow best-effort
    // probe doesn't block the capture-start response past the client timeout.
    // `connectivity` stays 'pending' and resolves over WS. See
    // confirmConnectivityDetached.
    confirmConnectivityDetached(ctx);

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
