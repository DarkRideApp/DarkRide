import { describe, it, expect, vi } from 'vitest';
import { createIosDeviceProvider, type IosDeviceManagerLike } from '../ios-device';

function makeMockIosManager(devices: Array<{ udid: string; name?: string | null; isOnline?: boolean }> = []): IosDeviceManagerLike {
  return {
    getDevices: vi.fn().mockResolvedValue(devices),
    isAvailable: vi.fn().mockReturnValue(true),
  };
}

describe('ios-device provider', () => {
  it('isAvailable proxies to IosDeviceManager.isAvailable()', async () => {
    const mgr = makeMockIosManager();
    const p = createIosDeviceProvider(mgr);
    const av = await p.isAvailable();
    expect(av.available).toBe(true);
  });

  it('isAvailable surfaces a hint when usbmuxd is unreachable', async () => {
    const mgr = makeMockIosManager();
    (mgr.isAvailable as any).mockReturnValue(false);
    const p = createIosDeviceProvider(mgr);
    const av = await p.isAvailable();
    expect(av.available).toBe(false);
    expect(av.installHint).toMatch(/usbmuxd|libimobiledevice/i);
  });

  it('listInstances proxies to IosDeviceManager and maps to DeviceProviderInstance', async () => {
    const mgr = makeMockIosManager([
      { udid: '00008101-001234567890ABCDE', name: "Jamie's iPhone", isOnline: true },
    ]);
    const p = createIosDeviceProvider(mgr);
    const instances = await p.listInstances();
    expect(instances).toEqual([
      {
        id: '00008101-001234567890ABCDE',
        displayName: "Jamie's iPhone",
        serial: '00008101-001234567890ABCDE',
        state: 'running',
        spawnedByDarkride: false,
      },
    ]);
  });

  it('maps isOnline=false to state=stopped', async () => {
    const mgr = makeMockIosManager([
      { udid: 'UUID-OFFLINE', name: null, isOnline: false },
    ]);
    const p = createIosDeviceProvider(mgr);
    const instances = await p.listInstances();
    expect(instances[0]).toMatchObject({ id: 'UUID-OFFLINE', state: 'stopped' });
  });

  it('getNetworkConfig returns ios-bridge mode (not wireguard)', () => {
    const p = createIosDeviceProvider(makeMockIosManager());
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'ios-bridge' });
  });

  it('startInstance + stopInstance are no-ops at provider level', async () => {
    const mgr = makeMockIosManager();
    const p = createIosDeviceProvider(mgr);
    await expect(p.startInstance('uuid')).resolves.toEqual({ id: 'uuid', serial: 'uuid' });
    await expect(p.stopInstance('uuid')).resolves.toBeUndefined();
  });
});
