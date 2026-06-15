import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveVideoTransport, resolveGrpcInstance } from '../video-transport';
import type { ProviderRegistry } from '../../services/providers';
import type { DeviceInstancesRepo } from '../../services/device-instances-repo';

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
