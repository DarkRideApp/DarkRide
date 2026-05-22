import { execFile as execFileCb, spawn as spawnCb } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import type {
  DeviceProvider, DeviceProviderInstance, NetworkConfig,
  ProviderAvailability, RunningInstance, CreateInstanceSpec, CreateFormSchema,
} from '@darkrideapp/plugin-sdk';
import { parseAvdList, parseSystemImageList } from './avd-helpers';
import { resolveAndroidBin, findAndroidSdkRoot } from './sdk-helpers';
import { createLoggers } from '../../logs';

const execFile = promisify(execFileCb);
const { log, error: logError } = createLoggers('avd');

/**
 * Injection-friendly options. Tests provide custom implementations of
 * host-dependent probes; production uses real net/adb calls.
 */
export interface AvdProviderOptions {
  pickFreePort?: () => number | Promise<number>;
  waitForAdbSerial?: (serial: string, timeoutMs: number) => Promise<boolean>;
}

/**
 * avd provider — full lifecycle on Google Android SDK. Detects the SDK
 * via `emulator` + `avdmanager` on PATH; lists, creates, starts, stops,
 * and deletes AVDs. See spec §6.2.
 *
 * Spawned AVDs flow back through the `adb-device` provider once adbd
 * binds — see DeviceManager dedup-by-serial logic.
 */
