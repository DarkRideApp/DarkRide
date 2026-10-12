import { eq } from 'drizzle-orm';
import { devices } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import type { DeviceManager } from '../device-manager';

export interface DeviceDirectory {
  listOnlineAndroid(): Array<{ id: string; name: string | null }>;
  onOnline(fn: (id: string) => void): void;
  onOffline(fn: (id: string) => void): void;
}

type DirectorySource = Pick<DeviceManager, 'getOnlineDeviceIds' | 'onDeviceOnline' | 'onDeviceOffline'>;

export function createDeviceDirectory(source: DirectorySource, db: AppDatabase): DeviceDirectory {
  return {
    listOnlineAndroid: () =>
      source.getOnlineDeviceIds().map((id) => {
        const row = db.select().from(devices).where(eq(devices.id, id)).get();
        return { id, name: row?.name ?? row?.model ?? null };
      }),
    onOnline: (fn) => source.onDeviceOnline(fn),
    onOffline: (fn) => source.onDeviceOffline(fn),
  };
}
