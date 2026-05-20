import Docker from 'dockerode';

/**
 * Minimal surface of dockerode.Docker used by helpers — typed for test
 * mocking. The full dockerode.Docker satisfies this structurally.
 */
export interface DockerLike {
  ping(): Promise<unknown>;
  info(): Promise<any>;
  listContainers(opts: any): Promise<any[]>;
  getContainer(id: string): any;
  createContainer(opts: any): Promise<any>;
  pull(image: string, opts?: any): Promise<NodeJS.ReadableStream>;
}

export interface DockerDetectResult {
  available: boolean;
  reason?: string;
  installHint?: string;
  /** True when `docker info` reports the `nvidia` runtime (NVIDIA Container Toolkit installed). */
  nvidiaContainerToolkit?: boolean;
}

/**
 * Probe the Docker daemon. Used by docker-android provider's
 * `isAvailable()` and by GPU passthrough auto-detection at instance
 * creation time.
 */
export async function detectDockerDaemon(d: DockerLike): Promise<DockerDetectResult> {
  try {
    await d.ping();
    const info = await d.info();
    const nvidia = Boolean(info?.Runtimes?.nvidia);
    return { available: true, nvidiaContainerToolkit: nvidia };
  } catch (err: any) {
    return {
      available: false,
      reason: err?.message ?? String(err),
      installHint: 'Install Docker (https://docs.docker.com/engine/install/) and start the docker daemon. On Linux make sure /var/run/docker.sock exists and is readable by the user running DarkRide.',
      nvidiaContainerToolkit: false,
    };
  }
}

export interface DarkrideContainerInfo {
  id: string;
  name: string;
  state: string;
  /** Host port mapped to the container's 5555/tcp (adb). null when not bound. */
  adbPort: number | null;
}

/**
 * List only containers carrying the `darkride.emulator=true` label. We
 * never enumerate arbitrary containers — the docker-android provider only
 * manages containers it labelled.
 */
export async function listDarkrideContainers(d: DockerLike): Promise<DarkrideContainerInfo[]> {
  const containers = await d.listContainers({
    all: true,
    filters: { label: ['darkride.emulator=true'] },
  });
  return containers.map((c) => {
    const adbPort = c.Ports?.find((p: any) => p.PrivatePort === 5555)?.PublicPort ?? null;
    const name = (c.Names?.[0] ?? '/unknown').replace(/^\//, '');
    return { id: c.Id, name, state: c.State, adbPort };
  });
}

/** Construct a Docker client using the conventional defaults (socket auto-detect). */
export function createDockerClient(): DockerLike {
  return new Docker() as unknown as DockerLike;
}
