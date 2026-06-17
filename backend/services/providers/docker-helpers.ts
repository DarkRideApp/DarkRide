import Docker from 'dockerode';

/**
 * Minimal surface of dockerode.Docker used by helpers — typed for test
 * mocking. The full dockerode.Docker satisfies this structurally.
 */
export interface DockerLike {
  ping(): Promise<unknown>;
  info(): Promise<Record<string, unknown>>;
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
    const nvidia = Boolean(((info.Runtimes ?? {}) as Record<string, unknown>).nvidia);
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
  return new Docker();
}

// Module-level handle so non-provider services (e.g. CaptureSessionManager)
// can exec into managed containers without plumbing dockerode through every
// constructor. Set once at boot in index.ts after the daemon probe.
let activeDockerClient: DockerLike | null = null;
export function setActiveDockerClient(d: DockerLike): void { activeDockerClient = d; }
export function getActiveDockerClient(): DockerLike | null { return activeDockerClient; }

/**
 * Spawn a TCP forwarder inside the named container. Returns once the
 * forwarder is listening (or rejects on exec failure). Useful for the
 * emu-http-proxy capture path: the Android emulator's QEMU NAT filters
 * RFC1918 private IPs, so the only address the emulator can reach
 * reliably is the QEMU host (10.0.2.2 = the container). Run a tiny
 * Python relay inside the container that listens on listenPort and
 * forwards to targetHost:targetPort on the docker host.
 *
 * Implementation: detached `python3 -c "..."` using stdlib only (every
 * budtmo-derived image ships Python 3). The forwarder process exits when
 * the container does — no separate cleanup needed.
 */
export async function spawnContainerHttpForwarder(
  d: DockerLike,
  containerId: string,
  listenPort: number,
  targetHost: string,
  targetPort: number,
): Promise<void> {
  const script = [
    'import socket, threading',
    `LISTEN_PORT=${listenPort}`,
    `TARGET=('${targetHost}', ${targetPort})`,
    'srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
    'srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
    'srv.bind(("0.0.0.0", LISTEN_PORT))',
    'srv.listen(16)',
    'def shovel(a, b):',
    '    try:',
    '        while True:',
    '            data = a.recv(4096)',
    '            if not data: break',
    '            b.sendall(data)',
    '    except OSError: pass',
    '    finally:',
    '        try: a.shutdown(socket.SHUT_RD)',
    '        except OSError: pass',
    '        try: b.shutdown(socket.SHUT_WR)',
    '        except OSError: pass',
    'def fwd(c):',
    '    try:',
    '        u = socket.create_connection(TARGET, timeout=5)',
    '    except Exception:',
    '        c.close(); return',
    '    threading.Thread(target=shovel, args=(c, u), daemon=True).start()',
    '    threading.Thread(target=shovel, args=(u, c), daemon=True).start()',
    'while True:',
    '    c, _ = srv.accept()',
    '    threading.Thread(target=fwd, args=(c,), daemon=True).start()',
  ].join('\n');

  const container = d.getContainer(containerId);
  // budtmo's docker-android image doesn't have an /etc/passwd entry for
  // root — dockerode's default User="root" username lookup fails. The
  // image runs as androidusr (UID 1300); the forwarder doesn't need any
  // privileged operation (binds an unprivileged port, opens TCP), so
  // androidusr is fine.
  //
  // Wrap the python invocation in a shell that redirects stdout/stderr to
  // a known file so post-mortem diagnostics survive (the exec is detached
  // so we can't read streams directly). Background it via `nohup` so the
  // detach actually keeps it alive after the exec stream closes.
  const wrapped = `nohup python3 -c "$1" > /tmp/darkride-forwarder-${listenPort}.log 2>&1 &`;
  const exec = await container.exec({
    Cmd: ['sh', '-c', wrapped, 'sh', script],
    User: 'androidusr',
    AttachStdout: false,
    AttachStderr: false,
    Detach: true,
  });
  await exec.start({ Detach: true });

  // Verify the listener is actually bound before returning. Without this,
  // callers proceed under the assumption it's up and only find out it
  // crashed when the device-side traffic fails to be captured.
  const verifyCmd = [
    'sh', '-c',
    `for i in $(seq 1 20); do
       python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('127.0.0.1', ${listenPort})); s.close()" 2>/dev/null && echo FWD_READY && exit 0
       sleep 0.25
     done
     echo FWD_FAILED
     echo "===== forwarder log ====="
     cat /tmp/darkride-forwarder-${listenPort}.log 2>/dev/null || echo "(no log)"
     exit 1`,
  ];
  const verifyExec = await container.exec({
    Cmd: verifyCmd,
    User: 'androidusr',
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream: any = await verifyExec.start({ hijack: true, stdin: false });
  const output: Buffer[] = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(chunks));
    stream.on('error', reject);
  });
  const text = Buffer.concat(output).toString('utf8');
  if (!text.includes('FWD_READY')) {
    throw new Error(`in-container forwarder failed to start on :${listenPort}\n${text.slice(0, 2000)}`);
  }
}
