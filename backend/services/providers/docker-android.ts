import { existsSync } from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type {
  CreateInstanceSpec, DeviceProvider, DeviceProviderInstance, NetworkConfig,
  ProviderAvailability, RunningInstance, CreateFormSchema,
} from '@darkrideapp/plugin-sdk';
import { type DockerLike, detectDockerDaemon, listDarkrideContainers } from './docker-helpers';
import { createLoggers } from '../../logs';

const execFile = promisify(execFileCb);
const { log, error: logError } = createLoggers('docker-android');

const IMAGE_PREFIX = 'ghcr.io/darkrideapp/docker-android';
const LABEL_KEY = 'darkride.emulator';

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
  hasDevKvm?: () => boolean;
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
  // exits within seconds.
  const hasDevKvm = opts.hasDevKvm ?? (() => existsSync('/dev/kvm'));
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

    async createInstance(spec: CreateInstanceSpec): Promise<DeviceProviderInstance> {
      const androidVersion = String(spec.config.androidVersion ?? '14');
      const arch = String(spec.config.architecture ?? 'x86_64');
      const ramMb = Number(spec.config.ramMb ?? 2048);
      const image = `${IMAGE_PREFIX}:${androidVersion}`;

      // GPU auto-detect — see spec §6.3.
      const devices: Array<{ PathOnHost: string; PathInContainer: string; CgroupPermissions: string }> = [];
      let deviceRequests: any[] = [];
      // /dev/kvm: required for in-container Android emulator. Without it,
      // the container exits within seconds (no software-emulation fallback
      // worth attempting — it would never boot in CI's time budget).
      if (hasDevKvm()) {
        devices.push({ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' });
      }
      if (hasDevDri()) {
        devices.push({ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' });
      }
      const nvidiaAvailable = await Promise.resolve(hasNvidia());
      if (nvidiaAvailable) {
        deviceRequests = [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }];
      }

      log(`Creating docker-android container "${spec.displayName}" image=${image} ram=${ramMb}MB arch=${arch}`);
      const container: any = await d.createContainer({
        Image: image,
        name: `darkride-${spec.displayName}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
        Labels: {
          [LABEL_KEY]: 'true',
          'darkride.android_version': androidVersion,
          'darkride.arch': arch,
        },
        Env: [`EMULATOR_DEVICE=Samsung Galaxy S10`, `RAM_MB=${ramMb}`],
        ExposedPorts: { '5555/tcp': {} },
        HostConfig: {
          PortBindings: { '5555/tcp': [{ HostPort: '0' /* docker picks free port */ }] },
          Devices: devices.length > 0 ? devices : undefined,
          DeviceRequests: deviceRequests.length > 0 ? deviceRequests : undefined,
        },
      });

      return {
        id: container.id,
        displayName: spec.displayName,
        state: 'created',
        spawnedByDarkride: true,
        metadata: { image, androidVersion, arch, ramMb },
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
      // The container started, but the Android emulator inside takes 30-120s
      // to cold-boot. Retry adb connect, then poll sys.boot_completed until
      // Android is actually usable. Without this loop, the API returned 500
      // immediately after the docker call and clients had to retry the whole
      // create+start cycle.
      const deadline = Date.now() + bootTimeoutMs;
      let connected = false;
      while (Date.now() < deadline) {
        if (await adbConnect(adbPort)) { connected = true; break; }
        await new Promise((r) => setTimeout(r, bootRetryIntervalMs));
      }
      if (!connected) {
        await container.stop({ t: 5 }).catch(() => { /* best effort */ });
        throw new Error(`adb failed to connect to ${serial} within ${bootTimeoutMs}ms (container ${id})`);
      }
      while (Date.now() < deadline) {
        if (await bootCompleted(serial)) {
          log(`docker-android container ${id} booted (serial=${serial})`);
          return { id, serial };
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

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'wireguard' };
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
          { key: 'ramMb', label: 'RAM (MB)', type: 'number', required: true, default: 2048 },
        ],
      };
    },
  };
}
