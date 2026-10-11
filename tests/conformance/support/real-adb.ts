import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A_CNXN, A_VERSION, HEADER_SIZE, MAX_DATA, encodePacket } from '../../../backend/services/adb-proxy/packet';
import { freePortBase } from '../../../backend/services/adb-proxy/testing/free-port';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Clients to test: ADB_BINS (comma-separated), else ADB_BIN, else `adb` on PATH. */
export function adbBins(): string[] {
  const raw = process.env.ADB_BINS ?? process.env.ADB_BIN ?? 'adb';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function adbAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['version'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

/**
 * A real adb client with its own HOME (so its own key pair) and its own ADB server port, so it can
 * never touch the developer's running ADB server or keys.
 */
export class IsolatedAdb {
  private constructor(
    readonly bin: string,
    readonly home: string,
    private readonly serverPort: number,
    private readonly serverEnv: Record<string, string>,
  ) {}

  /** `serverEnv` applies to every command, start-server included: the server builds the transport, so a feature switch must reach it. */
  static async create(bin: string, serverEnv: Record<string, string> = {}): Promise<IsolatedAdb> {
    const serverPort = await freePortBase();
    if (serverPort === 5037) throw new Error('refusing to use the default ADB server port');
    const adb = new IsolatedAdb(bin, mkdtempSync(join(tmpdir(), 'adb-proxy-client-')), serverPort, serverEnv);
    const started = await adb.run(['start-server']);
    if (started.code !== 0) {
      await adb.stop();
      throw new Error(`${bin} could not start its isolated server: ${started.stderr || started.stdout}`);
    }
    return adb;
  }

  private env(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.home,
      ANDROID_ADB_SERVER_PORT: String(this.serverPort),
      ANDROID_ADB_LOG_PATH: join(this.home, 'adb-server.log'),
    };
    // Anything that could redirect the client to another server, another key store or another feature set.
    for (const k of [
      'ANDROID_USER_HOME',
      'ANDROID_SDK_HOME',
      'ADB_VENDOR_KEYS',
      'ANDROID_ADB_SERVER_ADDRESS',
      'ADB_SERVER_SOCKET',
      'ADB_REJECT_KILL_SERVER',
      'ADB_DELAYED_ACK',
      'ADB_BURST_MODE',
      'ANDROID_SERIAL',
      'ADB_TRACE',
    ]) {
      delete env[k];
    }
    return { ...env, ...this.serverEnv, ...extra };
  }

  /** `extraEnv` is layered over the isolated environment for this one command. */
  run(args: string[], timeoutMs = 20_000, extraEnv: Record<string, string> = {}): Promise<RunResult> {
    // An explicit -P makes the client ignore every server-selecting environment variable.
    const argv = ['-P', String(this.serverPort), ...args];
    return new Promise((resolve) => {
      execFile(this.bin, argv, { env: this.env(extraEnv), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code) : 0;
        resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, stdout, stderr });
      });
    });
  }

  /** Serial to state, from `adb devices`. */
  async devices(): Promise<Map<string, string>> {
    const out = await this.run(['devices']);
    const map = new Map<string, string>();
    for (const line of out.stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state) map.set(serial, state);
    }
    return map;
  }

  async waitForState(serial: string, state: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'absent';
    while (Date.now() < deadline) {
      last = (await this.devices()).get(serial) ?? 'absent';
      if (last === state) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`expected ${serial} to be ${state} within ${timeoutMs} ms, last state was ${last}`);
  }

  async stop(): Promise<void> {
    await this.run(['kill-server']);
    rmSync(this.home, { recursive: true, force: true });
  }
}

/** The features in the client's `CNXN`; the bare device answers at once because an unanswered `adb connect` waits ten seconds. */
async function offeredFeatures(adb: IsolatedAdb): Promise<string[]> {
  let finish: (features: string[]) => void = () => {};
  const offered = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (answered || buf.length < HEADER_SIZE || buf.length < HEADER_SIZE + buf.readUInt32LE(12)) return;
      answered = true;
      const banner = buf.subarray(HEADER_SIZE, HEADER_SIZE + buf.readUInt32LE(12)).toString('latin1');
      const list = buf.readUInt32LE(0) === A_CNXN && banner.includes('features=') ? banner.split('features=')[1] : '';
      const data = Buffer.from('device::ro.product.name=probe;ro.product.model=probe;ro.product.device=probe;features=cmd');
      socket.write(encodePacket({ command: A_CNXN, arg0: A_VERSION, arg1: MAX_DATA, data }));
      finish(list.split(',').filter(Boolean));
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()));
  const timer = setTimeout(() => finish([]), 8000);
  try {
    await adb.run(['connect', `127.0.0.1:${(listener.address() as net.AddressInfo).port}`]);
    return await offered;
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

/** The environment switch that makes this client offer `delayed_ack`, or null when it honours neither known name. */
export async function delayedAckSwitch(bin: string): Promise<string | null> {
  for (const name of ['ADB_DELAYED_ACK', 'ADB_BURST_MODE']) {
    const adb = await IsolatedAdb.create(bin, { [name]: '1' });
    try {
      if ((await offeredFeatures(adb)).includes('delayed_ack')) return name;
    } finally {
      await adb.stop();
    }
  }
  return null;
}
