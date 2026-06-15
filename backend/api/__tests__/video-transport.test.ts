import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { resolveVideoTransport, resolveGrpcInstance } from '../video-transport';
import type { ProviderRegistry } from '../../services/providers';
import { DeviceInstancesRepo } from '../../services/device-instances-repo';

// Provider stubs. The resolver requires both the declared videoTransport AND
// the matching capability function (getGrpcEndpoint).
const WEBRTC_PROVIDER = { id: 'docker-android', videoTransport: 'webrtc', getGrpcEndpoint: () => {} };
const ADB_PROVIDER = { id: 'adb-device' /* observe-only, no videoTransport */ };

describe('resolveVideoTransport', () => {
  let repo: DeviceInstancesRepo;
  let registry: ProviderRegistry;

  beforeEach(() => {
    repo = { listBySerial: vi.fn().mockReturnValue([]) } as unknown as DeviceInstancesRepo;
    registry = { get: vi.fn() } as unknown as ProviderRegistry;
  });

  it('returns transport=scrcpy for a serial with no backing instance', () => {
    expect(resolveVideoTransport('usb-pixel-001', repo, registry)).toEqual({ transport: 'scrcpy' });
  });

  it('returns transport=scrcpy when the only instance has no video transport', () => {
    (repo.listBySerial as any).mockReturnValue([{ providerId: 'adb-device', runtimeId: 'r', state: 'running' }]);
    (registry.get as any).mockReturnValue(ADB_PROVIDER);
    expect(resolveVideoTransport('usb-pixel-001', repo, registry)).toEqual({ transport: 'scrcpy' });
  });

  it('returns transport=webrtc with grpcWebPath when the provider declares webrtc + getGrpcEndpoint', () => {
    (repo.listBySerial as any).mockReturnValue([{ providerId: 'docker-android', runtimeId: 'r', state: 'running' }]);
    (registry.get as any).mockReturnValue(WEBRTC_PROVIDER);
    expect(resolveVideoTransport('localhost:32771', repo, registry))
      .toEqual({ transport: 'webrtc', grpcWebPath: '/v1/devices/localhost%3A32771/grpc' });
  });

  it('prefers the running docker-android over a stale adb-device row sharing the serial (regression)', () => {
    // Host-port reuse: an old adb-device instance (stopped) and the live
    // docker-android instance (running) share localhost:32769. getBySerial's
    // lowest-rowid match would pick the stale adb-device → wrong scrcpy path.
    (repo.listBySerial as any).mockReturnValue([
      { providerId: 'adb-device', runtimeId: 'old', serial: 'localhost:32769', state: 'stopped' },
      { providerId: 'docker-android', runtimeId: 'new', serial: 'localhost:32769', state: 'running' },
    ]);
    (registry.get as any).mockImplementation((id: string) => id === 'docker-android' ? WEBRTC_PROVIDER : ADB_PROVIDER);
    expect(resolveVideoTransport('localhost:32769', repo, registry))
      .toEqual({ transport: 'webrtc', grpcWebPath: '/v1/devices/localhost%3A32769/grpc' });
  });

  it('resolveGrpcInstance returns the running gRPC-capable instance (not the stale adb-device)', () => {
    (repo.listBySerial as any).mockReturnValue([
      { providerId: 'adb-device', runtimeId: 'old', serial: 'localhost:32769', state: 'stopped' },
      { providerId: 'docker-android', runtimeId: 'new', serial: 'localhost:32769', state: 'running' },
    ]);
    (registry.get as any).mockImplementation((id: string) => id === 'docker-android' ? WEBRTC_PROVIDER : ADB_PROVIDER);
    expect(resolveGrpcInstance('localhost:32769', repo, registry)?.runtimeId).toBe('new');
  });
});

// H3: when two video-capable instances share a serial and are BOTH running
// (docker host-port reuse: adb serials are localhost:<hostport> and Docker
// recycles host ports), the running-first comparator returns 0 — so order
// falls back to listBySerial's row order. Without a recency ORDER BY that's
// rowid-ascending = the OLDEST (stale) row. This suite uses a REAL repo +
// in-memory DB so the ORDER BY in listBySerial is actually exercised (a mocked
// listBySerial would bypass the fix entirely).
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE device_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      display_name TEXT,
      serial TEXT,
      state TEXT NOT NULL,
      spawned_by_darkride INTEGER NOT NULL DEFAULT 0,
      spawn_metadata TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      last_state_at INTEGER NOT NULL
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('resolveGrpcInstance recency tiebreak (H3)', () => {
  it('prefers the most-recently-updated instance when two running rows share a serial', () => {
    const { db, sqlite } = makeDb();
    const repo = new DeviceInstancesRepo(db);
    const registry = { get: vi.fn().mockReturnValue(WEBRTC_PROVIDER) } as unknown as ProviderRegistry;

    // Two running, webrtc-capable docker-android rows for the same serial.
    // The repo stamps last_state_at = now on insert, so to make the two
    // timestamps deterministic and distinct we set last_state_at directly via
    // SQL: the OLDER (lower rowid) row gets the STALER timestamp, so a passing
    // test can ONLY be explained by the recency ORDER BY, not rowid order.
    const older = repo.insert({ providerId: 'docker-android', runtimeId: 'stale', serial: 'localhost:32770', state: 'running', spawnedByDarkride: true });
    const newer = repo.insert({ providerId: 'docker-android', runtimeId: 'fresh', serial: 'localhost:32770', state: 'running', spawnedByDarkride: true });
    // last_state_at is stored as epoch SECONDS (drizzle mode:'timestamp').
    // Lower rowid (older) = STALER state. The two values are arbitrary but distinct.
    sqlite.prepare('UPDATE device_instances SET last_state_at = ? WHERE id = ?').run(1000, older.id);
    sqlite.prepare('UPDATE device_instances SET last_state_at = ? WHERE id = ?').run(2000, newer.id);

    // newer.id is the higher rowid; recency ORDER BY must surface it despite
    // rowid order. (Without the fix, listBySerial returns rowid-asc → 'stale'.)
    expect(resolveGrpcInstance('localhost:32770', repo, registry)?.id).toBe(newer.id);
    expect(resolveGrpcInstance('localhost:32770', repo, registry)?.runtimeId).toBe('fresh');
  });
});
