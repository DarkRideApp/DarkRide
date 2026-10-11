import { asc, eq } from 'drizzle-orm';
import { adbProxyKeys } from '../../db/schema';
import type { AppDatabase } from '../../db/index';

export type KeyRecord = typeof adbProxyKeys.$inferSelect;
export type KeyStatus = KeyRecord['status'];

export interface DecisionInput {
  keyId: string;
  publicKey: string;
  comment: string;
  status: 'approved' | 'denied';
  ip: string;
  deviceId: string;
  userId: number | null;
}

export class KeyStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  findByKeyId(keyId: string): KeyRecord | undefined {
    return this.db.select().from(adbProxyKeys).where(eq(adbProxyKeys.keyId, keyId)).get();
  }

  findById(id: number): KeyRecord | undefined {
    return this.db.select().from(adbProxyKeys).where(eq(adbProxyKeys.id, id)).get();
  }

  list(): KeyRecord[] {
    return this.db.select().from(adbProxyKeys).orderBy(asc(adbProxyKeys.id)).all();
  }

  /** Approved keys that may reach this device; a null or empty allow-list means every device. */
  approvedFor(deviceId: string): KeyRecord[] {
    return this.db
      .select()
      .from(adbProxyKeys)
      .where(eq(adbProxyKeys.status, 'approved'))
      .all()
      .filter((r) => !r.deviceIds || r.deviceIds.length === 0 || r.deviceIds.includes(deviceId));
  }

  upsertDecision(input: DecisionInput): KeyRecord {
    const t = this.now();
    const existing = this.findByKeyId(input.keyId);
    if (existing) {
      this.db
        .update(adbProxyKeys)
        .set({
          status: input.status,
          comment: input.comment,
          lastSeenAt: t,
          lastSeenIp: input.ip,
          lastDeviceId: input.deviceId,
          decidedBy: input.userId,
          decidedAt: t,
        })
        .where(eq(adbProxyKeys.id, existing.id))
        .run();
    } else {
      this.db
        .insert(adbProxyKeys)
        .values({
          keyId: input.keyId,
          publicKey: input.publicKey,
          comment: input.comment,
          status: input.status,
          deviceIds: null,
          firstSeenAt: t,
          lastSeenAt: t,
          lastSeenIp: input.ip,
          lastDeviceId: input.deviceId,
          decidedBy: input.userId,
          decidedAt: t,
        })
        .run();
    }
    return this.findByKeyId(input.keyId)!;
  }

  setStatus(id: number, status: KeyStatus, userId: number | null): KeyRecord | undefined {
    if (!this.findById(id)) return undefined;
    this.db
      .update(adbProxyKeys)
      .set({ status, decidedBy: userId, decidedAt: this.now() })
      .where(eq(adbProxyKeys.id, id))
      .run();
    return this.findById(id);
  }

  setDeviceIds(id: number, ids: string[] | null): KeyRecord | undefined {
    if (!this.findById(id)) return undefined;
    this.db.update(adbProxyKeys).set({ deviceIds: ids }).where(eq(adbProxyKeys.id, id)).run();
    return this.findById(id);
  }

  touch(keyId: string, ip: string, deviceId: string): void {
    this.db
      .update(adbProxyKeys)
      .set({ lastSeenAt: this.now(), lastSeenIp: ip, lastDeviceId: deviceId })
      .where(eq(adbProxyKeys.keyId, keyId))
      .run();
  }

  forget(id: number): boolean {
    return this.db.delete(adbProxyKeys).where(eq(adbProxyKeys.id, id)).run().changes > 0;
  }
}
