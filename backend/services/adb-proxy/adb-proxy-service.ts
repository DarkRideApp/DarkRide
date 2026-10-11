import type net from 'node:net';
import { eq, inArray } from 'drizzle-orm';
import { devices } from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { createLoggers } from '../../logs';
import type {
  ConnectionView, Counters, DeviceProxyState, DeviceStatusView, KeyView, PendingView, StatusSnapshot,
} from '../../../shared/types/adb-proxy';
import { fingerprintOf } from './adb-key';
import { KeyAuthGate, type GateEvent } from './auth-gate';
import type { DeviceDirectory } from './device-directory';
import { PreAuthLimiter } from './limits';
import { KeyStore } from './key-store';
import { DeviceListener, ListenError } from './listener';
import { foldMappedV4 } from './peer-key';
import { PendingRegistry, type PendingOptions } from './pending';
import { PortAllocator, PortError } from './port-allocator';
import { Session, type BackendConnector, type SessionEvent } from './session';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AdbProxySettings } from './settings';
import { createBudgetLog, onceEvery, type BudgetLog } from './throttle';

const { log, error: logError } = createLoggers('adb-proxy');

export type {
  ConnectionView, Counters, DeviceProxyState, DeviceStatusView, KeyView, PendingView, StatusSnapshot,
};

export interface AdbProxyServiceDeps {
  db: AppDatabase;
  directory: DeviceDirectory;
  backend: BackendConnector;
  broadcast?: (message: Record<string, unknown>) => void;
  advertisedHost?: () => string;
  pending?: PendingOptions;
  /** How often the online device list is compared with the service's own view; default 5000. */
  reconcileMs?: number;
  /** Window of the log budget for lines a peer without an approved key can provoke; default 60000. */
  logWindowMs?: number;
  /** Detail lines per window in that budget; default 5. */
  logMaxDetail?: number;
}

type Failure<E extends string> = { ok: false; error: E };
type Done = { ok: true };

const NOTIFY_DELAY_MS = 50;
const DEFAULT_RECONCILE_MS = 5000;
const DEFAULT_LOG_WINDOW_MS = 60_000;
const DEFAULT_LOG_MAX_DETAIL = 5;
const REFUSAL_LOG_LENGTH = 60;
const short = (keyId: string) => keyId.slice(0, 12);
// The service string comes from the client: keep printable ASCII only so it cannot forge or hide log lines.
const printable = (text: string) => text.slice(0, REFUSAL_LOG_LENGTH).replace(/[^\x20-\x7e]/g, '?');

export class AdbProxyService {
  private settings: AdbProxySettings = { ...DEFAULT_SETTINGS };
  private readonly keys: KeyStore;
  private readonly ports: PortAllocator;
  private readonly pending: PendingRegistry;
  private readonly gate: KeyAuthGate;
  private readonly limiter = new PreAuthLimiter();
  private readonly listeners = new Map<string, DeviceListener>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly deviceErrors = new Map<string, DeviceProxyState>();
  private readonly online = new Set<string>();
  private readonly sessions = new Set<Session>();
  private readonly counters: Counters = { connections: 0, approvals: 0, denials: 0, authFailures: 0, floodDrops: 0 };
  private started = false;
  private stopped = false;
  private startPromise: Promise<void> | null = null;
  private tail: Promise<void> | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly backend: BackendConnector;
  private readonly logBackendFailure = onceEvery(30_000, (message: string) => logError(message));
  private readonly logPresenceFailure = onceEvery(30_000, (message: string) => logError(message));
  // The log buffer is shared by the whole server. Lines a peer without an approved key can provoke draw on one
  // budget; refusals need an authenticated session, so they have a budget of their own.
  private readonly peerLog: BudgetLog;
  private readonly refusalLog: BudgetLog;
  private readonly trusted = new WeakSet<Session>();

