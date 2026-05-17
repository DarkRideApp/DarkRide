import { spawn, exec, ChildProcess, execSync } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'net';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { eq, isNotNull } from 'drizzle-orm';
import { devices } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('python-bridge');

const isWindows = process.platform === 'win32';
const venvRoot = resolve(process.cwd(), '.venv');
const venvPython = isWindows
  ? resolve(venvRoot, 'Scripts', 'python.exe')
  : resolve(venvRoot, 'bin', 'python3');
const requirementsFile = resolve(process.cwd(), 'python', 'requirements.txt');

let venvReady = false;

/** Find a Python 3 executable on the system. */
function findSystemPython3(): string {
  // Try candidates in order of preference
  const candidates = isWindows
    ? ['py -3', 'python3', 'python']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const version = execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      if (version.startsWith('Python 3')) {
        log(`Found system Python: ${cmd} (${version})`);
        return cmd;
      }
    } catch {
      // not available
    }
  }

  throw new Error('Python 3 not found. Install Python 3.8+ from https://www.python.org/downloads/');
}

/** Ensure the .venv exists with dependencies installed. Returns the python path. */
export function ensureVenv(): string {
  if (venvReady && existsSync(venvPython)) return venvPython;

  const systemPython = findSystemPython3();

  if (!existsSync(venvPython)) {
    log('Creating Python virtual environment...');
    try {
      execSync(`${systemPython} -m venv "${venvRoot}"`, { stdio: 'pipe', timeout: 60_000 });
      log('Virtual environment created');
    } catch (err: any) {
      error(`Failed to create venv: ${err.message}`);
      log('Falling back to system Python');
      return systemPython;
    }
  }

  // Use `python -m pip` rather than `pip.exe` — uv-created venvs and some system
  // Pythons skip the pip shim, but pip-as-a-module always works.
  if (existsSync(requirementsFile)) {
    log('Installing Python dependencies...');
    try {
      execSync(`"${venvPython}" -m pip install -r "${requirementsFile}"`, { stdio: 'pipe', timeout: 300_000 });
      log('Python dependencies installed');
    } catch (err: any) {
      error(`Failed to install Python deps: ${err.message}`);
      throw new Error(`Failed to install Python dependencies: ${err.message}`);
    }
  }

  venvReady = true;
  log(`Using venv Python: ${venvPython}`);
  return venvPython;
}

const execAsync = promisify(exec);

/** Async version of ensureVenv — doesn't block the event loop. */
export async function ensureVenvAsync(
  onProgress?: (message: string) => void,
): Promise<string> {
  if (venvReady && existsSync(venvPython)) return venvPython;

  const systemPython = findSystemPython3();

  if (!existsSync(venvPython)) {
    onProgress?.('Creating Python virtual environment...');
    log('Creating Python virtual environment...');
    try {
      await execAsync(`${systemPython} -m venv "${venvRoot}"`, { timeout: 60_000 });
      log('Virtual environment created');
    } catch (err: any) {
      error(`Failed to create venv: ${err.message}`);
      log('Falling back to system Python');
      return systemPython;
    }
  }

  // Use `python -m pip` rather than `pip.exe` — uv-created venvs and some system
  // Pythons skip the pip shim, but pip-as-a-module always works.
  if (existsSync(requirementsFile)) {
    onProgress?.('Installing Python dependencies...');
    log('Installing Python dependencies...');
    try {
      await new Promise<void>((resolve, reject) => {
        const pip = spawn(venvPython, ['-m', 'pip', 'install', '-r', requirementsFile], {
          timeout: 300_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          // Parse pip output for user-friendly progress
          const collecting = trimmed.match(/^Collecting\s+(\S+)/);
          if (collecting) {
            onProgress?.(`Installing ${collecting[1]}...`);
            return;
          }
          if (trimmed.startsWith('Requirement already satisfied:')) {
            const pkg = trimmed.replace('Requirement already satisfied: ', '').split(' ')[0];
            onProgress?.(`${pkg} up to date`);
            return;
          }
          if (trimmed.startsWith('Downloading')) {
            const dlMatch = trimmed.match(/Downloading\s+\S+\/([^/]+?)(?:\s|$)/);
            if (dlMatch) onProgress?.(`Downloading ${dlMatch[1]}...`);
            return;
          }
          if (trimmed.startsWith('Installing collected packages:')) {
            onProgress?.('Finalising installation...');
          }
        };
        let stdoutBuf = '';
        let stderrBuf = '';
        pip.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';
          lines.forEach(processLine);
        });
        pip.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          stderr += chunk.toString();
          const lines = stderrBuf.split('\n');
          stderrBuf = lines.pop() || '';
          lines.forEach(processLine);
        });
        pip.on('close', (code) => {
          // Process remaining buffer
          if (stdoutBuf) processLine(stdoutBuf);
          if (stderrBuf) processLine(stderrBuf);
          if (code === 0) resolve();
          else reject(new Error(`pip install exited with code ${code}: ${stderr.slice(-500)}`));
        });
        pip.on('error', reject);
      });
      log('Python dependencies installed');
    } catch (err: any) {
      error(`Failed to install Python deps: ${err.message}`);
      throw new Error(`Failed to install Python dependencies: ${err.message}`);
    }
  }

  venvReady = true;
  log(`Using venv Python: ${venvPython}`);
  return venvPython;
}

