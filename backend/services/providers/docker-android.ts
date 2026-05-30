import { existsSync } from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type {
  CreateInstanceSpec, CreateInstanceOpts, DeviceProvider, DeviceProviderInstance, NetworkConfig,
  ProviderAvailability, RunningInstance, CreateFormSchema,
} from '@darkrideapp/plugin-sdk';
import { type DockerLike, detectDockerDaemon, listDarkrideContainers } from './docker-helpers';
import { createLoggers } from '../../logs';

const execFile = promisify(execFileCb);
const { log, error: logError } = createLoggers('docker-android');

/**
 * Use budtmo's upstream image directly rather than republishing it under
 * our org. budtmo/docker-android is on Docker Hub (anonymous pull, no
 * auth), updated by upstream, and most users already have unrelated
 * Docker Hub pulls cached so layer reuse across containers is better.
 *
 * Tag scheme: budtmo publishes `emulator_<N>.0` (e.g. `emulator_14.0`).
 * Our UI surfaces the major version ("14") so callers stay short; we
 * translate to the budtmo tag form when constructing the image string.
 *
 * We previously shipped `ghcr.io/darkrideapp/docker-android:<N>` — a thin
 * wrapper on top of budtmo that added `wireguard-go + iproute2 + a custom
 * entrypoint`. None of it is needed any more: capture for docker-android
 * uses emu-http-proxy mode (no WireGuard inside the container), and our
 * backend's adb-connect retry already gates readiness — the custom
 * entrypoint's adbd-wait was redundant. Drops the per-version image
 * (~8 GB) from our hosting and removes a CI publish step.
 */
function budtmoImageFor(androidVersion: string): string {
  return `budtmo/docker-android:emulator_${androidVersion}.0`;
}
const LABEL_KEY = 'darkride.emulator';

// Emulator gRPC (EmulatorController + Rtc/JSEP) for the WebRTC video path.
//
// We launch with `-grpc 8554` WITHOUT auth. Two reasons confirmed empirically:
//  1. The emulator's token/JWT auth ("-grpc-use-token") is an Android-Studio-
//     specific scheme (issuer/audience allowlist at lib/emulator_access.json,
//     signed JWTs) — the raw console token is rejected.
//  2. With auth enabled the server restricts itself to container-localhost
//     (needs a forwarder); with `auth: none` it binds [::]:8554 (all
//     interfaces), so we can publish it straight to a host LOOPBACK port — no
//     forwarder needed.
// Security: this mirrors the budtmo VNC port (5900) — unauthenticated but
// bound to host 127.0.0.1 only. The real access gate for browsers is the
// DarkRide grpc-web bridge (session cookie + core.devices:read scope); the raw
// port is reachable only by host-local processes, same threat model as VNC.
const GRPC_PORT = 8554;

