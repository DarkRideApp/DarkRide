import { asc, eq } from 'drizzle-orm';
import { adbProxyDevices } from '../../db/schema';
import type { AppDatabase } from '../../db/index';

export type ProxyDeviceRow = typeof adbProxyDevices.$inferSelect;

export class PortError extends Error {
  constructor(readonly code: 'out-of-range' | 'in-use', message: string) {
    super(message);
    this.name = 'PortError';
  }
}

export class PortAllocator {
  constructor(
    private readonly db: AppDatabase,
    private readonly range: () => { start: number; end: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(deviceId: string): ProxyDeviceRow | undefined {
    return this.db.select().from(adbProxyDevices).where(eq(adbProxyDevices.deviceId, deviceId)).get();
  }

  all(): ProxyDeviceRow[] {
    return this.db.select().from(adbProxyDevices).orderBy(asc(adbProxyDevices.createdAt), asc(adbProxyDevices.port)).all();
  }

  /** The device's row, creating it with the lowest free port in range if it has none. */
  ensure(deviceId: string): ProxyDeviceRow | { error: 'range-full' } {
    const existing = this.get(deviceId);
    if (existing) return existing;
    const { start, end } = this.range();
    const used = new Set(this.all().map((r) => r.port));
    for (let port = start; port <= end; port++) {
      if (used.has(port)) continue;
      this.db.insert(adbProxyDevices).values({ deviceId, port, enabled: true, createdAt: this.now() }).run();
      return this.get(deviceId)!;
    }
    return { error: 'range-full' };
  }

  setPort(deviceId: string, port: number): ProxyDeviceRow {
    const { start, end } = this.range();
    if (!Number.isInteger(port) || port < start || port > end) {
      throw new PortError('out-of-range', `port must be between ${start} and ${end}`);
    }
    const holder = this.all().find((r) => r.port === port);
    if (holder && holder.deviceId !== deviceId) throw new PortError('in-use', `port ${port} is used by another device`);
    this.db.update(adbProxyDevices).set({ port }).where(eq(adbProxyDevices.deviceId, deviceId)).run();
    return this.get(deviceId)!;
  }

  setEnabled(deviceId: string, enabled: boolean): ProxyDeviceRow | undefined {
    if (!this.get(deviceId)) return undefined;
    this.db.update(adbProxyDevices).set({ enabled }).where(eq(adbProxyDevices.deviceId, deviceId)).run();
    return this.get(deviceId);
  }
}
