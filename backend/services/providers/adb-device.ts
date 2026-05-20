import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { DeviceProvider, DeviceProviderInstance, ProviderAvailability, NetworkConfig, RunningInstance } from '@darkrideapp/plugin-sdk';

const execFile = promisify(execFileCb);

/**
 * adb-device — observes any Android device reachable via `adb devices`. Includes
 * physical phones, BYOE AVDs, Genymotion, BlueStacks, custom containers. Does
 * NOT spawn or kill; pure passive observer. See spec §6.1.
 */
export function createAdbDeviceProvider(): DeviceProvider {
  return {
    id: 'adb-device',
    displayName: 'ADB Device',

    async isAvailable(): Promise<ProviderAvailability> {
      try {
        await execFile('adb', ['devices'], { timeout: 5000 });
        return { available: true };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            available: false,
            reason: 'adb binary not found on PATH',
            installHint: 'Install Android platform-tools (https://developer.android.com/tools/releases/platform-tools) and ensure adb is on PATH.',
          };
        }
        return { available: false, reason: err.message ?? String(err) };
      }
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      const { stdout } = await execFile('adb', ['devices'], { timeout: 5000 });
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      // Skip the "List of devices attached" header.
      const rows = lines.filter((l) => !l.startsWith('List of'));
      const out: DeviceProviderInstance[] = [];
      for (const row of rows) {
        // Each row is "<serial>\t<state>" — state is one of: device, offline, unauthorized, ...
        const [serial, adbState] = row.split(/\s+/);
        if (!serial) continue;
        out.push({
          id: serial,
          displayName: serial,
          serial,
          state: adbState === 'device' ? 'running' : 'stopped',
          spawnedByDarkride: false,
        });
      }
      return out;
    },

    async startInstance(id: string): Promise<RunningInstance> {
      // adb-device does not spawn. If the caller asked for "start", the
      // device must already exist; we just confirm the serial.
      return { id, serial: id };
    },

    async stopInstance(_id: string): Promise<void> {
      // adb-device does not kill. DarkRide stops watching at the
      // orchestrator level; the underlying process belongs to the user.
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'wireguard' };
    },
  };
}
