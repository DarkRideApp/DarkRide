import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as net from 'net';

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  dbPath: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

const PROJECT_ROOT = resolve(__dirname, '../..');

/**
 * Boot a fresh server in a subprocess with an isolated DATA_ROOT and DB.
 * Waits for the listen log line. Returns a client with restart/stop methods.
 *
 * Each test gets its own dataDir + a free port. restart() SIGTERMs and
 * respawns with the same dataDir/port so DB and on-disk state persist.
 */
export async function startServer(opts: { port?: number } = {}): Promise<TestServer> {
  const port = opts.port ?? await pickPort();
  const dataDir = mkdtempSync(`${tmpdir()}/darkride-e2e-`);
  const dbPath = `${dataDir}/db.sqlite`;
  let proc = await spawnAndWait(port, dataDir, dbPath);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    dbPath,
    async restart() {
      await stopProc(proc);
      // Brief pause to let the OS release the port — SIGKILL exits instantly but
      // the kernel may not free the listen socket for a few ms.
      await new Promise(r => setTimeout(r, 500));
      proc = await spawnAndWait(port, dataDir, dbPath);
    },
    async stop() {
      await stopProc(proc);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function spawnAndWait(port: number, dataDir: string, dbPath: string): Promise<ChildProcess> {
  const proc = spawn('npx', ['tsx', 'backend/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_ROOT: dataDir,
      DATABASE_PATH: dbPath,
      DARKRIDE_PLUGINS: '',
      // Bypass any bootstrap admin guards (the existing playwright.config.ts
      // sets these — mirror so endpoints requiring scope checks pass).
      DARKRIDE_BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin',
      DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD: 'e2e-test-password-123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached: true so the process becomes a process group leader.
    // stopProc() uses process.kill(-pid, 'SIGTERM') to kill the entire group
    // (npx + tsx + node backend), ensuring the port is freed before restart.
    detached: true,
  });

  await new Promise<void>((res, rej) => {
    let done = false;
    const onLine = (chunk: Buffer) => {
      const line = chunk.toString();
      // Wait for "All services started" which is logged after plugin endpoints
      // are registered (registerPluginEndpoints is called inside the async
      // startup IIFE, after "DarkRide server running"). This prevents Phase 1
      // from hitting 404 on /v1/plugins/sources before registration completes.
      if (!done && (line.includes('All services started') || line.includes('Listening on'))) {
        done = true;
        proc.stdout!.off('data', onLine);
        res();
      }
    };
    const onExit = (code: number | null) => {
      if (!done) rej(new Error(`server exited early code=${code}`));
    };
    proc.stdout!.on('data', onLine);
    proc.stderr!.on('data', (chunk: Buffer) => {
      // Forward stderr so test output shows backend errors
      process.stderr.write(`[server stderr] ${chunk.toString()}`);
    });
    proc.once('exit', onExit);
    setTimeout(() => {
      if (!done) {
        done = true;
        rej(new Error(`server start timeout (port ${port})`));
      }
    }, 60_000);
  });

  return proc;
}

async function stopProc(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode !== null) return;
  // Kill the entire process group (npx → tsx → node) so no child lingers
  // holding the listen port after the parent exits.
  const pid = proc.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
  } else {
    proc.kill('SIGTERM');
  }
  await new Promise<void>(res => {
    const timeout = setTimeout(() => {
      // Hard kill the group if SIGTERM doesn't take in 5s
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
      }
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      res();
    });
  });
}

async function pickPort(): Promise<number> {
  return new Promise<number>((resolveP, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no address'));
      const port = (addr as any).port;
      srv.close(() => resolveP(port));
    });
    srv.on('error', reject);
  });
}
