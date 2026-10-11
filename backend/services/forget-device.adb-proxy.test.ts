import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils/create-test-db';
import { adbProxyDevices, devices } from '../db/schema';
import { forgetDeviceRow } from './forget-device';

describe('forgetDeviceRow with an ADB proxy port', () => {
  it('removes the device and its proxy row without a foreign key error', () => {
    const db = createTestDb(undefined, { foreignKeys: true });
    db.insert(devices).values({ id: 'SER1' }).run();
    db.insert(adbProxyDevices).values({ deviceId: 'SER1', port: 6500, createdAt: new Date() }).run();
    expect(forgetDeviceRow(db, 'SER1')).toBe(true);
    expect(db.select().from(devices).where(eq(devices.id, 'SER1')).all()).toHaveLength(0);
    expect(db.select().from(adbProxyDevices).all()).toHaveLength(0);
  });

  it('leaves other devices proxy rows alone', () => {
    const db = createTestDb(undefined, { foreignKeys: true });
    db.insert(devices).values([{ id: 'A' }, { id: 'B' }]).run();
    db.insert(adbProxyDevices).values([
      { deviceId: 'A', port: 6500, createdAt: new Date() },
      { deviceId: 'B', port: 6501, createdAt: new Date() },
    ]).run();
    forgetDeviceRow(db, 'A');
    expect(db.select().from(adbProxyDevices).all().map((r) => r.deviceId)).toEqual(['B']);
  });
});
