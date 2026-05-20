import type { DeviceProvider, DeviceProviderInstance, NetworkConfig, ProviderAvailability, RunningInstance } from '@darkrideapp/plugin-sdk';

/**
 * Minimal surface of IosDeviceManager used by this provider. The real
 * class (`backend/services/ios-device-manager.ts`) is much wider — we
 * only need what's here. Typed as an interface so tests can mock without
 * instantiating.
 */
export interface IosDeviceManagerLike {
  isAvailable(): boolean;
  getDevices(): Promise<Array<{ udid: string; name?: string | null; isOnline?: boolean }>>;
}

/**
 * ios-device — wraps existing `IosDeviceManager` (Python `ios_bridge.py`
 * + `usbmuxd`). Physical iOS devices over USB only. Limited capture
 * surface today (see spec §6.4). Preserves existing iOS behaviour
 * exactly — this provider exists so iOS becomes a first-class
 * `DeviceProvider` instead of a special case in DeviceManager.
 */
export function createIosDeviceProvider(iosManager: IosDeviceManagerLike): DeviceProvider {
  return {
    id: 'ios-device',
    displayName: 'iOS Device',

    async isAvailable(): Promise<ProviderAvailability> {
      const ok = iosManager.isAvailable();
      if (ok) return { available: true };
      return {
        available: false,
        reason: 'usbmuxd / libimobiledevice not reachable',
        installHint: 'Install libimobiledevice + start usbmuxd. On Linux: `sudo apt install libimobiledevice-utils` and `systemctl --user start usbmuxd2.service`.',
      };
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      const devs = await iosManager.getDevices();
      return devs.map((d) => ({
        id: d.udid,
        displayName: d.name ?? d.udid,
        serial: d.udid,
        state: d.isOnline === false ? 'stopped' : 'running',
        spawnedByDarkride: false,
      }));
    },

    async startInstance(id: string): Promise<RunningInstance> {
      // iOS devices are physical USB-tethered; no spawn. Confirm the serial.
      return { id, serial: id };
    },

    async stopInstance(_id: string): Promise<void> {
      // No-op. The capture-session layer handles markBusy/markIdle separately.
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'ios-bridge' };
    },
  };
}
