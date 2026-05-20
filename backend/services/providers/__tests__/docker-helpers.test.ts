import { describe, it, expect, vi } from 'vitest';
import { detectDockerDaemon, listDarkrideContainers, type DockerLike } from '../docker-helpers';

function makeDockerMock(overrides: Partial<DockerLike> = {}): DockerLike {
  return {
    ping: vi.fn().mockResolvedValue('OK'),
    info: vi.fn().mockResolvedValue({ Runtimes: { runc: {} } }),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    createContainer: vi.fn(),
    pull: vi.fn(),
    ...overrides,
  } as DockerLike;
}

describe('detectDockerDaemon', () => {
  it('returns available=true when ping succeeds', async () => {
    const r = await detectDockerDaemon(makeDockerMock());
    expect(r.available).toBe(true);
  });

  it('returns available=false with installHint when daemon is unreachable', async () => {
    const d = makeDockerMock({ ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const r = await detectDockerDaemon(d);
    expect(r.available).toBe(false);
    expect(r.installHint).toMatch(/docker daemon/i);
  });

  it('detects NVIDIA Container Toolkit when info.Runtimes.nvidia is present', async () => {
    const d = makeDockerMock({ info: vi.fn().mockResolvedValue({ Runtimes: { runc: {}, nvidia: {} } }) });
    const r = await detectDockerDaemon(d);
    expect(r.available).toBe(true);
    expect(r.nvidiaContainerToolkit).toBe(true);
  });

  it('reports nvidiaContainerToolkit=false when only runc is present', async () => {
    const r = await detectDockerDaemon(makeDockerMock());
    expect(r.nvidiaContainerToolkit).toBe(false);
  });
});

describe('listDarkrideContainers', () => {
  it('filters by the darkride.emulator label and maps to summary shape', async () => {
    const list = vi.fn().mockResolvedValue([
      { Id: 'abc123', Names: ['/darkride-emu-1'], State: 'running', Ports: [{ PrivatePort: 5555, PublicPort: 6001 }], Labels: { 'darkride.emulator': 'true' } },
    ]);
    const d = makeDockerMock({ listContainers: list });
    const r = await listDarkrideContainers(d);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      all: true,
      filters: expect.objectContaining({ label: expect.arrayContaining(['darkride.emulator=true']) }),
    }));
    expect(r).toEqual([{ id: 'abc123', name: 'darkride-emu-1', state: 'running', adbPort: 6001 }]);
  });

  it('returns an empty list when no containers carry our label', async () => {
    const d = makeDockerMock({ listContainers: vi.fn().mockResolvedValue([]) });
    const r = await listDarkrideContainers(d);
    expect(r).toEqual([]);
  });
});