const BRIDGE_PORT_START = 9100;
const BRIDGE_PORT_END = 9199;
const IDLE_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_MAX_RETRIES = 20;

export interface PythonBridge {
  deviceId: string;
  port: number;
  process: ChildProcess;
  isRunning(): boolean;
  resetIdleTimer(): void;
  /** Disable idle timeout (e.g. while an automation is running) */
  disableIdleTimeout(): void;
  /** Re-enable idle timeout and start the timer */
  enableIdleTimeout(): void;
  stop(): void;
}

export class PythonBridgeManager {
  private bridges = new Map<string, PythonBridge>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleDisabled = new Set<string>();

  constructor(private db: AppDatabase) {}

  private crashCooldowns = new Map<string, number>(); // deviceId → timestamp when cooldown expires

  async getBridge(deviceId: string): Promise<PythonBridge> {
    let bridge = this.bridges.get(deviceId);
    if (bridge && bridge.isRunning()) {
      bridge.resetIdleTimer();
      return bridge;
    }

    // Prevent rapid respawning after a crash (5s cooldown)
    const cooldownUntil = this.crashCooldowns.get(deviceId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      throw new Error(`Bridge for ${deviceId} crashed recently, retrying in ${remaining}s`);
    }

    bridge = await this.spawnBridge(deviceId);
    this.bridges.set(deviceId, bridge);
    return bridge;
  }

  private async spawnBridge(deviceId: string): Promise<PythonBridge> {
    let port = await this.getOrAllocatePort(deviceId);

    // Verify the port is actually available before spawning
    const isPortFree = await this.checkPortFree(port);
    if (!isPortFree) {
      error(`Port ${port} is in use, trying to find a free port for ${deviceId}`);
      // Try to find an alternative free port
      const altPort = await this.findFreePort(deviceId);
      if (altPort) {
        port = altPort;
        this.db.update(devices).set({ bridgePort: port }).where(eq(devices.id, deviceId)).run();
        log(`Reassigned device ${deviceId} to port ${port}`);
      } else {
        throw new Error(`No free ports available for bridge (port ${port} is in use)`);
      }
    }

    log(`Spawning Python bridge for device ${deviceId} on port ${port}`);

    const pythonBin = ensureVenv();
    const child = spawn(pythonBin, ['python/bridge.py', '--device', deviceId, '--port', port.toString()], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let running = true;

    child.on('exit', (code) => {
      running = false;
      log(`Bridge for device ${deviceId} exited with code ${code}`);
      this.bridges.delete(deviceId);
      this.clearIdleTimer(deviceId);
      // Set 5s cooldown to prevent rapid respawning on port conflicts
      if (code !== 0) {
        this.crashCooldowns.set(deviceId, Date.now() + 5000);
      }
    });

    child.on('error', (err) => {
      running = false;
      error(`Bridge for device ${deviceId} error: ${err.message}`);
      this.bridges.delete(deviceId);
      this.clearIdleTimer(deviceId);
      this.crashCooldowns.set(deviceId, Date.now() + 5000);
    });

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      stderrChunks.push(line);
      error(`Bridge ${deviceId}: ${line}`);
    });

