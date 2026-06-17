import { eq } from 'drizzle-orm';
import { devices, automationSessions, capturedTraffic, websocketMessages } from '../db/schema';
import type { AppDatabase } from '../db/index';

/**
 * Remove a row from the `devices` table without tripping FOREIGN KEY
 * constraints on the three child tables (automation_sessions,
 * captured_traffic, websocket_messages) that reference devices.id with
 * no ON DELETE clause.
 *
 * The child rows are kept — they have forensic value beyond the lifetime
 * of any one device record — but their `device_id` is NULL'd so the
 * delete is permitted. Everything runs in a single transaction.
 *
 * Returns whether a row was actually deleted (false = no such device).
 */
export function forgetDeviceRow(db: AppDatabase, deviceId: string): boolean {
  const existing = db.select().from(devices).where(eq(devices.id, deviceId)).all()[0];
  if (!existing) return false;
  db.transaction((tx) => {
    tx.update(automationSessions).set({ deviceId: null }).where(eq(automationSessions.deviceId, deviceId)).run();
    tx.update(capturedTraffic).set({ deviceId: null }).where(eq(capturedTraffic.deviceId, deviceId)).run();
    tx.update(websocketMessages).set({ deviceId: null }).where(eq(websocketMessages.deviceId, deviceId)).run();
    tx.delete(devices).where(eq(devices.id, deviceId)).run();
  });
  return true;
}
