import { describe, it, expect, vi } from 'vitest';
import { createDockerAndroidProvider } from '../docker-android';
import type { DockerLike } from '../docker-helpers';

function makeDockerMock(overrides: Partial<DockerLike> & { getImage?: any } = {}): DockerLike {
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
    // Pretend the image is always local so createInstance's
    // ensureImageLocal helper short-circuits and tests stay fast.
    getImage: vi.fn().mockImplementation(() => ({
      inspect: vi.fn().mockResolvedValue({ Id: 'sha256:fake' }),
    })),
    pull: vi.fn().mockResolvedValue({ on: vi.fn(), pipe: vi.fn() } as any),
    ...overrides,
  } as any;
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
      Image: 'budtmo/docker-android:emulator_14.0',
      Labels: expect.objectContaining({ 'darkride.emulator': 'true' }),
      ExposedPorts: expect.objectContaining({ '5555/tcp': {} }),
    }));
  });

  it('always passes --device /dev/kvm (required for in-container emulator; daemon-side check, not host-side)', async () => {
    // Regression: probing the Node host's filesystem for /dev/kvm produces
    // a false negative on Docker Desktop (Mac / Windows), where the daemon's
    // VM has /dev/kvm but the host running the Node process doesn't. The
    // resulting container spawn omitted Devices → budtmo fell back to
    // software emulation and the container exited 137 within seconds.
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => false });
    await p.createInstance!({
      displayName: 'kvm-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      HostConfig: expect.objectContaining({
        Devices: expect.arrayContaining([
          expect.objectContaining({ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm' }),
        ]),
      }),
    }));
  });

  it('wraps the daemon\'s "no such file" /dev/kvm error into an actionable message', async () => {
    // When the daemon itself can't expose /dev/kvm (Mac, Windows without
    // nested-virt for WSL2, Linux without kvm modules loaded), createContainer
    // rejects synchronously. Surface a clearer error than the raw runc string.
    const d = makeDockerMock({
      createContainer: vi.fn().mockRejectedValue(
        new Error('error gathering device information while adding custom device "/dev/kvm": no such file or directory'),
      ),
    });
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => false });
    await expect(p.createInstance!({
      displayName: 'kvm-missing',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    })).rejects.toThrow(/hardware virtualization/i);
  });

  it('exposes 5900/tcp bound to loopback for the VNC proxy to reach', async () => {
    // Phase 1 emulator VNC streaming — the proxy connects to budtmo's RFB on
    // 5900 over loopback. The browser never reaches this port directly; the
    // host binding must be 127.0.0.1 to keep that boundary enforced.
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => false });
    await p.createInstance!({
      displayName: 'vnc-port',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    const call = (d.createContainer as any).mock.calls[0][0];
    expect(call.ExposedPorts).toMatchObject({ '5900/tcp': {} });
    expect(call.HostConfig.PortBindings['5900/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: '0' },
    ]);
  });

  it('declares videoTransport: vnc', async () => {
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => false });
    expect(p.videoTransport).toBe('vnc');
  });

  it('rethrows unrelated createContainer errors unchanged', async () => {
    const d = makeDockerMock({
      createContainer: vi.fn().mockRejectedValue(new Error('Conflict. The container name "/foo" is already in use')),
    });
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => false });
    await expect(p.createInstance!({
      displayName: 'name-conflict',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    })).rejects.toThrow(/already in use/);
  });

  it('does NOT auto-pass /dev/dri even if the host has it (avoids triggering the WSL nvidia prestart hook)', async () => {
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => true, hasNvidia: async () => false });
    await p.createInstance!({
      displayName: 'gpu-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    const call = (d.createContainer as any).mock.calls[0][0];
    // /dev/kvm is the only device we mount; /dev/dri should not appear.
    expect(call.HostConfig.Devices).toEqual([
      expect.objectContaining({ PathOnHost: '/dev/kvm' }),
    ]);
  });

  it('does NOT request NVIDIA DeviceRequests by default (budtmo uses swiftshader software rendering; nvidia-container init fails on Docker Desktop WSL)', async () => {
    const d = makeDockerMock({ info: vi.fn().mockResolvedValue({ Runtimes: { nvidia: {} } }) });
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: async () => true });
    await p.createInstance!({
      displayName: 'gpu-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    const call = (d.createContainer as any).mock.calls[0][0];
    expect(call.HostConfig.DeviceRequests).toBeUndefined();
  });

  it('startInstance starts the container and returns serial=localhost:<port>', async () => {
    const d = makeDockerMock();
    const adbConnect = vi.fn().mockResolvedValue(true);
    const bootCompleted = vi.fn().mockResolvedValue(true);
    const p = createDockerAndroidProvider(d, {
      hasDevDri: () => false, hasNvidia: async () => false,
      adbConnect, bootCompleted,
      // Collapse the retry window so unit tests don't sleep.
      bootTimeoutMs: 100, bootRetryIntervalMs: 10,
    });
    const running = await p.startInstance('container-test-emu');
    expect(running.serial).toMatch(/localhost:\d+/);
    expect(adbConnect).toHaveBeenCalledWith(6001);
    expect(bootCompleted).toHaveBeenCalledWith('localhost:6001');
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

  it('getNetworkConfig returns emu-http-proxy mode (HTTP forward proxy via adb reverse)', () => {
    const p = createDockerAndroidProvider(makeDockerMock());
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'emu-http-proxy' });
  });

  it('startInstance stops the container and throws if adbConnect fails (no orphan)', async () => {
    const d = makeDockerMock();
    const stop = vi.fn().mockResolvedValue(undefined);
    (d.getContainer as any).mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop,
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        NetworkSettings: { Ports: { '5555/tcp': [{ HostPort: '6001' }] } },
      }),
    });
    const adbConnect = vi.fn().mockResolvedValue(false);
    const p = createDockerAndroidProvider(d, {
      hasDevDri: () => false, hasNvidia: async () => false,
      adbConnect,
      bootTimeoutMs: 100, bootRetryIntervalMs: 10,
    });
    await expect(p.startInstance('container-test-emu')).rejects.toThrow(/adb failed/i);
    expect(stop).toHaveBeenCalled();
  });

  it('startInstance retries adbConnect during the cold-boot window', async () => {
    const d = makeDockerMock();
    // Fail twice (emulator still booting), then succeed — typical 5-second
    // window during a cold docker-android cold boot.
    const adbConnect = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const bootCompleted = vi.fn().mockResolvedValue(true);
    const p = createDockerAndroidProvider(d, {
      hasDevDri: () => false, hasNvidia: async () => false,
      adbConnect, bootCompleted,
      bootTimeoutMs: 500, bootRetryIntervalMs: 10,
    });
    const running = await p.startInstance('container-test-emu');
    expect(running.serial).toBe('localhost:6001');
    expect(adbConnect).toHaveBeenCalledTimes(3);
  });

  it('startInstance polls boot_completed after adb connect and stops the container if Android never boots', async () => {
    const d = makeDockerMock();
    const stop = vi.fn().mockResolvedValue(undefined);
    (d.getContainer as any).mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop,
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        NetworkSettings: { Ports: { '5555/tcp': [{ HostPort: '6001' }] } },
      }),
    });
    const adbConnect = vi.fn().mockResolvedValue(true);
    const bootCompleted = vi.fn().mockResolvedValue(false);
    const p = createDockerAndroidProvider(d, {
      hasDevDri: () => false, hasNvidia: async () => false,
      adbConnect, bootCompleted,
      bootTimeoutMs: 100, bootRetryIntervalMs: 10,
    });
    await expect(p.startInstance('container-test-emu')).rejects.toThrow(/boot did not complete/i);
    expect(stop).toHaveBeenCalled();
  });
});