  constructor(private readonly deps: AdbProxyServiceDeps) {
    const budget = () => createBudgetLog({
      windowMs: deps.logWindowMs ?? DEFAULT_LOG_WINDOW_MS,
      maxDetail: deps.logMaxDetail ?? DEFAULT_LOG_MAX_DETAIL,
      emit: log,
      onError: (e: any) => logError(`could not write to the log: ${e?.message ?? e}`),
    });
    this.peerLog = budget();
    this.refusalLog = budget();
    // A dead host ADB server is logged once per interval, not once per stream.
    this.backend = {
      openService: async (serial, service) => {
        try {
          return await deps.backend.openService(serial, service);
        } catch (e: any) {
          this.logBackendFailure(`ADB server request failed for ${serial}: ${e?.message ?? e}`);
          throw e;
        }
      },
      deviceBanner: async (serial) => {
        try {
          return await deps.backend.deviceBanner(serial);
        } catch (e: any) {
          this.logBackendFailure(`ADB server request failed for ${serial}: ${e?.message ?? e}`);
          throw e;
        }
      },
    };
    this.keys = new KeyStore(deps.db);
    this.ports = new PortAllocator(deps.db, () => ({ start: this.settings.portStart, end: this.settings.portEnd }));
    this.pending = new PendingRegistry({ ...deps.pending, onChange: () => this.notifyChanged() });
    this.gate = new KeyAuthGate(this.keys, this.pending, (e) => this.onGateEvent(e));
  }

