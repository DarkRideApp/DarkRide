import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';

const PROJECT_ROOT = resolve(__dirname, '../..');

export interface TestVite {
  /** Origin the browser should load, e.g. http://localhost:5301 */
  origin: string;
  stop(): Promise<void>;
}

/**
 * Serve the frontend with Vite on `port`, proxying API and WebSocket traffic to
 * the backend on `backendPort`. Pair it with startServer() to drive the UI
 * against an isolated backend (own data dir and DB) instead of the shared one.
 * The backend must list this origin in WEBSOCKET_ALLOWED_ORIGINS.
 */
export async function startVite(opts: { port: number; backendPort: number }): Promise<TestVite> {
  const origin = `http://localhost:${opts.port}`;
  const proc: ChildProcess = spawn('npx', ['vite', '--port', String(opts.port), '--strictPort'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(opts.backendPort) },
    stdio: ['ignore', 'ignore', 'pipe'],
    // Own process group, so stop() can take npx and the node child down together.
    detached: true,
  });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  proc.stderr!.on('data', (chunk: Buffer) => process.stderr.write(`[vite stderr] ${chunk.toString()}`));

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited) throw new Error(`vite exited before it was ready (port ${opts.port})`);
    try {
      const res = await fetch(`${origin}/ui/`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      await stop(proc);
      throw new Error(`vite did not become ready on port ${opts.port}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return { origin, stop: () => stop(proc) };
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode !== null) return;
  const pid = proc.pid;
  try { if (pid) process.kill(-pid, 'SIGTERM'); else proc.kill('SIGTERM'); } catch { proc.kill('SIGTERM'); }
  await new Promise<void>(res => {
    const t = setTimeout(() => {
      try { if (pid) process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      res();
    }, 5000);
    proc.once('exit', () => { clearTimeout(t); res(); });
  });
}