/** Aggregated pull progress broadcast to the UI. One number, one phrase, no per-layer noise. */
export interface PullProgress {
  /** 0..100; null while we don't yet know the total layer count. */
  percent: number | null;
  /** Human-readable current activity, e.g. "Downloading… 1.2 GB / 2.4 GB · 5 of 12 layers complete". */
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  completedLayers: number;
  totalLayers: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Pull `image` if it isn't already local. Aggregates per-layer progress
 * into a single PullProgress object and invokes `onProgress` at most ~every
 * 500ms — callers (the create API endpoint) forward this as one stable
 * payload on the row's broadcast, so the UI sees a single bytes-and-percent
 * number instead of the wild per-layer flips Docker emits natively.
 */
async function ensureImageLocal(
  d: DockerLike,
  image: string,
  onProgress?: (p: PullProgress) => void,
): Promise<void> {
  const dAny = d as any;
  try {
    if (typeof dAny.getImage === 'function') {
      await dAny.getImage(image).inspect();
      return; // already local
    }
  } catch {
    // fall through to pull
  }
  log(`Image ${image} not local — pulling (~2-3 GB compressed)`);

  interface Layer { id: string; total: number; downloaded: number; state: 'pending' | 'downloading' | 'extracting' | 'complete'; }
  const layers = new Map<string, Layer>();

  function snapshot(): PullProgress {
    const arr = [...layers.values()];
    const bytesTotal = arr.reduce((s, l) => s + l.total, 0);
    const bytesDone = arr.reduce((s, l) => s + (l.state === 'complete' ? l.total : l.downloaded), 0);
    const completedLayers = arr.filter((l) => l.state === 'complete').length;
    const totalLayers = arr.length;
    const percent = bytesTotal > 0 ? Math.min(100, Math.floor((bytesDone / bytesTotal) * 100)) : null;
    let phase = 'Preparing…';
    if (totalLayers === 0) phase = 'Connecting to registry…';
    else if (completedLayers === totalLayers) phase = 'Finalising…';
    else if (bytesTotal > 0) phase = `Downloading ${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)} · ${completedLayers}/${totalLayers} layers complete`;
    else phase = `Discovered ${totalLayers} layer${totalLayers === 1 ? '' : 's'}, waiting for size…`;
    return { percent, phase, bytesDone, bytesTotal, completedLayers, totalLayers };
  }

  const stream: any = await d.pull(image);
  let lastEmit = 0;
  function maybeEmit(force = false) {
    const now = Date.now();
    if (!force && now - lastEmit < 500) return;
    lastEmit = now;
    onProgress?.(snapshot());
  }
  maybeEmit(true);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev: any;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        if (ev.error) return reject(new Error(`docker pull ${image} failed: ${ev.error}`));
        const id = ev.id as string | undefined;
        const status = ev.status as string | undefined;
        if (!id || !status) continue;
        if (id === image) continue; // these are the meta lines, not layer events
        let layer = layers.get(id);
        if (!layer) {
          layer = { id, total: 0, downloaded: 0, state: 'pending' };
          layers.set(id, layer);
        }
        const pd = ev.progressDetail;
        if (status === 'Downloading') {
          layer.state = 'downloading';
          if (pd?.total > 0) layer.total = pd.total;
          if (typeof pd?.current === 'number') layer.downloaded = Math.min(pd.current, layer.total || pd.current);
        } else if (status === 'Download complete' || status === 'Verifying Checksum') {
          if (layer.total === 0 && pd?.total > 0) layer.total = pd.total;
          layer.downloaded = layer.total;
        } else if (status === 'Extracting') {
          layer.state = 'extracting';
          // Treat extract as already-downloaded for the byte counter (it is).
          layer.downloaded = layer.total;
        } else if (status === 'Pull complete') {
          layer.state = 'complete';
          layer.downloaded = layer.total;
        }
        maybeEmit();
      }
    };
    stream.on('data', onData);
    stream.on('end', () => {
      // Force one final emit with 100%.
      const final = snapshot();
      onProgress?.({ ...final, percent: 100, phase: 'Pull complete' });
      log(`Image pull complete: ${image}`);
      resolve();
    });
    stream.on('error', (err: Error) => {
      logError(`Image pull stream error for ${image}: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Injection-friendly options. Tests provide custom implementations of the
 * host-dependent probes; production uses real fs / dockerode / adb.
 *
 * Boot-wait knobs (bootTimeoutMs / bootRetryIntervalMs) exist so unit tests
 * can collapse the retry window to a few milliseconds — the production
 * defaults assume a cold docker-android boot (container + Android cold start
 * inside the container can take 60-120s on a CI runner without GPU).
 */
export interface DockerAndroidOptions {
  hasDevDri?: () => boolean;
  hasNvidia?: () => boolean | Promise<boolean>;
  adbConnect?: (port: number) => Promise<boolean>;
  bootCompleted?: (serial: string) => Promise<boolean>;
  bootTimeoutMs?: number;
  bootRetryIntervalMs?: number;
}

/**
 * docker-android provider — spawns Android emulators inside containers
 * built FROM budtmo/docker-android + darkride extras (wg-go, etc.).
 * See spec §6.3.
 */
export function createDockerAndroidProvider(d: DockerLike, opts: DockerAndroidOptions = {}): DeviceProvider {
  const hasDevDri = opts.hasDevDri ?? (() => existsSync('/dev/dri'));
  // /dev/kvm is what makes the in-container Android emulator able to use
  // hardware virtualization. Without it, budtmo/docker-android falls back
  // to software emulation that effectively never boots — the container
  // exits within seconds. We deliberately do NOT probe the Node host's
  // own filesystem for /dev/kvm: when DarkRide runs on Windows/Mac and
  // talks to a Docker Desktop VM, the host has no /dev/kvm but the
  // daemon's VM does. Always request it; the daemon's createContainer
  // call surfaces a clear error if it can't expose it (handled below).
  const hasNvidia = opts.hasNvidia ?? (async () => (await detectDockerDaemon(d)).nvidiaContainerToolkit === true);
  // Single-shot adb connect attempt. The retry loop lives in startInstance
  // so injection-tests can drive it via a sequence of resolved values.
  const adbConnect = opts.adbConnect ?? (async (port: number) => {
    try {
      // `adb connect` itself can succeed even if Android isn't booted — the
      // device just shows up as "offline". The boot-completed poll below is
      // the actual readiness gate.
      const { stdout } = await execFile('adb', ['connect', `localhost:${port}`], { timeout: 5000 });
      // adb prints "connected to" on success and "failed to connect" on
      // failure, both with exit 0. Inspect stdout.
      if (/connected to/i.test(stdout)) return true;
      return false;
    } catch (e: any) {
      // Don't spam the log — startInstance retries 30+ times during a cold
      // emulator boot. Log only at debug level (caller logs the final result).
      return false;
    }
  });
  // After adb connects, the device may still be "offline" until Android
  // finishes booting. `getprop sys.boot_completed` returns "1" once the
  // home screen is up — that's the signal the next API call (adb install)
  // will actually work against.
  const bootCompleted = opts.bootCompleted ?? (async (serial: string) => {
    try {
      const { stdout } = await execFile(
        'adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        { timeout: 5000 },
      );
      return stdout.trim() === '1';
    } catch {
      return false;
    }
  });
  // 240s: budtmo's entrypoint waits up to 120s for adbd to bind, after which
  // boot_completed typically takes another 30-60s. 240s leaves headroom.
  const bootTimeoutMs = opts.bootTimeoutMs ?? 240_000;
  const bootRetryIntervalMs = opts.bootRetryIntervalMs ?? 5_000;

  return {
    id: 'docker-android',
    displayName: 'Docker Android',
    // Phase 2: emulators stream device-only WebRTC via the emulator's gRPC
    // (EmulatorController + Rtc) through the DarkRide grpc-web bridge. The VNC
    // path (getVncEndpoint / budtmo x11vnc) is retained as a dormant fallback —
    // flip this back to 'vnc' to revert if WebRTC media is unavailable.
    videoTransport: 'webrtc',

    async isAvailable(): Promise<ProviderAvailability> {
      const r = await detectDockerDaemon(d);
      return { available: r.available, reason: r.reason, installHint: r.installHint };
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      const containers = await listDarkrideContainers(d);
      return containers.map((c) => ({
        id: c.id,
        displayName: c.name,
        serial: c.adbPort ? `localhost:${c.adbPort}` : undefined,
        state: c.state === 'running' ? 'running' : c.state === 'created' ? 'created' : 'stopped',
        spawnedByDarkride: true,
        metadata: { adbPort: c.adbPort, containerName: c.name },
      }));
    },

    async createInstance(spec: CreateInstanceSpec, opts?: CreateInstanceOpts): Promise<DeviceProviderInstance> {
      const androidVersion = String(spec.config.androidVersion ?? '14');
      const arch = String(spec.config.architecture ?? 'x86_64');
      const ramMb = Number(spec.config.ramMb ?? 2048);
      const image = budtmoImageFor(androidVersion);

      // /dev/kvm: required for in-container Android emulator. Without it,
      // the container exits within seconds (no software-emulation fallback
      // worth attempting — it would never boot in CI's time budget). We
      // always request it; the daemon rejects the create with "no such
      // file" if its own host can't expose it (caught below with a
      // clearer message). See the note on the hasDevKvm removal above —
      // probing the Node host is the wrong check on Docker Desktop, where
      // /dev/kvm lives in the daemon's VM, not on the Windows/Mac host.
      const devices: Array<{ PathOnHost: string; PathInContainer: string; CgroupPermissions: string }> = [
        { PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' },
      ];
      // Intentionally NOT auto-passing /dev/dri. It does nothing useful for
      // budtmo's default `-gpu swiftshader_indirect` (software rendering),
      // and on Docker Desktop WSL2 — where /dev/dri exists thanks to WSLg
      // — its presence in HostConfig.Devices makes the nvidia GPU prestart
      // hook fire and fail with "WSL environment detected but no adapters
      // were found". The hasDevDri() probe stays so a future opt-in
      // config flag can light it up for users who actually want hardware
      // graphics.
      void hasDevDri;
      // We deliberately do NOT request the NVIDIA device. budtmo's default
      // emulator command uses `-gpu swiftshader_indirect` (software
      // rendering), so the GPU is unused either way; and on Docker Desktop
      // WSL2 the nvidia-container runtime is sometimes "available" but the
      // adapter probe fails at container-start time with:
      //   "runc create failed: nvidia-container-cli: initialization error:
      //   WSL environment detected but no adapters were found"
      // Users who genuinely need GPU passthrough can opt in via a future
      // spec.config.gpu='nvidia' option; until then we keep create simple.
      const deviceRequests: any[] = [];
      // hasNvidia is still detected for future use (advanced opt-in) — read it
      // so the typecheck doesn't complain about unused options.
      void hasNvidia;

      // Materialize the image if it isn't local yet. Docker's createContainer
      // API does NOT auto-pull (unlike `docker run`), so a first-time user
      // would otherwise see "No such image" from the daemon. ~8GB download.
      await ensureImageLocal(d, image, opts?.onPullProgress);

      log(`Creating docker-android container "${spec.displayName}" image=${image} ram=${ramMb}MB arch=${arch}`);
      let container: any;
      try {
        container = await d.createContainer({
          Image: image,
          name: `darkride-${spec.displayName}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
          Labels: {
            [LABEL_KEY]: 'true',
            'darkride.android_version': androidVersion,
            'darkride.arch': arch,
          },
          // EMULATOR_DEVICE must be a name avdmanager recognises (see
          // `avdmanager list device`). Budtmo's whitelist includes
          // "Samsung Galaxy S10" but the current Android SDK ships only a
          // Pixel/Nexus-flavoured device list — Samsung profiles got dropped.
          // Pixel 8 is both budtmo-whitelisted and avdmanager-resolvable.
          Env: [
            `EMULATOR_DEVICE=Pixel 8`,
            `RAM_MB=${ramMb}`,
            // Match the Xvfb desktop size to the Pixel 8's native portrait
            // resolution so the VNC stream is just the emulator surface,
            // not a 1600x900 Linux desktop with the emulator floating in
            // the middle of it (budtmo's default). 1080x2400 is Pixel 8's
            // pixel resolution; the emulator window fills the desktop and
            // the noVNC client renders only the framebuffer we care about.
            // If we ever support multiple device profiles, this needs to
            // be looked up from EMULATOR_DEVICE.
            'SCREEN_WIDTH=1080',
            'SCREEN_HEIGHT=2400',
            // `-no-skin` drops the Android emulator's phone-bezel "skin"
            // (the device frame rendered around the actual screen). Without
            // it the VNC stream shows a phone-shaped window-within-the-
            // window — useful when you want to demo on a real device, but
            // pure overhead for our headless-control use case.
            //
            // `-grpc <port>` starts the emulator's gRPC bridge (EmulatorController
            // + Rtc/JSEP) — the WebRTC video + input path — unauthenticated,
            // bound to all interfaces (see GRPC_PORT note). Published to host
            // loopback below.
            `EMULATOR_ADDITIONAL_ARGS=-no-skin -grpc ${GRPC_PORT}`,
            // Disable nvidia-container-cli's legacy mode entirely. When the
            // nvidia-container-toolkit is installed in the host environment
            // (e.g. Docker Desktop with GPU support enabled on Windows/WSL),
            // it injects a prestart hook into runc itself that fires for
            // EVERY container start, regardless of HostConfig.Runtime.
            // Without a usable GPU passthrough (the common case on WSL),
            // the hook fails:
            //   "Auto-detected mode as 'legacy' nvidia-container-cli:
            //   initialization error: WSL environment detected but no
            //   adapters were found"
            // Setting NVIDIA_VISIBLE_DEVICES=void makes the hook a no-op
            // before it touches the adapter probe.
            'NVIDIA_VISIBLE_DEVICES=void',
          ],
          ExposedPorts: { '5555/tcp': {}, '5900/tcp': {}, [`${GRPC_PORT}/tcp`]: {} },
          HostConfig: {
            PortBindings: {
              '5555/tcp': [{ HostPort: '0' /* docker picks free port */ }],
              // 5900: budtmo's raw VNC. Bound to loopback so only the
              // DarkRide process can reach it; the browser talks to the
              // /ws/vnc proxy which bridges to this port. See spec
              // 2026-05-29-emulator-vnc-streaming-design.md §Architecture.
              '5900/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }],
              // GRPC_PORT: the emulator's gRPC (EmulatorController + Rtc).
              // Loopback-only on the host; the DarkRide grpc-web bridge is the
              // sole reader. See the GRPC_PORT note for the no-auth rationale.
              [`${GRPC_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }],
            },
            Devices: devices,
            DeviceRequests: deviceRequests.length > 0 ? deviceRequests : undefined,
            // Force the default OCI runtime explicitly. Without this, daemons
            // configured with `default-runtime: nvidia` (some Docker Desktop
            // WSL installs ship this way) invoke the nvidia-container prestart
            // hook for every container — which fails at start with
            // "WSL environment detected but no adapters were found" if no GPU
            // is actually passthrough'd. Setting Runtime here bypasses that.
            Runtime: 'runc',
          },
        });
      } catch (e: any) {
        // The daemon rejects the create with a "no such file" message when
        // it can't expose /dev/kvm — typically on Mac, on a Windows host
        // without Hyper-V virt enabled for WSL2, or on a Linux box where
        // KVM isn't loaded. Software emulation is not a useful fallback for
        // budtmo's image, so surface an actionable error rather than
        // silently spawning a container that will exit within seconds.
        const msg = String(e?.message ?? e);
        if (/\/dev\/kvm/i.test(msg) && /no such file|not found|cannot find/i.test(msg)) {
          throw new Error(
            'Docker daemon cannot expose /dev/kvm — Android emulator requires hardware virtualization. ' +
            'On Docker Desktop, enable nested virtualization for the WSL2 / Linux VM. ' +
            `On Linux hosts, ensure kvm modules are loaded. (Underlying error: ${msg})`,
          );
        }
        throw e;
      }

      return {
        id: container.id,
        displayName: spec.displayName,
        state: 'created',
        spawnedByDarkride: true,
        // `metadata` is what the UI displays AND what the API's auto-recreate
        // path passes back into createInstance when a container needs to be
        // rebuilt (budtmo's image can't `docker start` after first exit).
        // Include the original config field names so `spec.config` round-trips
        // cleanly through the spawnMetadata column.
        metadata: { image, androidVersion, architecture: arch, ramMb, arch },
      };
    },

    async startInstance(id: string): Promise<RunningInstance> {
      const container = d.getContainer(id);
      await container.start();
      const info = await container.inspect();
      const adbPortStr = info?.NetworkSettings?.Ports?.['5555/tcp']?.[0]?.HostPort;
      if (!adbPortStr) {
        // Don't leak a running container behind a failed port lookup.
        await container.stop({ t: 5 }).catch(() => { /* best effort */ });
        throw new Error(`Container ${id} started but no host port was bound to 5555/tcp`);
      }
      const adbPort = Number(adbPortStr);
      const serial = `localhost:${adbPort}`;
      log(`docker-android container ${id} started, host port ${adbPort} bound to 5555/tcp; waiting for adbd...`);
      // The container started, but the Android emulator inside takes 30-120s
      // to cold-boot. Retry adb connect, then poll sys.boot_completed until
      // Android is actually usable. Without this loop, the API returned 500
      // immediately after the docker call and clients had to retry the whole
      // create+start cycle.
      const deadline = Date.now() + bootTimeoutMs;
      let connected = false;
      let connectAttempts = 0;
      while (Date.now() < deadline) {
        connectAttempts++;
        if (await adbConnect(adbPort)) { connected = true; break; }
        // Every ~30s, emit a heartbeat so CI logs / users can see we're
        // still alive and how long we've been waiting. This is the loudest
        // signal of "the emulator isn't booting" — silence is the failure mode.
        if (connectAttempts % 6 === 0) {
          const elapsed = Math.round((Date.now() - (deadline - bootTimeoutMs)) / 1000);
          log(`docker-android still waiting for adbd on ${serial} (attempt ${connectAttempts}, ${elapsed}s elapsed) — checking container is alive`);
          const live = await container.inspect().catch(() => null);
          if (!live?.State?.Running) {
            logError(`Container ${id} has exited while we were waiting for adbd (state: ${JSON.stringify(live?.State)})`);
            throw new Error(`Container ${id} exited before adbd came up (state=${live?.State?.Status ?? 'unknown'}, exitCode=${live?.State?.ExitCode})`);
          }
        }
        await new Promise((r) => setTimeout(r, bootRetryIntervalMs));
      }
      if (!connected) {
        await container.stop({ t: 5 }).catch(() => { /* best effort */ });
        throw new Error(`adb failed to connect to ${serial} within ${bootTimeoutMs}ms (container ${id}, ${connectAttempts} attempts)`);
      }
      log(`docker-android adbd ready on ${serial} after ${connectAttempts} attempt(s); waiting for Android sys.boot_completed=1...`);
      let bootAttempts = 0;
      while (Date.now() < deadline) {
        bootAttempts++;
        if (await bootCompleted(serial)) {
          log(`docker-android container ${id} booted (serial=${serial}, ${connectAttempts} connect attempts, ${bootAttempts} boot polls)`);
          return { id, serial };
        }
        if (bootAttempts % 6 === 0) {
          log(`docker-android still waiting for sys.boot_completed=1 on ${serial} (poll ${bootAttempts})`);
        }
        await new Promise((r) => setTimeout(r, bootRetryIntervalMs));
      }
      await container.stop({ t: 5 }).catch(() => { /* best effort */ });
      throw new Error(`Android boot did not complete on ${serial} within ${bootTimeoutMs}ms (container ${id})`);
    },

    async stopInstance(id: string): Promise<void> {
      const container = d.getContainer(id);
      try {
        await container.stop({ t: 10 });
      } catch (e: any) {
        // graceful stop failed — fall back to kill via remove
        logError(`docker stop ${id} failed: ${e.message}; container may need manual cleanup`);
      }
    },

    async deleteInstance(id: string): Promise<void> {
      const container = d.getContainer(id);
      const info = await container.inspect();
      if (info?.State?.Running) {
        throw new Error(`Container ${id} is running — stop it first`);
      }
      await container.remove();
    },

    async getVncEndpoint(id: string): Promise<{ host: string; port: number }> {
      const container = d.getContainer(id);
      const info = await container.inspect();
      if (!info?.State?.Running) {
        throw new Error(`Container ${id} is not running — cannot resolve VNC endpoint`);
      }
      const portStr = info?.NetworkSettings?.Ports?.['5900/tcp']?.[0]?.HostPort;
      if (!portStr) {
        throw new Error(`Container ${id} has no host binding for 5900/tcp — VNC unavailable`);
      }
      return { host: '127.0.0.1', port: Number(portStr) };
    },

    async getGrpcEndpoint(id: string): Promise<{ host: string; port: number; token?: string }> {
      const container = d.getContainer(id);
      const info = await container.inspect();
      if (!info?.State?.Running) {
        throw new Error(`Container ${id} is not running — cannot resolve gRPC endpoint`);
      }
      const portStr = info?.NetworkSettings?.Ports?.[`${GRPC_PORT}/tcp`]?.[0]?.HostPort;
      if (!portStr) {
        throw new Error(`Container ${id} has no host binding for ${GRPC_PORT}/tcp — emulator gRPC unavailable`);
      }
      // No token: the emulator gRPC runs unauthenticated on host loopback (see
      // the GRPC_PORT note). The grpc-web bridge is the access gate.
      return { host: '127.0.0.1', port: Number(portStr) };
    },

    getNetworkConfig(_id: string): NetworkConfig {
      // Emulators use plain HTTP forward-proxy mode (mitmproxy on host,
      // reached via adb reverse from inside the emulator) — there's no
      // Magisk root for the WireGuard tunnel path, and adb root + a user
      // CA gets the chain working without /system or APEX gymnastics.
      // See CaptureSessionManager's docker-android branch.
      return { mode: 'emu-http-proxy' };
    },

    async getCreateFormSchema(): Promise<CreateFormSchema> {
      return {
        fields: [
          { key: 'androidVersion', label: 'Android version', type: 'select', required: true, default: '14', options: [
            { value: '14', label: '14.0 (API 34) — recommended' },
            { value: '13', label: '13.0 (API 33)' },
            { value: '12', label: '12.0 (API 31)' },
          ] },
          { key: 'architecture', label: 'Architecture', type: 'select', required: true, default: 'x86_64', options: [
            { value: 'x86_64', label: 'x86_64 (recommended for KVM hosts)' },
            { value: 'arm64', label: 'arm64' },
          ] },
          { key: 'ramMb', label: 'RAM (MB)', type: 'number', required: true, default: 2048,
            min: 1024, max: 8192, step: 256,
            help: 'Pixel 8 baseline is 2 GB. Heavy apps may need 4 GB.' },
        ],
      };
    },
  };
}