  /** Call once per process: the directory has no way to unsubscribe, so a stopped instance cannot start again. A second call gets the first call's promise. */
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('AdbProxyService was stopped; create a new instance'));
    this.startPromise ??= this.begin().catch((e) => {
      this.startPromise = null;
      throw e;
    });
    return this.startPromise;
  }

  private async begin(): Promise<void> {
    const settings = loadSettings(this.deps.db);
    const present = this.deps.directory.listOnlineAndroid();
    this.started = true;
    this.settings = settings;
    for (const d of present) this.online.add(d.id);
    this.deps.directory.onOnline((id) => { if (this.started) void this.deviceOnline(id); });
    this.deps.directory.onOffline((id) => { if (this.started) this.deviceOffline(id); });
    // Events alone miss a device that flips to offline or unauthorized, so presence is also polled.
    this.reconcileTimer = setInterval(() => this.reconcile(), this.deps.reconcileMs ?? DEFAULT_RECONCILE_MS);
    this.reconcileTimer.unref?.();
    if (this.settings.enabled) await this.serialised(() => this.startAll());
  }

  /** Does not queue behind pending changes: those find the service stopped and bind nothing. */
  async stop(): Promise<void> {
    this.started = false;
    this.stopped = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const s of [...this.sessions]) s.destroy('service stopping');
    await this.stopAllDevices();
    this.peerLog.stop();
    this.refusalLog.stop();
    // Last, so each session's cancel() above ran against a live registry.
    this.pending.stop();
  }

  /** Runs lifecycle changes one at a time, in call order. A step that fails does not stop the ones after it. */
  private serialised<T>(step: () => Promise<T>): Promise<T> {
    const run = this.tail ? this.tail.then(step) : step();
    const settled = run.then(() => undefined, () => undefined);
    this.tail = settled;
    void settled.then(() => {
      if (this.tail === settled) this.tail = null;
    });
    return run;
  }

  snapshot(): StatusSnapshot {
    const rows = this.ports.all();
    const ids = [...new Set<string>([...this.online, ...rows.map((r) => r.deviceId)])].sort();
    const names = this.deviceNames(ids);
    return {
      enabled: this.settings.enabled,
      bindHost: this.settings.bindHost,
      portStart: this.settings.portStart,
      portEnd: this.settings.portEnd,
      advertisedHost: this.deps.advertisedHost?.() ?? '',
      devices: ids.map((id) => {
        const row = rows.find((r) => r.deviceId === id);
        const online = this.online.has(id);
        return {
          deviceId: id,
          name: names.get(id) ?? null,
          port: row?.port ?? null,
          enabled: row?.enabled ?? true,
          online,
          state: this.stateFor(id, row?.enabled, online),
        };
      }),
      connections: [...this.sessions].map((s) => s.info()),
      pending: this.pending.list().map((p) => ({
        requestId: p.requestId, keyId: p.keyId, fingerprint: p.fingerprint, comment: p.comment,
        deviceId: p.deviceId, peerIp: p.peerIp, createdAt: p.createdAt,
      })),
      keys: this.listKeys(),
      counters: { ...this.counters },
    };
  }

  listKeys(): KeyView[] {
    return this.keys.list().map((r) => ({
      id: r.id,
      keyId: r.keyId,
      fingerprint: fingerprintOf(Buffer.from(r.publicKey, 'base64')),
      comment: r.comment,
      status: r.status,
      deviceIds: r.deviceIds && r.deviceIds.length > 0 ? r.deviceIds : null,
      firstSeenAt: r.firstSeenAt.getTime(),
      lastSeenAt: r.lastSeenAt.getTime(),
      lastSeenIp: r.lastSeenIp,
      lastDeviceId: r.lastDeviceId,
      decidedAt: r.decidedAt ? r.decidedAt.getTime() : null,
    }));
  }

  updateSettings(patch: Partial<AdbProxySettings>): Promise<StatusSnapshot> {
    return this.serialised(async () => {
      const before = this.settings;
      const after = saveSettings(this.deps.db, patch);
      this.settings = after;
      if (before.enabled && !after.enabled) {
        await this.stopAllDevices();
      } else if (!before.enabled && after.enabled) {
        await this.startAll();
      } else if (after.enabled && before.bindHost !== after.bindHost) {
        await this.stopAllDevices();
        await this.startAll();
      } else if (after.enabled && (before.portStart !== after.portStart || before.portEnd !== after.portEnd)) {
        // Devices that found the range full get another try; listening ones are left alone.
        await this.startAll();
      }
      this.notifyChanged();
      return this.snapshot();
    });
  }

  setDevice(
    deviceId: string,
    patch: { enabled?: boolean; port?: number },
  ): Promise<Done | Failure<'unknown-device' | 'range-full' | 'out-of-range' | 'in-use'>> {
    return this.serialised(async () => {
      const known = this.deps.db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).get();
      if (!known) return { ok: false, error: 'unknown-device' } as const;
      const row = this.ports.ensure(deviceId);
      if ('error' in row) return { ok: false, error: 'range-full' } as const;
      try {
        if (patch.port !== undefined && patch.port !== row.port) {
          if (!this.ports.setPort(deviceId, patch.port)) return { ok: false, error: 'unknown-device' } as const;
          await this.stopDevice(deviceId);
        }
        if (patch.enabled !== undefined) {
          this.ports.setEnabled(deviceId, patch.enabled);
          if (!patch.enabled) await this.stopDevice(deviceId);
        }
      } catch (e) {
        if (e instanceof PortError) return { ok: false, error: e.code } as const;
        throw e;
      }
      await this.startDevice(deviceId);
      this.notifyChanged();
      return { ok: true } as const;
    });
  }

  approveRequest(requestId: string, userId: number | null): Done | Failure<'not-found'> {
    return this.decide(requestId, 'approved', userId);
  }

  denyRequest(requestId: string, userId: number | null): Done | Failure<'not-found'> {
    return this.decide(requestId, 'denied', userId);
  }

  private decide(requestId: string, status: 'approved' | 'denied', userId: number | null): Done | Failure<'not-found'> {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, error: 'not-found' };
    const existing = this.keys.findByKeyId(entry.keyId);
    // A denied or revoked key stays that way: waiting clients are refused, the record is not rewritten.
    if (existing && existing.status !== 'approved') {
      this.pending.resolveKey(entry.keyId, 'denied');
      return { ok: false, error: 'not-found' };
    }
    // An approved record's allow-list still binds the clients waiting on it.
    const permitted = (deviceId: string) =>
      status === 'approved' && !(existing?.deviceIds?.length && !existing.deviceIds.includes(deviceId));
    const refused = status === 'approved' && !permitted(entry.deviceId);
    if (!refused) {
      this.keys.upsertDecision({
        keyId: entry.keyId, publicKey: entry.publicKey, comment: entry.comment, status,
        ip: entry.peerIp, deviceId: entry.deviceId, userId,
      });
      this.gate.invalidate(entry.keyId);
    }
    for (const waiting of this.pending.list()) {
      if (waiting.keyId === entry.keyId) this.pending.resolve(waiting.requestId, permitted(waiting.deviceId) ? 'approved' : 'denied');
    }
    if (refused) return { ok: false, error: 'not-found' };
    if (status === 'denied' && existing) this.closeSessions((s) => s.keyId === entry.keyId, 'key denied');
    if (status === 'approved') {
      this.counters.approvals++;
      log(`approved key ${short(entry.keyId)} (${entry.comment}) first seen from ${entry.peerIp}`);
    } else {
      this.counters.denials++;
      log(`denied key ${short(entry.keyId)} (${entry.comment}) from ${entry.peerIp}`);
    }
    this.notifyChanged();
    return { ok: true };
  }

  revokeKey(id: number, userId: number | null): Done | Failure<'not-found' | 'not-approved'> {
    const rec = this.keys.findById(id);
    if (!rec) return { ok: false, error: 'not-found' };
    if (rec.status !== 'approved') return { ok: false, error: 'not-approved' };
    this.keys.setStatus(id, 'revoked', userId);
    this.gate.invalidate(rec.keyId);
    this.closeSessions((s) => s.keyId === rec.keyId, 'key revoked');
    log(`revoked key ${short(rec.keyId)} (${rec.comment ?? ''})`);
    this.notifyChanged();
    return { ok: true };
  }

  forgetKey(id: number): Done | Failure<'not-found'> {
    const rec = this.keys.findById(id);
    if (!rec) return { ok: false, error: 'not-found' };
    this.keys.forget(id);
    this.gate.invalidate(rec.keyId);
    this.closeSessions((s) => s.keyId === rec.keyId, 'key forgotten');
    log(`forgot key ${short(rec.keyId)} (${rec.comment ?? ''})`);
    this.notifyChanged();
    return { ok: true };
  }

  setKeyDevices(id: number, ids: string[] | null): Done | Failure<'not-found' | 'invalid'> {
    const rec = this.keys.findById(id);
    if (!rec) return { ok: false, error: 'not-found' };
    if (ids !== null && !(Array.isArray(ids) && ids.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 128))) {
      return { ok: false, error: 'invalid' };
    }
    const list = ids && ids.length > 0 ? ids : null;
    this.keys.setDeviceIds(id, list);
    if (list) this.closeSessions((s) => s.keyId === rec.keyId && !list.includes(s.deviceId), 'key restricted');
    this.notifyChanged();
    return { ok: true };
  }

  private stateFor(id: string, enabled: boolean | undefined, online: boolean): DeviceProxyState {
    if (!this.settings.enabled) return 'off';
    if (enabled === false) return 'disabled';
    const failed = this.deviceErrors.get(id);
    if (failed) return failed;
    if (!online) return 'device-offline';
    return this.listeners.has(id) ? 'listening' : 'off';
  }

  private deviceNames(ids: string[]): Map<string, string | null> {
    const map = new Map<string, string | null>();
    if (ids.length === 0) return map;
    const rows = this.deps.db
      .select({ id: devices.id, name: devices.name, model: devices.model })
      .from(devices)
      .where(inArray(devices.id, ids))
      .all();
    for (const r of rows) map.set(r.id, r.name ?? r.model ?? null);
    return map;
  }

  private async startAll(): Promise<void> {
    await Promise.all([...this.online].map((id) => this.startDevice(id)));
  }

  private async stopAllDevices(): Promise<void> {
    const ids = new Set([...this.listeners.keys(), ...this.starts.keys()]);
    await Promise.all([...ids].map((id) => this.stopDevice(id)));
    this.deviceErrors.clear();
  }

  /** Joins a bind already in flight for the device, so callers never see a half-started listener. */
  private startDevice(deviceId: string): Promise<void> {
    const running = this.starts.get(deviceId);
    if (running) return running;
    if (!this.started || !this.settings.enabled || this.listeners.has(deviceId)) return Promise.resolve();
    const run = this.listenFor(deviceId).finally(() => {
      this.starts.delete(deviceId);
      this.notifyChanged();
    });
    this.starts.set(deviceId, run);
    return run;
  }

  private async listenFor(deviceId: string): Promise<void> {
    try {
      const row = this.ports.ensure(deviceId);
      if ('error' in row) {
        this.deviceErrors.set(deviceId, 'range-full');
        return;
      }
      if (!row.enabled) {
        this.deviceErrors.delete(deviceId);
        return;
      }
      const listener = new DeviceListener({
        host: this.settings.bindHost,
        port: row.port,
        accept: (socket) => this.accept(deviceId, socket),
      });
      try {
        await listener.listen();
      } catch (e: any) {
        this.deviceErrors.set(deviceId, e instanceof ListenError && e.code === 'EADDRINUSE' ? 'port-in-use' : 'error');
        logError(`cannot listen for ${deviceId} on port ${row.port}: ${e?.message ?? e}`);
        return;
      }
      if (!this.started || !this.settings.enabled) {
        await listener.close();
        return;
      }
      this.listeners.set(deviceId, listener);
      this.deviceErrors.delete(deviceId);
      log(`listening for ${deviceId} on ${this.settings.bindHost}:${row.port}`);
    } catch (e: any) {
      this.deviceErrors.set(deviceId, 'error');
      logError(`cannot start proxy for ${deviceId}: ${e?.message ?? e}`);
    }
  }

  private async stopDevice(deviceId: string): Promise<void> {
    // Waits for a bind in flight, which either registers its listener or has already closed it.
    await this.starts.get(deviceId);
    this.closeSessions((s) => s.deviceId === deviceId, 'listener stopped');
    const listener = this.listeners.get(deviceId);
    this.listeners.delete(deviceId);
    this.deviceErrors.delete(deviceId);
    if (listener) await listener.close();
    this.notifyChanged();
  }

  private deviceOnline(deviceId: string): Promise<void> {
    const known = this.online.has(deviceId);
    this.online.add(deviceId);
    return this.serialised(async () => {
      await this.startDevice(deviceId);
      if (!known) this.notifyChanged();
    });
  }

  private deviceOffline(deviceId: string): void {
    if (!this.online.delete(deviceId)) return;
    this.closeSessions((s) => s.deviceId === deviceId, 'device offline');
    this.notifyChanged();
  }

  private reconcile(): void {
    if (!this.started) return;
    let present: Set<string>;
    try {
      present = new Set(this.deps.directory.listOnlineAndroid().map((d) => d.id));
    } catch (e: any) {
      this.logPresenceFailure(`presence check failed: ${e?.message ?? e}`);
      return;
    }
    for (const id of [...this.online]) if (!present.has(id)) this.deviceOffline(id);
    for (const id of present) if (!this.online.has(id)) void this.deviceOnline(id);
  }

  private closeSessions(match: (s: Session) => boolean, reason: string): void {
    for (const s of [...this.sessions]) if (match(s)) s.destroy(reason);
  }

  private accept(deviceId: string, socket: net.Socket): void {
    // A socket with no remote address was already reset, and must not share one pre-auth bucket with the others.
    if (!this.started || !socket.remoteAddress || !this.online.has(deviceId)) {
      socket.destroy();
      return;
    }
    const ip = foldMappedV4(socket.remoteAddress);
    const release = this.limiter.acquire(ip);
    if (!release) {
      this.counters.floodDrops++;
      socket.destroy();
      return;
    }
    this.counters.connections++;
    const session = new Session({
      socket,
      deviceId,
      peerIp: ip,
      gate: this.gate,
      backend: this.backend,
      isDeviceOnline: () => this.online.has(deviceId),
      onLeavePreAuth: release,
      onEvent: (e) => this.onSessionEvent(e),
      onClose: (s) => {
        this.sessions.delete(s);
        this.notifyChanged();
      },
    });
    this.sessions.add(session);
    this.notifyChanged();
  }

  private onSessionEvent(e: SessionEvent): void {
    const who = `device=${e.session.deviceId} ip=${e.session.peerIp} key=${e.session.keyId ? short(e.session.keyId) : '-'}`;
    switch (e.kind) {
      case 'auth-failed': this.counters.authFailures++; return;
      case 'authenticated':
        this.trusted.add(e.session);
        log(`session ${e.session.id} authenticated ${who}`);
        break;
      case 'refused-service':
        this.refusalLog.log('refused service', `session ${e.session.id} refused service "${printable(e.service)}" ${who}`);
        return;
      case 'closed': {
        // Anyone can open and drop connections, so only a session that authenticated gets a line of its own.
        const line = `session ${e.session.id} closed (${e.reason}) ${who}`;
        if (this.trusted.has(e.session)) log(line);
        else this.peerLog.log('unauthenticated close', line);
        break;
      }
      default: break;
    }
    this.notifyChanged();
  }

  private onGateEvent(e: GateEvent): void {
    switch (e.kind) {
      case 'requested':
        this.peerLog.log('approval request', `key ${short(e.entry.keyId)} (${e.entry.comment}) is waiting for approval for device=${e.entry.deviceId} ip=${e.entry.peerIp}`);
        break;
      case 'blocked':
        this.peerLog.log('blocked key', `blocked key ${short(e.keyId)} (${e.reason}) device=${e.deviceId} ip=${e.peerIp}`);
        break;
      case 'flood-drop':
        this.counters.floodDrops++;
        this.peerLog.log('approval flood-drop', `dropped an approval request (${e.reason} limit) device=${e.deviceId} ip=${e.peerIp}`);
        break;
    }
  }

  private notifyChanged(): void {
    if (!this.started || !this.deps.broadcast || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (!this.started) return;
      try {
        this.deps.broadcast!({ type: 'adb-proxy', ...this.snapshot() });
      } catch (e: any) {
        logError(`broadcast failed: ${e?.message ?? e}`);
      }
    }, NOTIFY_DELAY_MS);
    this.notifyTimer.unref?.();
  }
}
