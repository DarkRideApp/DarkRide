import { eq } from 'drizzle-orm';
import { deviceInstances } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { DeviceInstanceState } from '@darkrideapp/plugin-sdk';

export interface DeviceInstanceRow {
  id: number;
  providerId: string;
  runtimeId: string;
  displayName: string | null;
  serial: string | null;
  state: DeviceInstanceState;
  spawnedByDarkride: boolean;
  spawnMetadata: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: Date;
  lastStateAt: Date;
}

export interface DeviceInstanceInsert {
  providerId: string;
  runtimeId: string;
  displayName?: string | null;
  serial?: string | null;
  state: DeviceInstanceState;
  spawnedByDarkride: boolean;
  spawnMetadata?: Record<string, unknown> | null;
}

export class DeviceInstancesRepo {
  constructor(private db: AppDatabase) {}

  insert(input: DeviceInstanceInsert): DeviceInstanceRow {
    const now = new Date();
    const inserted = this.db.insert(deviceInstances).values({
      providerId: input.providerId,
      runtimeId: input.runtimeId,
      displayName: input.displayName ?? null,
      serial: input.serial ?? null,
      state: input.state,
      spawnedByDarkride: input.spawnedByDarkride,
      spawnMetadata: input.spawnMetadata ?? null,
      lastError: null,
      createdAt: now,
      lastStateAt: now,
    }).returning().all()[0];
    return inserted as DeviceInstanceRow;
  }

  /**
   * Transition an instance's state. When state='error', `lastError` is
   * stored alongside; on any other transition `lastError` is cleared so
   * stale messages don't linger across recoveries.
   */
  updateState(id: number, state: DeviceInstanceState, lastError?: string | null): void {
    this.db.update(deviceInstances)
      .set({
        state,
        lastError: state === 'error' ? (lastError ?? null) : null,
        lastStateAt: new Date(),
      })
      .where(eq(deviceInstances.id, id))
      .run();
  }

  /**
   * Persist the adb serial after `startInstance` resolves with the
   * provider-assigned host port. CaptureSessionManager looks up the
   * provider by serial so it can pick the right capture path
   * (emulator HTTP proxy vs physical-device WireGuard) — without
   * this the lookup misses and emulators get the physical-device flow.
   */
  updateSerial(id: number, serial: string | null): void {
    this.db.update(deviceInstances)
      .set({ serial, lastStateAt: new Date() })
      .where(eq(deviceInstances.id, id))
      .run();
  }

  getById(id: number): DeviceInstanceRow | undefined {
    return this.db.select().from(deviceInstances).where(eq(deviceInstances.id, id)).all()[0] as DeviceInstanceRow | undefined;
  }

  listByProvider(providerId: string): DeviceInstanceRow[] {
    return this.db.select().from(deviceInstances).where(eq(deviceInstances.providerId, providerId)).all() as DeviceInstanceRow[];
  }

  listAll(): DeviceInstanceRow[] {
    return this.db.select().from(deviceInstances).all() as DeviceInstanceRow[];
  }

  delete(id: number): void {
    this.db.delete(deviceInstances).where(eq(deviceInstances.id, id)).run();
  }
}