    child.stdout?.on('data', (data: Buffer) => {
      log(`Bridge ${deviceId}: ${data.toString().trim()}`);
    });

    // Wait for health check
    try {
      await this.waitForHealthy(port);
    } catch (err) {
      // If process already exited, include stderr in error
      if (!running) {
        const stderr = stderrChunks.join('\n');
        throw new Error(`Bridge process exited before becoming healthy. stderr:\n${stderr}`);
      }
      throw err;
    }

    const bridge: PythonBridge = {
      deviceId,
      port,
      process: child,
      isRunning: () => running,
      resetIdleTimer: () => this.resetIdleTimer(deviceId),
      disableIdleTimeout: () => {
        this.idleDisabled.add(deviceId);
        this.clearIdleTimer(deviceId);
      },
      enableIdleTimeout: () => {
        this.idleDisabled.delete(deviceId);
        this.resetIdleTimer(deviceId);
      },
      stop: () => {
        running = false;
        child.kill('SIGTERM');
        this.bridges.delete(deviceId);
        this.clearIdleTimer(deviceId);
        this.idleDisabled.delete(deviceId);
      },
    };

    this.resetIdleTimer(deviceId);
    return bridge;
  }

  private async waitForHealthy(port: number): Promise<void> {
    for (let i = 0; i < HEALTH_CHECK_MAX_RETRIES; i++) {
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
          log(`Bridge on port ${port} is healthy`);
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }
    throw new Error(`Bridge on port ${port} failed health check after ${HEALTH_CHECK_MAX_RETRIES} retries`);
  }

  async getOrAllocatePort(deviceId: string): Promise<number> {
    // Check if device already has a port assigned
    const device = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .all()[0];

    if (device?.bridgePort) {
      return device.bridgePort;
    }

    // Find next available port
    const usedPorts = this.db
      .select({ bridgePort: devices.bridgePort })
      .from(devices)
      .where(isNotNull(devices.bridgePort))
      .all();

    const usedSet = new Set(usedPorts.map((d) => d.bridgePort));

    for (let port = BRIDGE_PORT_START; port <= BRIDGE_PORT_END; port++) {
      if (!usedSet.has(port)) {
        this.db
          .update(devices)
          .set({ bridgePort: port })
          .where(eq(devices.id, deviceId))
          .run();
        return port;
      }
    }

    throw new Error('No available ports in bridge range (9100-9199)');
  }

  /** Check if a TCP port is free by trying to listen on it briefly */
  private checkPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /** Find a free port in the bridge range, skipping already-assigned ports */
  private async findFreePort(deviceId: string): Promise<number | null> {
    const usedPorts = this.db
      .select({ bridgePort: devices.bridgePort })
      .from(devices)
      .where(isNotNull(devices.bridgePort))
      .all();
    const usedSet = new Set(usedPorts.map((d) => d.bridgePort));

    for (let port = BRIDGE_PORT_START; port <= BRIDGE_PORT_END; port++) {
      if (usedSet.has(port)) continue;
      const free = await this.checkPortFree(port);
      if (free) return port;
    }
    return null;
  }

  private resetIdleTimer(deviceId: string): void {
    this.clearIdleTimer(deviceId);
    if (this.idleDisabled.has(deviceId)) return;
    const timer = setTimeout(() => {
      const bridge = this.bridges.get(deviceId);
      if (bridge) {
        log(`Bridge for device ${deviceId} idle timeout, stopping`);
        bridge.stop();
      }
    }, IDLE_TIMEOUT_MS);
    this.idleTimers.set(deviceId, timer);
  }

  private clearIdleTimer(deviceId: string): void {
    const timer = this.idleTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(deviceId);
    }
  }

  stopBridge(deviceId: string): void {
    const bridge = this.bridges.get(deviceId);
    if (bridge) {
      bridge.stop();
    }
  }

  stopAll(): void {
    for (const [deviceId, bridge] of this.bridges) {
      log(`Stopping bridge for device ${deviceId}`);
      bridge.stop();
    }
    this.bridges.clear();
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    this.idleDisabled.clear();
  }

  getRunningBridges(): Map<string, PythonBridge> {
    return this.bridges;
  }
}
