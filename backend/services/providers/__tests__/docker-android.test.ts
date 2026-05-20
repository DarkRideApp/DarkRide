import { describe, it, expect, vi } from 'vitest';
import { createDockerAndroidProvider } from '../docker-android';
import type { DockerLike } from '../docker-helpers';

function makeDockerMock(overrides: Partial<DockerLike> = {}): DockerLike {
  return {
    ping: vi.fn().mockResolvedValue('OK'),
    info: vi.fn().mockResolvedValue({ Runtimes: { runc: {} } }),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn().mockImplementation((id: string) => ({
      id,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Running: true }, NetworkSettings: { Ports: { '5555/tcp': [{ HostPort: '6001' }] } } }),
    })),
    createContainer: vi.fn().mockImplementation(async ({ name }: any) => ({
      id: `container-${name}`,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
    })),
    pull: vi.fn().mockResolvedValue({ on: vi.fn(), pipe: vi.fn() } as any),
    ...overrides,
  } as DockerLike;
}

describe('docker-android provider', () => {
  it('isAvailable returns true when daemon is up', async () => {
    const p = createDockerAndroidProvider(makeDockerMock());
    expect((await p.isAvailable()).available).toBe(true);
  });

  it('createInstance creates a labelled container with mapped adb port', async () => {
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d);
    const inst = await p.createInstance!({
      displayName: 'test-emu',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(inst.state).toBe('created');
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Image: 'ghcr.io/darkrideapp/docker-android:14',
      Labels: expect.objectContaining({ 'darkride.emulator': 'true' }),
      ExposedPorts: { '5555/tcp': {} },
    }));
  });

  it('GPU auto-detect: passes --device /dev/dri when /dev/dri exists', async () => {
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => true, hasNvidia: async () => false });
    await p.createInstance!({
      displayName: 'gpu-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      HostConfig: expect.objectContaining({
        Devices: expect.arrayContaining([
          expect.objectContaining({ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri' }),
        ]),
      }),
    }));
  });

  it('GPU auto-detect: passes DeviceRequests for NVIDIA when toolkit is detected', async () => {
    const d = makeDockerMock({ info: vi.fn().mockResolvedValue({ Runtimes: { nvidia: {} } }) });
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => true });
    await p.createInstance!({
      displayName: 'gpu-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      HostConfig: expect.objectContaining({ DeviceRequests: expect.any(Array) }),
    }));
  });

  it('startInstance starts the container and returns serial=localhost:<port>', async () => {
    const d = makeDockerMock();
    const adbConnect = vi.fn().mockResolvedValue(true);
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => false, adbConnect });
    const running = await p.startInstance('container-test-emu');
    expect(running.serial).toMatch(/localhost:\d+/);
    expect(adbConnect).toHaveBeenCalledWith(6001);
  });

  it('stopInstance calls container.stop', async () => {
    const d = makeDockerMock();
    const stop = vi.fn().mockResolvedValue(undefined);
    (d.getContainer as any).mockReturnValue({ stop, remove: vi.fn(), inspect: vi.fn().mockResolvedValue({ State: { Running: false } }) });
    const p = createDockerAndroidProvider(d);
    await p.stopInstance('container-test-emu');
    expect(stop).toHaveBeenCalled();
  });

  it('deleteInstance refuses to delete a running container', async () => {
    const d = makeDockerMock();
    (d.getContainer as any).mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
      remove: vi.fn(),
    });
    const p = createDockerAndroidProvider(d);
    await expect(p.deleteInstance!('container-test-emu')).rejects.toThrow(/running/i);
  });

  it('getNetworkConfig returns wireguard mode', () => {
    const p = createDockerAndroidProvider(makeDockerMock());
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'wireguard' });
  });
});
