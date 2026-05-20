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
 */
export interface DockerAndroidOptions {
  hasDevDri?: () => boolean;
  hasNvidia?: () => boolean | Promise<boolean>;
  adbConnect?: (port: number) => Promise<boolean>;
}

/**
 * docker-android provider — spawns Android emulators inside containers
 * built FROM budtmo/docker-android + darkride extras (wg-go, etc.).
 * See spec §6.3.
 */
export function createDockerAndroidProvider(d: DockerLike, opts: DockerAndroidOptions = {}): DeviceProvider {
  const hasDevDri = opts.hasDevDri ?? (() => existsSync('/dev/dri'));
  const hasNvidia = opts.hasNvidia ?? (async () => (await detectDockerDaemon(d)).nvidiaContainerToolkit === true);
  const adbConnect = opts.adbConnect ?? (async (port: number) => {
    try {
      await execFile('adb', ['connect', `localhost:${port}`], { timeout: 5000 });
      return true;
    } catch (e: any) {
      logError(`adb connect localhost:${port} failed: ${e.message}`);
      return false;
    }
  });

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
        throw new Error(`Container ${id} started but no host port was bound to 5555/tcp`);
      }
      const adbPort = Number(adbPortStr);
      const ok = await adbConnect(adbPort);
      if (!ok) {
        throw new Error(`adb failed to connect to localhost:${adbPort} (container ${id})`);
      }
      return { id, serial: `localhost:${adbPort}` };
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