export function createAvdProvider(opts: AvdProviderOptions = {}): DeviceProvider {
  /** Tracks port assignments per spawn so stopInstance knows where to kill. */
  const portByName = new Map<string, number>();

  const pickFreePort = opts.pickFreePort ?? (async () => {
    return new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, () => {
        const port = (srv.address() as any).port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  });

  const waitForAdbSerial = opts.waitForAdbSerial ?? (async (serial: string, timeoutMs: number) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await execFile(resolveAndroidBin('adb'), ['devices'], { timeout: 5000 });
        if (stdout.includes(`${serial}\tdevice`)) return true;
      } catch (e: any) {
        logError(`waitForAdbSerial adb devices failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  });

  return {
    id: 'avd',
    displayName: 'Android Virtual Device (AVD)',

    async isAvailable(): Promise<ProviderAvailability> {
      try {
        // Resolve via the SDK installer layout first (Android Studio
        // defaults — ANDROID_HOME / %LOCALAPPDATA%\Android\Sdk / etc.),
        // falling back to a PATH lookup. This lets Windows/macOS users
        // with a fresh Android Studio install work without adding the
        // SDK to PATH manually.
        await execFile(resolveAndroidBin('emulator'), ['-help'], { timeout: 5000 });
        await execFile(resolveAndroidBin('avdmanager'), ['--help'], { timeout: 5000 });
        return { available: true };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          const sdk = findAndroidSdkRoot();
          return {
            available: false,
            reason: sdk
              ? `emulator and/or avdmanager not found under detected SDK (${sdk})`
              : 'Android SDK not found — neither $ANDROID_HOME nor any standard install location resolves',
            installHint: sdk
              ? `Found SDK at ${sdk} but missing tools. Open Android Studio's SDK Manager and install "Android Emulator" + "Android SDK Command-line Tools (latest)".`
              : 'Install Android Studio (https://developer.android.com/studio). On Windows the installer doesn\'t add the SDK to PATH; DarkRide will pick it up from $ANDROID_HOME or %LOCALAPPDATA%\\Android\\Sdk automatically once installed.',
          };
        }
        return { available: false, reason: err.message };
      }
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      try {
        const { stdout } = await execFile(resolveAndroidBin('avdmanager'), ['list', 'avd'], { timeout: 10000 });
        const entries = parseAvdList(stdout);
        return entries.map((e) => ({
          id: e.name,
          displayName: e.name,
          state: portByName.has(e.name) ? 'running' : 'stopped',
          serial: portByName.has(e.name) ? `emulator-${portByName.get(e.name)}` : undefined,
          spawnedByDarkride: false, // AVDs created in Studio also show up
          metadata: { device: e.device, androidVersion: e.androidVersion, apiLevel: e.apiLevel, abi: e.abi },
        }));
      } catch (e: any) {
        logError(`avdmanager list avd failed: ${e.message}`);
        return [];
      }
    },

    async createInstance(spec: CreateInstanceSpec): Promise<DeviceProviderInstance> {
      const sysImage = String(spec.config.systemImagePackage);
      const device = String(spec.config.deviceProfile ?? 'pixel_8');
      log(`Creating AVD "${spec.displayName}" with ${sysImage} (device profile: ${device})`);
      await execFile(resolveAndroidBin('avdmanager'), ['create', 'avd', '-n', spec.displayName, '-k', sysImage, '-d', device], { timeout: 60_000 });
      return {
        id: spec.displayName,
        displayName: spec.displayName,
        state: 'created',
        spawnedByDarkride: true,
        metadata: { systemImage: sysImage, deviceProfile: device },
      };
    },

    async startInstance(id: string): Promise<RunningInstance> {
      const port = await pickFreePort();
      portByName.set(id, port);
      const serial = `emulator-${port}`;
      log(`Starting AVD "${id}" on port ${port}`);
      const child = spawnCb(resolveAndroidBin('emulator'), ['-avd', id, '-no-window', '-port', String(port)], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      const ok = await waitForAdbSerial(serial, 60_000);
      if (!ok) {
        portByName.delete(id);
        throw new Error(`AVD "${id}" did not become reachable via adb within 60s`);
      }
      return { id, serial };
    },

    async stopInstance(id: string): Promise<void> {
      const port = portByName.get(id);
      if (!port) {
        // Not tracked — maybe started outside DarkRide. We can't reliably kill it.
        return;
      }
      const serial = `emulator-${port}`;
      try {
        await execFile(resolveAndroidBin('adb'), ['-s', serial, 'emu', 'kill'], { timeout: 10_000 });
      } catch (e: any) {
        logError(`adb emu kill ${serial} failed: ${e.message}`);
      }
      portByName.delete(id);
    },

    async deleteInstance(id: string): Promise<void> {
      if (portByName.has(id)) {
        throw new Error(`AVD "${id}" is running — stop it first`);
      }
      await execFile(resolveAndroidBin('avdmanager'), ['delete', 'avd', '-n', id], { timeout: 30_000 });
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'wireguard' };
    },

    async getCreateFormSchema(): Promise<CreateFormSchema> {
      // Read installed system images via sdkmanager if available.
      // Fall back to a small static set if sdkmanager isn't reachable.
      let imageOptions: Array<{ value: string; label: string }> = [
        { value: 'system-images;android-34;google_apis;x86_64', label: 'Android 14 (API 34) — Google APIs x86_64' },
      ];
      try {
        const { stdout } = await execFile(resolveAndroidBin('sdkmanager'), ['--list'], { timeout: 30_000 });
        const installed = parseSystemImageList(stdout).filter((s) => s.installed);
        if (installed.length > 0) {
          imageOptions = installed.map((s) => ({
            value: s.pkg,
            label: `Android API ${s.apiLevel} — ${s.tag} ${s.abi} (installed)`,
          }));
        }
      } catch (e: any) {
        logError(`sdkmanager --list failed (using fallback list): ${e.message}`);
      }
      return {
        fields: [
          { key: 'systemImagePackage', label: 'System image', type: 'select', required: true, options: imageOptions, help: 'Pick an installed Android system image. Install more via Android Studio or sdkmanager.' },
          { key: 'deviceProfile', label: 'Device profile', type: 'select', required: true, default: 'pixel_8', options: [
            { value: 'pixel_8', label: 'Pixel 8' },
            { value: 'pixel_tablet', label: 'Pixel Tablet' },
            { value: 'medium_phone', label: 'Generic medium phone' },
          ] },
        ],
      };
    },
  };
}
