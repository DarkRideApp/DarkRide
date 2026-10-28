import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { deviceInstances, devices } from '../../db/schema';
import { createDeviceDirectory } from './device-directory';

describe('createDeviceDirectory', () => {
  it('lists online devices with a display name from the devices table', () => {
    const db = createTestDb([deviceInstances, devices]);
    db.insert(devices).values([{ id: 'A', name: 'Desk phone' }, { id: 'B', model: 'Pixel 7' }, { id: 'C' }]).run();
    const dir = createDeviceDirectory(
      { getOnlineDeviceIds: () => ['A', 'B', 'C', 'D'], onDeviceOnline: vi.fn(), onDeviceOffline: vi.fn() },
      db,
    );
    expect(dir.listOnlineAndroid()).toEqual([
      { id: 'A', name: 'Desk phone' },
      { id: 'B', name: 'Pixel 7' },
      { id: 'C', name: null },
      { id: 'D', name: null },
    ]);
  });

  it('forwards the online and offline subscriptions', () => {
    const onDeviceOnline = vi.fn();
    const onDeviceOffline = vi.fn();
    const dir = createDeviceDirectory(
      { getOnlineDeviceIds: () => [], onDeviceOnline, onDeviceOffline },
      createTestDb([deviceInstances, devices]),
    );
    const fn = () => {};
    dir.onOnline(fn);
    dir.onOffline(fn);
    expect(onDeviceOnline).toHaveBeenCalledWith(fn);
    expect(onDeviceOffline).toHaveBeenCalledWith(fn);
  });
});
