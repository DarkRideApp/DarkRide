import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveVideoTransport } from '../video-transport';
import type { ProviderRegistry } from '../../services/providers';
import type { DeviceInstancesRepo } from '../../services/device-instances-repo';

describe('resolveVideoTransport', () => {
  let repo: DeviceInstancesRepo;
  let registry: ProviderRegistry;

  beforeEach(() => {
    repo = { getBySerial: vi.fn() } as unknown as DeviceInstancesRepo;
    registry = { get: vi.fn() } as unknown as ProviderRegistry;
  });

  it('returns transport=scrcpy for a serial with no backing instance', () => {
    (repo.getBySerial as any).mockReturnValue(null);
    expect(resolveVideoTransport('usb-pixel-001', repo, registry))
      .toEqual({ transport: 'scrcpy' });
  });

  it('returns transport=scrcpy when the provider declares no videoTransport', () => {
    (repo.getBySerial as any).mockReturnValue({ providerId: 'adb-device', runtimeId: 'r' });
    (registry.get as any).mockReturnValue({ id: 'adb-device' /* no videoTransport */ });
    expect(resolveVideoTransport('usb-pixel-001', repo, registry))
      .toEqual({ transport: 'scrcpy' });
  });

  it('returns transport=vnc with wsPath when the provider declares vnc', () => {
    (repo.getBySerial as any).mockReturnValue({ providerId: 'docker-android', runtimeId: 'r' });
    (registry.get as any).mockReturnValue({ id: 'docker-android', videoTransport: 'vnc' });
    expect(resolveVideoTransport('localhost:32770', repo, registry))
      .toEqual({ transport: 'vnc', wsPath: '/ws/vnc?serial=localhost%3A32770' });
  });
});
