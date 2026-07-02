import { exec, execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { statSync } from 'fs';
import { randomUUID } from 'crypto';
import { createConnection, createServer, Socket } from 'net';
import type { WebSocket } from 'ws';
import { registerWebsocketEndpoint } from './handlers';
import { DeviceManager } from '../services/device-manager';
import type { IosDeviceManager } from '../services/ios-device-manager';
import { ensureMinicap, ensureMinitouch, getScrcpyServerJar } from '../services/vendor-manager';
import { createLoggers } from '../logs';
import { StreamBroadcaster } from './h264/stream-broadcaster';
import { newAdapterState, onReset, onTick, bitrateForTier, AdapterState } from './h264/bitrate-adapter';
import { KeyframeCoordinator } from './h264/keyframe-coordinator';
import { RESET_VIDEO_BYTE } from './h264/scrcpy-control';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const { log, error } = createLoggers('live-stream');

/**
 * Kill a process on-device by name and wait until it's actually gone.
 * Uses multiple kill strategies for reliability across Android versions,
 * then polls `pidof` until the process is confirmed dead.
 */
async function killDeviceProcess(deviceId: string, name: string, timeoutMs = 3000): Promise<void> {
  // Use multiple kill strategies — pkill/killall/pgrep behave differently
  // across Android versions and busybox builds.
  // Also try with su for processes started as root (e.g. minitouch via su -c
  // on rooted devices) — the shell user can't signal root-owned processes.
  await Promise.all([
    execAsync(`adb -s ${deviceId} shell pkill -9 -f ${name}`, { timeout: 3000 }).catch(() => {}),
    execAsync(`adb -s ${deviceId} shell killall -9 ${name}`, { timeout: 3000 }).catch(() => {}),
    execAsync(`adb -s ${deviceId} shell su -c 'pkill -9 -f ${name}'`, { timeout: 3000 }).catch(() => {}),
    execAsync(`adb -s ${deviceId} shell su -c 'killall -9 ${name}'`, { timeout: 3000 }).catch(() => {}),
  ]);

  // Poll until process is gone. `pidof` is the most portable check
  // across Android devices (works even when pgrep is missing/broken).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execAsync(`adb -s ${deviceId} shell pidof ${name}`, { timeout: 2000 });
      const pid = stdout.trim();
      if (!pid) break;
      // Still alive — try root kill by PID as last resort
      await execAsync(`adb -s ${deviceId} shell su -c 'kill -9 ${pid}'`, { timeout: 2000 }).catch(() => {});
    } catch {
      // pidof returns exit code 1 when no processes match — process is gone
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Push a local file to the device only if the remote file doesn't already
 * exist or has a different size. Saves 1-3 seconds per binary on each
 * stream start by skipping redundant adb push calls.
 */
async function pushIfNeeded(deviceId: string, localPath: string, remotePath: string): Promise<boolean> {
  try {
    const localSize = statSync(localPath).size;
    const { stdout } = await execAsync(
      `adb -s ${deviceId} shell stat -c %s ${remotePath}`,
      { timeout: 3000 },
    );
    const remoteSize = parseInt(stdout.trim(), 10);
    if (remoteSize === localSize) {
      log(`Skipping push — ${remotePath} already exists on ${deviceId} (${localSize} bytes)`);
      return false;
    }
  } catch {
    // File doesn't exist on device or stat failed — push needed
  }
  await execAsync(`adb -s ${deviceId} push "${localPath}" ${remotePath}`);
  return true;
}

// Port range for minicap/minitouch forwarding
const STREAM_PORT_START = 9200;
const STREAM_PORT_END = 9399;
let nextPort = STREAM_PORT_START;

/**
 * Poll interval for the adb-screencap fallback stream. ADB exec-out
 * round-trips ~200-500ms; 500ms (2fps) gives headroom without saturating
 * the ADB channel.
 */
const POLL_FALLBACK_INTERVAL_MS = 500;

/** Check if a TCP port is free by attempting to listen on it. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Allocate the next free port in the range, probing to skip ports in use. */
async function allocatePort(): Promise<number> {
  const start = nextPort;
  do {
    const port = nextPort;
    nextPort++;
    if (nextPort > STREAM_PORT_END) {
      nextPort = STREAM_PORT_START;
    }
    if (await isPortFree(port)) {
      return port;
    }
    log(`Port ${port} in use, skipping`);
  } while (nextPort !== start);
  throw new Error('No free ports available in stream port range');
}

/**
 * Parse the minicap banner (24 bytes).
 * Banner format:
 *   version (1 byte), length (1 byte), pid (4 bytes LE),
 *   realWidth (4 bytes LE), realHeight (4 bytes LE),
 *   virtualWidth (4 bytes LE), virtualHeight (4 bytes LE),
 *   orientation (1 byte), quirks (1 byte)
 */
export interface MinicapBanner {
  version: number;
  length: number;
  pid: number;
  realWidth: number;
  realHeight: number;
  virtualWidth: number;
  virtualHeight: number;
  orientation: number;
  quirks: number;
}

export function parseMinicapBanner(data: Buffer): MinicapBanner | null {
  if (data.length < 24) return null;
  return {
    version: data.readUInt8(0),
    length: data.readUInt8(1),
    pid: data.readUInt32LE(2),
    realWidth: data.readUInt32LE(6),
    realHeight: data.readUInt32LE(10),
    virtualWidth: data.readUInt32LE(14),
    virtualHeight: data.readUInt32LE(18),
    orientation: data.readUInt8(22),
    quirks: data.readUInt8(23),
  };
}

/**
 * Build a minitouch command string for a given touch event.
 * Minitouch protocol:
 *   d <contact> <x> <y> <pressure>\n  (finger down)
 *   m <contact> <x> <y> <pressure>\n  (finger move)
 *   u <contact>\n                      (finger up)
 *   c\n                                (commit)
 */
export function buildMinitouchCommand(
  eventType: 'down' | 'move' | 'up',
  x: number,
  y: number,
  contact: number = 0,
  pressure: number = 50,
): string {
  switch (eventType) {
    case 'down':
      return `d ${contact} ${Math.round(x)} ${Math.round(y)} ${pressure}\nc\n`;
    case 'move':
      return `m ${contact} ${Math.round(x)} ${Math.round(y)} ${pressure}\nc\n`;
    case 'up':
      return `u ${contact}\nc\n`;
  }
}

/**
 * Translate browser coordinates (0-1 normalized) to device coordinates.
 */
export function translateCoordinates(
  browserX: number,
  browserY: number,
  deviceWidth: number,
  deviceHeight: number,
): { x: number; y: number } {
  return {
    x: Math.round(browserX * deviceWidth),
    y: Math.round(browserY * deviceHeight),
  };
}

interface DeviceStream {
  deviceId: string;
  minicapProcess: ChildProcess | null;
  minicapSocket: Socket | null;
  minitouchProcess: ChildProcess | null;
  minitouchSocket: Socket | null;
  scrcpyProcess: ChildProcess | null;
  broadcaster: StreamBroadcaster | null;
  scrcpyPort: number;
  hasLiveVideo: boolean;
  screenWidth: number;
  screenHeight: number;
  viewers: Map<string, WebSocket>;
  registeredSocketHandlers: Set<WebSocket>;
  banner: MinicapBanner | null;
  minicapPort: number;
  minitouchPort: number;
  buffer: Buffer;
  readingBanner: boolean;
  frameSize: number;
  frameData: Buffer | null;
  framePos: number;
  pausedViewers: Set<string>;
  scrcpyRestartCount: number;
  scrcpyLastStartAt: number;
  pollTimer: NodeJS.Timeout | null;
  bitrateState: AdapterState;
  bitrateUpstepTimer: ReturnType<typeof setInterval> | null;
  /** True between triggerStreamReset() and the next attachScrcpyH264Pipeline.
   *  Prevents the scrcpy exit handler from misinterpreting a controlled
   *  restart as a crash and switching to polling. */
  intentionalRestart: boolean;
  /** When non-null, pins the bitrate to this tier and disables auto-upstep. */
  manualTier: number | null;
  /** Second TCP socket to scrcpy for control messages. Opened immediately
   *  after the video socket connects (when scrcpy is spawned with
   *  control=true). Null while disconnected; written to with a single byte
   *  per RESET_VIDEO request. */
  scrcpyControlSocket: Socket | null;
  /** Per-stream keyframe-request rate-limiter. Coalesces bursts of requests
   *  from one or more viewers into at most one scrcpy write per 500ms. */
  keyframeCoordinator: KeyframeCoordinator;
  /** Diagnostic counters for keyframe-request flow. Logged on stream stop. */
  keyframeStats: {
    requestsReceived: number;
    requestsSent: number;
    requestsCoalesced: number;
    lastReason: 'gap' | 'decode-error' | 'watchdog' | null;
  };
}

const activeStreams = new Map<string, DeviceStream>();
const pendingStarts = new Map<string, Promise<DeviceStream>>();

// ---- iOS WDA-based streaming (screenshot polling) ----

interface IosStream {
  deviceId: string;
  viewers: Map<string, WebSocket>;
  registeredSocketHandlers: Set<WebSocket>;
  pausedViewers: Set<string>;
  pollTimer: ReturnType<typeof setInterval> | null;
  screenWidth: number;
  screenHeight: number;
}

const activeIosStreams = new Map<string, IosStream>();
let _iosDeviceManagerRef: IosDeviceManager | null = null;

function startIosStream(deviceId: string): IosStream {
  const stream: IosStream = {
    deviceId,
    viewers: new Map(),
    registeredSocketHandlers: new Set(),
    pausedViewers: new Set(),
    pollTimer: null,
    screenWidth: 0,
    screenHeight: 0,
  };

  // Poll WDA screenshots and broadcast to viewers
  const pollInterval = 200; // ~5 fps
  stream.pollTimer = setInterval(async () => {
    if (!_iosDeviceManagerRef || stream.viewers.size === 0) return;
    try {
      const { image } = await _iosDeviceManagerRef.wdaScreenshot(deviceId);
      if (!image) return;

      const msg = JSON.stringify({
        type: 'device-frame',
        deviceId,
        frame: image,
        timestamp: Date.now(),
      });

      for (const [viewerId, ws] of stream.viewers) {
        if (stream.pausedViewers.has(viewerId)) continue;
        if (ws.readyState === 1) { // OPEN
          ws.send(msg);
        }
      }
    } catch (err: any) {
      // WDA may have died — notify viewers
      if (err.message?.includes('not running')) {
        for (const [, ws] of stream.viewers) {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', error: 'WDA disconnected — stream stopped.' }));
          }
        }
        stopIosStream(deviceId);
      }
    }
  }, pollInterval);

  activeIosStreams.set(deviceId, stream);
  log(`iOS stream started for ${deviceId} (WDA screenshot polling @ ${1000 / pollInterval} fps)`);
  return stream;
}

function stopIosStream(deviceId: string): void {
  const stream = activeIosStreams.get(deviceId);
  if (!stream) return;
  if (stream.pollTimer) clearInterval(stream.pollTimer);
  activeIosStreams.delete(deviceId);
  log(`iOS stream stopped for ${deviceId}`);
}

// --- Performance caches (persist across stream stop/start cycles) ---

/** Cached device properties to avoid redundant ADB shell calls. */
interface DeviceProperties {
  arch: string;
  apiLevel: number;
  screenWidth: number;
  screenHeight: number;
  binariesPushed: boolean;
}

const devicePropsCache = new Map<string, DeviceProperties>();

/** Persistent port allocations per device (survive stream stop for reuse). */
const allocatedPorts = new Map<string, { minicap?: number; minitouch?: number; scrcpy?: number }>();

/** Devices that have had a stream stopped — controls whether killDeviceProcess runs on next start. */
const previouslyStreamed = new Set<string>();

/**
 * Get all device properties in a single call (or from cache).
 * Runs arch, apiLevel, and screen size ADB calls in parallel on cache miss.
 */
async function getDeviceProperties(deviceId: string): Promise<DeviceProperties> {
  const cached = devicePropsCache.get(deviceId);
  if (cached) return cached;

  const [archResult, apiResult, screenResult] = await Promise.all([
    execAsync(`adb -s ${deviceId} shell getprop ro.product.cpu.abi`),
    execAsync(`adb -s ${deviceId} shell getprop ro.build.version.sdk`),
    execAsync(`adb -s ${deviceId} shell wm size`),
  ]);

  const arch = archResult.stdout.trim();
  const apiLevel = parseInt(apiResult.stdout.trim(), 10);
  const match = screenResult.stdout.match(/(\d+)x(\d+)/);
  if (!match) throw new Error('Could not determine screen size');

  const props: DeviceProperties = {
    arch,
    apiLevel,
    screenWidth: parseInt(match[1], 10),
    screenHeight: parseInt(match[2], 10),
    binariesPushed: false,
  };

  devicePropsCache.set(deviceId, props);
  return props;
}

/**
 * Get a cached port or allocate a new one for a device+process type.
 * Returns the port and whether a new ADB forward is needed.
 */
async function getOrAllocatePort(deviceId: string, type: 'minicap' | 'minitouch' | 'scrcpy'): Promise<{ port: number; isNew: boolean }> {
  let ports = allocatedPorts.get(deviceId);
  if (!ports) {
    ports = {};
    allocatedPorts.set(deviceId, ports);
  }
  if (ports[type] != null) {
    return { port: ports[type]!, isNew: false };
  }
  const port = await allocatePort();
  ports[type] = port;
  return { port, isNew: true };
}

/**
 * Clear all cached state for a device (call on device disconnect).
 */
function clearDeviceStreamCache(deviceId: string): void {
  devicePropsCache.delete(deviceId);
  const ports = allocatedPorts.get(deviceId);
  if (ports) {
    // Clean up any lingering ADB forwards
    if (ports.minicap) execAsync(`adb -s ${deviceId} forward --remove tcp:${ports.minicap}`).catch(() => {});
    if (ports.minitouch) execAsync(`adb -s ${deviceId} forward --remove tcp:${ports.minitouch}`).catch(() => {});
    if (ports.scrcpy) execAsync(`adb -s ${deviceId} forward --remove tcp:${ports.scrcpy}`).catch(() => {});
    allocatedPorts.delete(deviceId);
  }
  previouslyStreamed.delete(deviceId);
}

/**
 * Start minitouch for a device. Returns true if minitouch is operational.
 * On non-rooted devices, minitouch may fail if /dev/input/event* nodes
 * are not accessible — the caller should fall back to ADB input commands.
 * When the device is rooted, minitouch is run via `su -c`.
 */
async function startMinitouch(deviceId: string, stream: DeviceStream, props: DeviceProperties, isRooted: boolean = false): Promise<boolean> {
  try {
    // Only kill leftover minitouch if a previous stream was stopped for this device.
    // On first start (cold boot), skip — saves 200-500ms. Boot cleanup handles stale processes.
    if (previouslyStreamed.has(deviceId)) {
      await killDeviceProcess(deviceId, 'minitouch');
    }

    const minitouchPath = await ensureMinitouch(props.arch);

    if (!props.binariesPushed) {
      const pushed = await pushIfNeeded(deviceId, minitouchPath, '/data/local/tmp/minitouch');
      if (pushed) {
        await execAsync(`adb -s ${deviceId} shell chmod 755 /data/local/tmp/minitouch`);
      }
    }

    const shellCmd = isRooted
      ? "su -c '/data/local/tmp/minitouch'"
      : '/data/local/tmp/minitouch';

    const minitouchProcess = spawn('adb', [
      '-s', deviceId, 'shell', shellCmd,
    ]);

    minitouchProcess.stderr?.on('data', (data) => {
      log(`minitouch [${deviceId}]: ${data.toString().trim()}`);
    });

    // Wait for minitouch to start or crash (same pattern as tryStartMinicap)
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        minitouchProcess.on('exit', (code) => {
          error(`minitouch exited early with code ${code} for ${deviceId}`);
          resolve(true);
        });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);

    if (exited) {
      log(`minitouch unavailable for ${deviceId} (likely /dev/input permission denied) — will use ADB input fallback`);
      return false;
    }

    // Re-establish forward — remove stale entry then create fresh
    const { port: minitouchPort } = await getOrAllocatePort(deviceId, 'minitouch');
    // Remove both by port and by abstract name (either could be stale)
    await execAsync(`adb -s ${deviceId} forward --remove tcp:${minitouchPort}`).catch(() => {});
    await execAsync(`adb forward --remove tcp:${minitouchPort}`).catch(() => {});
    await execAsync(`adb -s ${deviceId} forward tcp:${minitouchPort} localabstract:minitouch`);

    stream.minitouchProcess = minitouchProcess;
    stream.minitouchPort = minitouchPort;

    stream.minitouchSocket = createConnection(minitouchPort, '127.0.0.1', () => {
      log(`Connected to minitouch socket for device ${deviceId}`);
    });

    stream.minitouchSocket.on('error', (err) => {
      error(`Minitouch socket error for ${deviceId}: ${err.message}`);
    });

    // If minitouch dies after initial startup, clean up the socket
    // so the touch handler falls back to ADB input
    minitouchProcess.on('exit', () => {
      log(`minitouch process exited for ${deviceId} — disabling minitouch socket`);
      stream.minitouchSocket?.destroy();
      stream.minitouchSocket = null;
      stream.minitouchProcess = null;
    });

    return true;
  } catch (err: any) {
    error(`Failed to start minitouch for ${deviceId}: ${err.message}`);
    return false;
  }
}

/**
 * Try to start minicap for a device. Returns true if successful, false otherwise.
 * Minicap is known to fail on Android 11+ (API 30+) due to ABI incompatibilities.
 */
async function tryStartMinicap(deviceId: string, stream: DeviceStream, props: DeviceProperties): Promise<boolean> {
  try {
    // Minicap's native .so is incompatible with API 33+ — prebuilt libs only go
    // up to API 32 and the linker will fail with "cannot locate symbol" errors.
    // Skip entirely and let the caller fall back to scrcpy.
    if (props.apiLevel >= 33) {
      log(`Skipping minicap for ${deviceId} — API ${props.apiLevel} is unsupported (max API 32)`);
      return false;
    }

    // Only kill leftover minicap if a previous stream was stopped for this device.
    if (previouslyStreamed.has(deviceId)) {
      await killDeviceProcess(deviceId, 'minicap');
    }

    log(`Attempting minicap for ${props.arch} (API ${props.apiLevel})`);
    const minicapPaths = await ensureMinicap(props.arch, props.apiLevel);

    if (!props.binariesPushed) {
      const [pushedBin, pushedSo] = await Promise.all([
        pushIfNeeded(deviceId, minicapPaths.binary, '/data/local/tmp/minicap'),
        pushIfNeeded(deviceId, minicapPaths.sharedLib, '/data/local/tmp/minicap.so'),
      ]);
      if (pushedBin) {
        await execAsync(`adb -s ${deviceId} shell chmod 755 /data/local/tmp/minicap`);
      }
    }

    const sizeStr = `${props.screenWidth}x${props.screenHeight}@${props.screenWidth}x${props.screenHeight}/0`;
    const minicapProcess = spawn('adb', [
      '-s', deviceId, 'shell',
      'LD_LIBRARY_PATH=/data/local/tmp', '/data/local/tmp/minicap',
      '-P', sizeStr,
    ]);

    // Collect stderr to detect linker errors
    let stderrOutput = '';
    minicapProcess.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      stderrOutput += msg + '\n';
      log(`minicap [${deviceId}]: ${msg}`);
    });

    // Wait for minicap to start (or crash)
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        minicapProcess.on('exit', (code) => {
          error(`minicap exited early with code ${code} for ${deviceId}`);
          resolve(true);
        });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    if (exited) {
      // Process crashed (e.g. linker error on API 31+)
      const reason = stderrOutput.includes('CANNOT LINK')
        ? 'ABI incompatibility (minicap does not support this Android version)'
        : `process exited: ${stderrOutput.slice(0, 200)}`;
      error(`Minicap failed for ${deviceId}: ${reason}`);
      return false;
    }

    const { port: minicapPort, isNew: needsForward } = await getOrAllocatePort(deviceId, 'minicap');
    if (needsForward) {
      await execAsync(`adb -s ${deviceId} forward tcp:${minicapPort} localabstract:minicap`);
    }

    stream.minicapProcess = minicapProcess;
    stream.minicapPort = minicapPort;

    stream.minicapSocket = createConnection(minicapPort, '127.0.0.1', () => {
      log(`Connected to minicap socket for device ${deviceId}`);
    });

    stream.minicapSocket.on('data', (chunk) => handleMinicapData(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    stream.minicapSocket.on('error', (err) => {
      error(`Minicap socket error for ${deviceId}: ${err.message}`);
    });

    attachMinicapExitHandler(deviceId, stream, minicapProcess);

    return true;
  } catch (err: any) {
    error(`Failed to start minicap for ${deviceId}: ${err.message}`);
    return false;
  }
}

/**
 * Broadcast a JPEG frame to all viewers of a stream.
 */
function broadcastFrame(stream: DeviceStream, jpegData: Buffer): void {
  const base64Frame = jpegData.toString('base64');
  const message = JSON.stringify({
    type: 'device-frame',
    deviceId: stream.deviceId,
    frame: base64Frame,
    timestamp: Date.now(),
  });
  const sent = new Set<WebSocket>();
  for (const [viewerId, viewer] of stream.viewers.entries()) {
    if (!sent.has(viewer) && viewer.readyState === 1 && !stream.pausedViewers.has(viewerId)) {
      viewer.send(message);
      sent.add(viewer);
    }
  }
}

/**
 * Capture a single PNG frame via `adb exec-out screencap -p`. No /sdcard
 * round-trip — frame goes straight through stdout. Intended for the
 * polling fallback loop, where 2fps × per-device cost is hot.
 */
async function captureFrameViaAdb(deviceId: string): Promise<Buffer> {
  const { stdout } = await execAsync(
    `adb -s ${deviceId} exec-out screencap -p`,
    { encoding: 'buffer' as any, maxBuffer: 50 * 1024 * 1024, timeout: 5000 },
  );
  return stdout as unknown as Buffer;
}

/**
 * Start ADB-screencap polling as a last-resort fallback when minicap +
 * scrcpy are unavailable or have died. No-op if `stream.pollTimer` is
 * already set. Tick captures a frame only when at least one viewer is
 * watching, and broadcasts via the existing `device-frame` path.
 */
function startPollingFallback(
  deviceId: string,
  stream: DeviceStream,
): void {
  if (stream.pollTimer) return;
  log(`Starting adb-screencap polling fallback for ${deviceId} @ ${1000 / POLL_FALLBACK_INTERVAL_MS} fps`);
  stream.pollTimer = setInterval(async () => {
    if (stream.viewers.size === 0) return;
    try {
      const frame = await captureFrameViaAdb(deviceId);
      broadcastFrame(stream, frame);
    } catch (err: any) {
      error(`adb polling capture failed for ${deviceId}: ${err.message}`);
    }
  }, POLL_FALLBACK_INTERVAL_MS);
}

/**
 * Attach a persistent exit handler to a minicap child process so that if it
 * dies after startup — while viewers are still watching — the stream
 * transparently switches to adb-screencap polling instead of going black.
 *
 * Only wire this up AFTER startup is confirmed successful; the
 * Promise.race-based handler inside tryStartMinicap is a separate one-shot
 * that resolves the startup decision.
 */
function attachMinicapExitHandler(deviceId: string, stream: DeviceStream, proc: ChildProcess): void {
  proc.on('exit', (code) => {
    log(`minicap exited for ${deviceId} (code ${code})`);
    stream.minicapProcess = null;
    stream.minicapSocket?.destroy();
    stream.minicapSocket = null;
    if (stream.viewers.size > 0 && !stream.pollTimer) {
      log(`minicap died while viewers active on ${deviceId} — switching to adb polling`);
      startPollingFallback(deviceId, stream);
    }
  });
}

/**
 * Persistent exit handler for scrcpy-server. Same contract as
 * attachMinicapExitHandler — fires only on deaths that happen after the
 * startup handshake has completed.
 */
function attachScrcpyExitHandler(deviceId: string, stream: DeviceStream, proc: ChildProcess): void {
  proc.on('exit', (code) => {
    log(`scrcpy-server exited for ${deviceId} (code ${code})`);
    stream.scrcpyProcess = null;
    if (stream.intentionalRestart) {
      // Controlled restart triggered by triggerStreamReset (bitrate upstep or
      // backpressure-driven reset). The socket close handler will relaunch
      // scrcpy — do NOT fall back to polling.
      return;
    }
    if (stream.viewers.size > 0 && !stream.pollTimer) {
      log(`scrcpy died while viewers active on ${deviceId} — switching to adb polling`);
      startPollingFallback(deviceId, stream);
    }
  });
}

/**
 * Wire a scrcpy socket into the stream's StreamBroadcaster (H.264 binary broadcast).
 * Creates the broadcaster if not already present, re-registers any existing viewers,
 * and pipes raw Annex-B H.264 data from the socket into the broadcaster.
 */
export function attachScrcpyH264Pipeline(stream: DeviceStream, scrcpySocket: Socket): void {
  if (!stream.broadcaster) {
    stream.broadcaster = new StreamBroadcaster(() => Date.now(), {
      onResetRequested: (viewerId) => {
        log(`Viewer ${viewerId} requested reset due to backpressure on ${stream.deviceId}`);
        triggerStreamReset(stream, 'congestion');
      },
      onKeyframeWanted: (viewerId) => {
        // A viewer just joined — ask scrcpy for an immediate IDR so its first
        // decodable frame lands within the coordinator's rate-limit window
        // instead of waiting up to a full GOP. Coalesced across rapid joins.
        const action = stream.keyframeCoordinator.request();
        log(`keyframe-request ${stream.deviceId} viewer=${viewerId} reason=join action=${action}`);
      },
    });
  }
  // Re-add any viewers already on this stream (in case the broadcaster was just created post-restart)
  for (const [viewerId, viewer] of stream.viewers.entries()) {
    if (!stream.broadcaster.hasViewer(viewerId)) {
      stream.broadcaster.addViewer(viewerId, viewer);
    }
  }
  let h264BytesReceived = 0;
  scrcpySocket.on('data', (chunk: Buffer) => {
    if (h264BytesReceived === 0) {
      log(`scrcpy: first H.264 data received for ${stream.deviceId} (${chunk.length} bytes)`);
    }
    h264BytesReceived += chunk.length;
    stream.broadcaster?.ingest(chunk);
  });
  scrcpySocket.on('end', () => {
    log(`scrcpy socket closed for ${stream.deviceId} (${h264BytesReceived} bytes total)`);
  });
  scrcpySocket.on('error', (err: Error) => {
    error(`scrcpy socket error for ${stream.deviceId}: ${err.message}`);
  });
}

function triggerStreamReset(stream: DeviceStream, reason: 'congestion' | 'manual'): void {
  const newBitrate = reason === 'congestion'
    ? bitrateForTier(Math.min(stream.bitrateState.tier + 1, 4))
    : bitrateForTier(stream.bitrateState.tier);
  for (const viewer of stream.viewers.values()) {
    if (viewer.readyState === 1) {
      viewer.send(JSON.stringify({
        type: 'video-reset',
        deviceId: stream.deviceId,
        reason,
        newBitrate,
      }));
    }
  }
  if (reason === 'congestion') {
    stream.bitrateState = onReset(stream.bitrateState, Date.now());
  }
  stream.broadcaster?.reset();
  if (stream.scrcpyControlSocket) {
    try { stream.scrcpyControlSocket.destroy(); } catch { /* ignore */ }
    stream.scrcpyControlSocket = null;
  }
  stream.keyframeCoordinator.reset();
  // Mark the kill as a controlled restart so the exit/close handlers know not
  // to fall back to polling — the close handler will relaunch scrcpy at the
  // (potentially new) tier.
  stream.intentionalRestart = true;
  stream.scrcpyProcess?.kill();
  // The existing scrcpy auto-restart logic in scrcpySocket.on('close') will respawn
  // tryStartScrcpy, which reads stream.bitrateState.tier and passes the new bitrate.
}

function startBitrateUpstepTimer(stream: DeviceStream): void {
  if (stream.bitrateUpstepTimer) return;
  stream.bitrateUpstepTimer = setInterval(() => {
    if (!stream.broadcaster) return;
    if (stream.manualTier !== null) return;  // user pinned tier — no auto-upstep
    const prevTier = stream.bitrateState.tier;
    stream.bitrateState = onTick(stream.bitrateState, Date.now(), stream.broadcaster.isHealthy());
    if (stream.bitrateState.tier < prevTier) {
      log(`Stream healthy — upstepping ${stream.deviceId} from tier ${prevTier} to ${stream.bitrateState.tier} (${bitrateForTier(stream.bitrateState.tier)} bps)`);
      // Notify viewers so the reconnecting overlay shows during the brief gap.
      // Use 'manual' reason so triggerStreamReset doesn't downstep again.
      triggerStreamReset(stream, 'manual');
    }
  }, 1000);
}

function stopBitrateUpstepTimer(stream: DeviceStream): void {
  if (stream.bitrateUpstepTimer) {
    clearInterval(stream.bitrateUpstepTimer);
    stream.bitrateUpstepTimer = null;
  }
}

/**
 * Try to start scrcpy-server as a fallback for minicap.
 * scrcpy works on all Android versions, streaming raw H.264 via StreamBroadcaster.
 *
 * Pipeline: scrcpy → localabstract:scrcpy → adb forward → Node TCP socket
 *           → StreamBroadcaster (NAL parse + binary WebSocket broadcast)
 */
async function tryStartScrcpy(deviceId: string, stream: DeviceStream, props: DeviceProperties): Promise<boolean> {
  try {
    // Only kill leftover scrcpy if a previous stream was stopped for this device.
    if (previouslyStreamed.has(deviceId)) {
      await killDeviceProcess(deviceId, 'scrcpy');
    }

    const scrcpyJar = getScrcpyServerJar();
    const maxSize = Math.min(props.screenWidth, props.screenHeight, 1080);

    await pushIfNeeded(deviceId, scrcpyJar, '/data/local/tmp/scrcpy-server.jar');

    // Set up port forward — remove stale entries then create fresh
    const { port: scrcpyPort } = await getOrAllocatePort(deviceId, 'scrcpy');
    await execAsync(`adb -s ${deviceId} forward --remove tcp:${scrcpyPort}`).catch(() => {});
    await execAsync(`adb forward --remove tcp:${scrcpyPort}`).catch(() => {});
    await execAsync(`adb -s ${deviceId} forward tcp:${scrcpyPort} localabstract:scrcpy`);

    // Start scrcpy-server on device
    const bitrate = bitrateForTier(stream.bitrateState.tier);
    log(`Starting scrcpy-server on ${deviceId} (port ${scrcpyPort}, max_size=${maxSize}, tier=${stream.bitrateState.tier}, bitrate=${bitrate})`);
    const scrcpyProcess = spawn('adb', [
      '-s', deviceId, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server', '3.3.1',
      'tunnel_forward=true',
      'audio=false',
      'control=true',
      'cleanup=false',
      'raw_stream=true',
      'stay_awake=true',
      'power_off_on_close=false',
      `max_size=${maxSize}`,
      `video_bit_rate=${bitrateForTier(stream.bitrateState.tier)}`,
      'video_codec_options=i-frame-interval=2',
    ]);

    let scrcpyStderr = '';
    scrcpyProcess.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        scrcpyStderr += msg + '\n';
        log(`scrcpy [${deviceId}]: ${msg}`);
      }
    });

    scrcpyProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(`scrcpy stdout [${deviceId}]: ${msg}`);
    });

    // Wait for scrcpy-server to initialize
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        scrcpyProcess.on('exit', (code) => {
          error(`scrcpy-server exited early with code ${code} for ${deviceId}`);
          resolve(true);
        });
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);

    if (exited) {
      error(`scrcpy-server failed to start for ${deviceId}: ${scrcpyStderr.slice(0, 300)}`);
      // Port forward stays allocated for potential reuse
      return false;
    }

    // Connect to scrcpy via our own TCP socket — retry since server may still be starting
    log(`Connecting to scrcpy socket on port ${scrcpyPort} for ${deviceId}`);
    const scrcpySocket = await (async (): Promise<Socket> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const sock = await new Promise<Socket>((resolve, reject) => {
            const s = createConnection(scrcpyPort, '127.0.0.1', () => {
              clearTimeout(timer);
              resolve(s);
            });
            s.on('error', (err) => { clearTimeout(timer); reject(err); });
            const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 2000);
          });
          log(`Connected to scrcpy socket for device ${deviceId} (attempt ${attempt + 1})`);
          return sock;
        } catch (err: any) {
          if (attempt < 4) {
            log(`scrcpy socket attempt ${attempt + 1} failed for ${deviceId}: ${err.message}, retrying...`);
            await new Promise(r => setTimeout(r, 500));
          } else {
            error(`scrcpy socket connection failed for ${deviceId} after 5 attempts: ${err.message}`);
            throw err;
          }
        }
      }
      throw new Error('unreachable');
    })();

    attachScrcpyH264Pipeline(stream, scrcpySocket);

    // With control=true, scrcpy expects a second TCP connection on the same
    // localabstract:scrcpy forward for control messages. Open it now and
    // hold it on the stream for the lifetime of this scrcpy invocation.
    try {
      const controlSocket = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(scrcpyPort, '127.0.0.1', () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.on('error', (err) => { clearTimeout(timer); reject(err); });
        const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 2000);
      });
      controlSocket.on('error', (err) => {
        error(`scrcpy control socket error for ${deviceId}: ${err.message}`);
      });
      controlSocket.on('close', () => {
        log(`scrcpy control socket closed for ${deviceId}`);
        if (stream.scrcpyControlSocket === controlSocket) {
          stream.scrcpyControlSocket = null;
        }
      });
      stream.scrcpyControlSocket = controlSocket;
      log(`scrcpy control socket connected for ${deviceId}`);
    } catch (err: any) {
      // Non-fatal — video still works, we just lose recovery. Step-1
      // gap detection continues to observe drops; Step-3 backpressure
      // changes are unaffected.
      error(`scrcpy control socket connect failed for ${deviceId}: ${err.message} — continuing without recovery`);
    }

    stream.scrcpyProcess = scrcpyProcess;
    stream.scrcpyPort = scrcpyPort;
    stream.hasLiveVideo = true;

    // Track when scrcpy started for restart rate-limiting
    stream.scrcpyLastStartAt = Date.now();

    startBitrateUpstepTimer(stream);

    // Notify viewers of the active tier/bitrate so the health indicator stays accurate.
    const currentBitrate = bitrateForTier(stream.bitrateState.tier);
    for (const viewer of stream.viewers.values()) {
      if (viewer.readyState === 1) {
        viewer.send(JSON.stringify({
          type: 'video-config-change',
          deviceId,
          tier: stream.bitrateState.tier,
          bitrate: currentBitrate,
        }));
      }
    }

    // Auto-restart scrcpy when it exits unexpectedly (e.g., display reconfiguration from unlock)
    const MAX_SCRCPY_RESTARTS = 3;
    const MIN_HEALTHY_RUNTIME_MS = 15_000; // must run 15s+ to be considered healthy
    scrcpySocket.on('close', () => {
      stream.hasLiveVideo = false;
      const runtime = Date.now() - stream.scrcpyLastStartAt;

      // Controlled restart (bitrate upstep / backpressure reset) — relaunch
      // scrcpy without rate-limit gating, regardless of scrcpyProcess state.
      if (stream.intentionalRestart) {
        stream.intentionalRestart = false;
        log(`scrcpy intentional restart on ${deviceId} — relaunching at tier ${stream.bitrateState.tier}`);
        setTimeout(async () => {
          try {
            await killDeviceProcess(deviceId, 'scrcpy');
            const ok = await tryStartScrcpy(deviceId, stream, props);
            if (ok) log(`scrcpy intentional restart successful for ${deviceId}`);
          } catch (err: any) {
            error(`scrcpy intentional restart failed for ${deviceId}: ${err.message}`);
            if (stream.viewers.size > 0 && !stream.pollTimer) {
              log(`scrcpy intentional restart failed — falling back to adb polling on ${deviceId}`);
              startPollingFallback(deviceId, stream);
            }
          }
        }, 500);
        return;
      }

      // Only restart if: viewers connected, not intentionally stopped, under restart limit
      if (stream.viewers.size > 0 && stream.scrcpyProcess && stream.scrcpyRestartCount < MAX_SCRCPY_RESTARTS) {
        // If scrcpy keeps dying quickly, don't keep restarting
        if (runtime < MIN_HEALTHY_RUNTIME_MS) {
          stream.scrcpyRestartCount++;
        } else {
          stream.scrcpyRestartCount = 0; // Ran long enough — reset counter
        }

        if (stream.scrcpyRestartCount >= MAX_SCRCPY_RESTARTS) {
          error(`scrcpy keeps dying quickly for ${deviceId} (${stream.scrcpyRestartCount} rapid restarts) — giving up`);
          stream.scrcpyProcess = null;
          // scrcpy has terminally failed — fall back to adb polling so the
          // picture keeps flowing rather than emitting a hard failure event.
          if (stream.viewers.size > 0 && !stream.pollTimer) {
            log(`scrcpy terminal failure with viewers active on ${deviceId} — switching to adb polling`);
            startPollingFallback(deviceId, stream);
            stream.hasLiveVideo = true;
          }
          return;
        }

        log(`scrcpy closed for ${deviceId} after ${runtime}ms with ${stream.viewers.size} viewers — restarting (rapid restarts: ${stream.scrcpyRestartCount}/${MAX_SCRCPY_RESTARTS})`);
        stream.scrcpyProcess = null;
        setTimeout(async () => {
          try {
            await killDeviceProcess(deviceId, 'scrcpy');
            const ok = await tryStartScrcpy(deviceId, stream, props);
            if (ok) {
              log(`scrcpy restarted successfully for ${deviceId}`);
            }
          } catch (err: any) {
            error(`scrcpy restart failed for ${deviceId}: ${err.message}`);
          }
        }, 1500);
      } else if (stream.scrcpyProcess) {
        log(`scrcpy closed for ${deviceId} — no viewers or restart limit reached, not restarting`);
        stream.scrcpyProcess = null;
      }
    });

    attachScrcpyExitHandler(deviceId, stream, scrcpyProcess);

    log(`scrcpy stream pipeline started for ${deviceId}`);
    return true;
  } catch (err: any) {
    error(`Failed to start scrcpy for ${deviceId}: ${err.message}`);
    return false;
  }
}

/**
 * Test-only override hooks for startDeviceStream internals.
 * Allows unit tests to inject fake implementations without real ADB calls.
 */
interface StartStreamOverrides {
  tryStartMinicap?: (deviceId: string, stream: DeviceStream, props: DeviceProperties) => Promise<boolean>;
  tryStartScrcpy?: (deviceId: string, stream: DeviceStream, props: DeviceProperties) => Promise<boolean>;
  startMinitouch?: (deviceId: string, stream: DeviceStream, props: DeviceProperties, isRooted: boolean) => Promise<boolean>;
  getDeviceProperties?: (deviceId: string) => Promise<DeviceProperties>;
}
let _startStreamOverrides: StartStreamOverrides | null = null;

/**
 * Start a device stream. Sets up minitouch (touch input) and attempts minicap
 * (live video), then scrcpy as fallback. If both fail, the frontend uses
 * screenshot polling for display.
 */
async function startDeviceStream(deviceId: string, deviceManager: DeviceManager): Promise<DeviceStream> {
  // Wake the screen (but don't unlock — KEYCODE_MENU and wm dismiss-keyguard
  // cause display reconfigurations that kill scrcpy after ~2 seconds)
  try {
    await execAsync(`adb -s ${deviceId} shell input keyevent KEYCODE_WAKEUP`, { timeout: 3000 });
  } catch {
    // Device may not be connected yet — continue anyway
  }

  // Single cached call replaces 3-6 individual ADB shell calls
  const _getDeviceProperties = _startStreamOverrides?.getDeviceProperties ?? getDeviceProperties;
  const props = await _getDeviceProperties(deviceId);

  // Look up rooted status so minitouch can run with su when needed
  const deviceStatus = await deviceManager.getDeviceStatus(deviceId);
  const isRooted = deviceStatus?.isRooted ?? false;

  const stream: DeviceStream = {
    deviceId,
    minicapProcess: null,
    minicapSocket: null,
    minitouchProcess: null,
    minitouchSocket: null,
    scrcpyProcess: null,
    broadcaster: null,
    scrcpyPort: 0,
    hasLiveVideo: false,
    screenWidth: props.screenWidth,
    screenHeight: props.screenHeight,
    viewers: new Map(),
    registeredSocketHandlers: new Set(),
    banner: null,
    minicapPort: 0,
    minitouchPort: 0,
    buffer: Buffer.alloc(0),
    readingBanner: true,
    frameSize: 0,
    frameData: null,
    framePos: 0,
    pausedViewers: new Set(),
    scrcpyRestartCount: 0,
    scrcpyLastStartAt: 0,
    pollTimer: null,
    bitrateState: newAdapterState(),
    bitrateUpstepTimer: null,
    intentionalRestart: false,
    manualTier: null,
    scrcpyControlSocket: null,
    keyframeCoordinator: null as any, // assigned immediately below
    keyframeStats: {
      requestsReceived: 0,
      requestsSent: 0,
      requestsCoalesced: 0,
      lastReason: null,
    },
  };
  stream.keyframeCoordinator = new KeyframeCoordinator(() => {
    const sock = stream.scrcpyControlSocket;
    if (sock && sock.writable) {
      sock.write(Buffer.from([RESET_VIDEO_BYTE]));
      stream.keyframeStats.requestsSent++;
    }
  });

  // Start minitouch and minicap in parallel — minitouch is independent
  const _tryStartMinicap = _startStreamOverrides?.tryStartMinicap ?? tryStartMinicap;
  const _startMinitouch = _startStreamOverrides?.startMinitouch ?? startMinitouch;
  const [minicapOk, minitouchOk] = await Promise.all([
    _tryStartMinicap(deviceId, stream, props),
    _startMinitouch(deviceId, stream, props, isRooted),
  ]);

  // Mark binaries as pushed after first successful start
  props.binariesPushed = true;

  const touchBackend = minitouchOk ? 'minitouch' : 'adb input';

  if (minicapOk) {
    stream.hasLiveVideo = true;
    log(`Started stream for device ${deviceId} (minicap + ${touchBackend})`);
  } else {
    // Minicap failed — try scrcpy as fallback
    log(`Minicap unavailable for ${deviceId}, trying scrcpy fallback`);
    const _tryStartScrcpy = _startStreamOverrides?.tryStartScrcpy ?? tryStartScrcpy;
    const scrcpyOk = await _tryStartScrcpy(deviceId, stream, props);

    if (scrcpyOk) {
      log(`Started stream for device ${deviceId} (scrcpy + ${touchBackend})`);
    } else {
      startPollingFallback(deviceId, stream);
      stream.hasLiveVideo = true;
      log(`Started stream for device ${deviceId} (adb polling + ${touchBackend})`);
    }
  }

  activeStreams.set(deviceId, stream);
  return stream;
}

/**
 * Process incoming data from the minicap socket.
 * First reads the 24-byte banner, then processes frame chunks.
 */
function handleMinicapData(stream: DeviceStream, chunk: Buffer): void {
  stream.buffer = Buffer.concat([stream.buffer, chunk]);

  // Read banner first
  if (stream.readingBanner) {
    if (stream.buffer.length >= 24) {
      stream.banner = parseMinicapBanner(stream.buffer);
      if (stream.banner) {
        log(`Minicap banner: ${stream.banner.realWidth}x${stream.banner.realHeight}`);
        stream.buffer = stream.buffer.subarray(stream.banner.length);
      }
      stream.readingBanner = false;
    } else {
      return;
    }
  }

  // Process frames: each frame has a 4-byte LE size header followed by JPEG data
  while (stream.buffer.length >= 4) {
    if (stream.frameData === null) {
      // Read frame size (4 bytes LE)
      stream.frameSize = stream.buffer.readUInt32LE(0);
      stream.buffer = stream.buffer.subarray(4);
      stream.frameData = Buffer.alloc(stream.frameSize);
      stream.framePos = 0;
    }

    const remaining = stream.frameSize - stream.framePos;
    const available = Math.min(remaining, stream.buffer.length);
    stream.buffer.copy(stream.frameData!, stream.framePos, 0, available);
    stream.framePos += available;
    stream.buffer = stream.buffer.subarray(available);

    if (stream.framePos >= stream.frameSize) {
      // Complete frame — broadcast to all viewers
      const base64Frame = stream.frameData!.toString('base64');
      const message = JSON.stringify({
        type: 'device-frame',
        deviceId: stream.deviceId,
        frame: base64Frame,
        timestamp: Date.now(),
      });

      const sent = new Set<WebSocket>();
      for (const viewer of stream.viewers.values()) {
        if (!sent.has(viewer) && viewer.readyState === 1) { // OPEN
          viewer.send(message);
          sent.add(viewer);
        }
      }

      stream.frameData = null;
      stream.framePos = 0;
    } else {
      break; // Need more data
    }
  }
}

/**
 * Stop streaming for a device and clean up resources.
 */
function stopStream(deviceId: string): void {
  const stream = activeStreams.get(deviceId);
  if (!stream) return;

  // Track that this device had a stream — next start will run killDeviceProcess
  previouslyStreamed.add(deviceId);

  stopBitrateUpstepTimer(stream);

  // Null out scrcpy/broadcaster references BEFORE killing so that async
  // exit handlers see scrcpyProcess=null and skip the restart logic.
  const { scrcpyProcess } = stream;
  stream.scrcpyProcess = null;
  stream.broadcaster?.reset();
  stream.broadcaster = null;
  if (stream.scrcpyControlSocket) {
    try { stream.scrcpyControlSocket.destroy(); } catch { /* ignore */ }
    stream.scrcpyControlSocket = null;
  }
  stream.keyframeCoordinator.reset();

  if (stream.pollTimer) {
    clearInterval(stream.pollTimer);
    stream.pollTimer = null;
  }

  stream.minicapSocket?.destroy();
  stream.minitouchSocket?.destroy();
  stream.minicapProcess?.kill();
  stream.minitouchProcess?.kill();
  scrcpyProcess?.kill();

  // Kill device-side processes explicitly — on Windows the adb shell
  // child may not propagate SIGHUP, leaving orphans holding the socket.
  // Try both shell user and root (su) kills for processes started via su -c.
  execAsync(`adb -s ${deviceId} shell pkill -9 -f minitouch`, { timeout: 3000 }).catch(() => {});
  execAsync(`adb -s ${deviceId} shell pkill -9 -f minicap`, { timeout: 3000 }).catch(() => {});
  execAsync(`adb -s ${deviceId} shell pkill -9 -f scrcpy`, { timeout: 3000 }).catch(() => {});
  execAsync(`adb -s ${deviceId} shell su -c 'pkill -9 -f minitouch'`, { timeout: 3000 }).catch(() => {});
  execAsync(`adb -s ${deviceId} shell su -c 'pkill -9 -f minicap'`, { timeout: 3000 }).catch(() => {});
  execAsync(`adb -s ${deviceId} shell su -c 'pkill -9 -f scrcpy'`, { timeout: 3000 }).catch(() => {});

  // Port forwards are intentionally NOT removed — they're lightweight and
  // reusable across stream restarts. Cleaned up on device disconnect via
  // clearDeviceStreamCache().

  activeStreams.delete(deviceId);
  log(`Stopped stream for device ${deviceId}`);
  log(`keyframe-stats for ${deviceId}: received=${stream.keyframeStats.requestsReceived} sent=${stream.keyframeStats.requestsSent} coalesced=${stream.keyframeStats.requestsCoalesced}`);
}

/**
 * Register all WebSocket endpoints for device live streaming.
 */
export function registerLiveStreamEndpoints(deviceManager: DeviceManager, iosDeviceManager?: IosDeviceManager): void {
  _iosDeviceManagerRef = iosDeviceManager ?? null;

  // Release cached ports + adb forwards when a device drops. Without this,
  // allocatedPorts holds the deviceId → port mapping forever, and the ADB
  // forward keeps the local port busy, so the 9200–9399 range fills up.
  deviceManager.onDeviceOffline(deviceId => {
    stopStream(deviceId);
    clearDeviceStreamCache(deviceId);
  });

  /** Check if a device is iOS (cheap — synchronous Set lookup, no DB query). */
  const isIosDevice = (deviceId: string): boolean =>
    iosDeviceManager?.isOnline(deviceId) ?? false;

  // Start streaming for a device
  registerWebsocketEndpoint('device-stream-start', async (message, socket) => {
    const { deviceId, viewerId: rawViewerId } = message;
    const viewerId: string = rawViewerId ?? randomUUID();
    if (!deviceId) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId' }));
      return;
    }

    // iOS devices use WDA screenshot polling instead of ADB-based streaming
    const status = await deviceManager.getDeviceStatus(deviceId);
    if (status?.platform === 'ios') {
      if (!iosDeviceManager) {
        socket.send(JSON.stringify({ type: 'error', error: 'iOS device manager not available' }));
        return;
      }

      // Check WDA is running
      const wdaStatus = await iosDeviceManager.wdaStatus(deviceId);
      if (!wdaStatus.running) {
        // Try to auto-launch WDA
        try {
          await iosDeviceManager.launchWda(deviceId);
        } catch (err: any) {
          socket.send(JSON.stringify({ type: 'error', error: `WDA not available: ${err.message}. Install and launch WDA first.` }));
          return;
        }
      }

      deviceManager.recordInteraction(deviceId);

      let iosStream = activeIosStreams.get(deviceId);
      if (!iosStream) {
        iosStream = startIosStream(deviceId);
      }

      iosStream.viewers.set(viewerId, socket);
      log(`iOS viewer connected to device ${deviceId} (${iosStream.viewers.size} viewers)`);

      socket.send(JSON.stringify({
        type: 'device-stream-started',
        deviceId,
        banner: null,
        liveVideo: true,
        backend: 'wda-polling',
        screenWidth: iosStream.screenWidth,
        screenHeight: iosStream.screenHeight,
      }));

      // Register socket close handler
      if (!iosStream.registeredSocketHandlers.has(socket)) {
        iosStream.registeredSocketHandlers.add(socket);
        socket.on('close', () => {
          const s = activeIosStreams.get(deviceId);
          if (!s) return;
          for (const [vid, sock] of s.viewers) {
            if (sock === socket) s.viewers.delete(vid);
          }
          s.registeredSocketHandlers.delete(socket);
          log(`iOS socket closed for device ${deviceId} (${s.viewers.size} viewers)`);
          if (s.viewers.size === 0) {
            setTimeout(() => {
              const cur = activeIosStreams.get(deviceId);
              if (cur && cur.viewers.size === 0) stopIosStream(deviceId);
            }, 30_000);
          }
        });
      }
      return;
    }

    deviceManager.recordInteraction(deviceId);

    let stream = activeStreams.get(deviceId);
    if (!stream) {
      try {
        // Guard against concurrent starts — if another viewer already
        // triggered startup, await that same promise instead of racing
        let pending = pendingStarts.get(deviceId);
        if (!pending) {
          pending = startDeviceStream(deviceId, deviceManager);
          pendingStarts.set(deviceId, pending);
        }
        stream = await pending;
        pendingStarts.delete(deviceId);
      } catch (err: any) {
        pendingStarts.delete(deviceId);
        error(`Failed to start stream for ${deviceId}: ${err.message}`);
        socket.send(JSON.stringify({ type: 'error', error: `Failed to start stream: ${err.message}` }));
        return;
      }
    }

    stream.viewers.set(viewerId, socket);
    stream.broadcaster?.addViewer(viewerId, socket);
    log(`Viewer connected to device ${deviceId} (${stream.viewers.size} viewers)`);

    socket.send(JSON.stringify({
      type: 'device-stream-started',
      deviceId,
      banner: stream.banner,
      liveVideo: stream.hasLiveVideo,
      backend: stream.scrcpyProcess ? 'scrcpy' : stream.minicapProcess ? 'minicap' : 'polling',
      screenWidth: stream.screenWidth,
      screenHeight: stream.screenHeight,
    }));

    // Register a socket close handler only once per socket per stream
    if (!stream.registeredSocketHandlers.has(socket)) {
      stream.registeredSocketHandlers.add(socket);
      socket.on('close', () => {
        const s = activeStreams.get(deviceId);
        if (!s) return;
        for (const [vid, sock] of s.viewers) {
          if (sock === socket) s.viewers.delete(vid);
          if (sock === socket && s.broadcaster) s.broadcaster.removeViewer(vid);
        }
        s.registeredSocketHandlers.delete(socket);
        log(`Socket closed for device ${deviceId} (${s.viewers.size} viewers)`);
        if (s.viewers.size === 0) {
          setTimeout(() => {
            const cur = activeStreams.get(deviceId);
            if (cur && cur.viewers.size === 0) stopStream(deviceId);
          }, 30_000);
        }
      });
    }
  }, { requires: ['core.devices:read'] });

  // Stop streaming for a device
  registerWebsocketEndpoint('device-stream-stop', (message, socket) => {
    const { deviceId, viewerId } = message;
    if (!deviceId) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId' }));
      return;
    }

    // Handle iOS stream stop
    const iosStream = activeIosStreams.get(deviceId);
    if (iosStream) {
      if (viewerId) {
        iosStream.viewers.delete(viewerId);
      } else {
        for (const [vid, sock] of iosStream.viewers) {
          if (sock === socket) iosStream.viewers.delete(vid);
        }
      }
      log(`iOS viewer stopped stream for device ${deviceId} (${iosStream.viewers.size} viewers)`);
      if (iosStream.viewers.size === 0) {
        setTimeout(() => {
          const cur = activeIosStreams.get(deviceId);
          if (cur && cur.viewers.size === 0) stopIosStream(deviceId);
        }, 30_000);
      }
      socket.send(JSON.stringify({ type: 'device-stream-stopped', deviceId }));
      return;
    }

    const stream = activeStreams.get(deviceId);
    if (stream) {
      if (viewerId) {
        stream.viewers.delete(viewerId);
        stream.broadcaster?.removeViewer(viewerId);
      } else {
        // Fallback: remove all entries for this socket (legacy clients)
        for (const [vid, sock] of stream.viewers) {
          if (sock === socket) {
            stream.viewers.delete(vid);
            stream.broadcaster?.removeViewer(vid);
          }
        }
      }
      log(`Viewer stopped stream for device ${deviceId} (${stream.viewers.size} viewers)`);
      if (stream.viewers.size === 0) {
        setTimeout(() => {
          const cur = activeStreams.get(deviceId);
          if (cur && cur.viewers.size === 0) stopStream(deviceId);
        }, 30_000);
      }
    }

    socket.send(JSON.stringify({ type: 'device-stream-stopped', deviceId }));
  }, { requires: ['core.devices:read'] });

  // Pause frame delivery (tab hidden)
  registerWebsocketEndpoint('device-stream-pause', (message) => {
    const { deviceId, viewerId } = message;
    if (!deviceId || !viewerId) return;
    const iosStream = activeIosStreams.get(deviceId);
    if (iosStream) {
      iosStream.pausedViewers.add(viewerId);
      log(`iOS viewer ${viewerId} paused for device ${deviceId}`);
      return;
    }
    const stream = activeStreams.get(deviceId);
    if (stream) {
      stream.pausedViewers.add(viewerId);
      log(`Viewer ${viewerId} paused for device ${deviceId}`);
    }
  }, { requires: ['core.devices:read'] });

  // Resume frame delivery (tab visible)
  registerWebsocketEndpoint('device-stream-resume', (message) => {
    const { deviceId, viewerId } = message;
    if (!deviceId || !viewerId) return;
    const iosStream = activeIosStreams.get(deviceId);
    if (iosStream) {
      iosStream.pausedViewers.delete(viewerId);
      log(`iOS viewer ${viewerId} resumed for device ${deviceId}`);
      return;
    }
    const stream = activeStreams.get(deviceId);
    if (stream) {
      stream.pausedViewers.delete(viewerId);
      log(`Viewer ${viewerId} resumed for device ${deviceId}`);
    }
  }, { requires: ['core.devices:read'] });

  // Restart streaming (tear down + re-setup) — used by the "Retry Stream" button
  registerWebsocketEndpoint('device-stream-restart', async (message, socket) => {
    const { deviceId, viewerId: rawViewerId } = message;
    const viewerId: string = rawViewerId ?? randomUUID();
    if (!deviceId) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId' }));
      return;
    }

    const restartStatus = await deviceManager.getDeviceStatus(deviceId);
    if (restartStatus?.platform === 'ios') {
      // Restart iOS stream: stop and re-create
      stopIosStream(deviceId);
      if (iosDeviceManager) {
        try {
          await iosDeviceManager.launchWda(deviceId);
        } catch (err: any) {
          socket.send(JSON.stringify({ type: 'error', error: `WDA restart failed: ${err.message}` }));
          return;
        }
        const iosStream = startIosStream(deviceId);
        iosStream.viewers.set(viewerId, socket);
        socket.send(JSON.stringify({
          type: 'device-stream-started',
          deviceId,
          banner: null,
          liveVideo: true,
          backend: 'wda-polling',
          screenWidth: 0,
          screenHeight: 0,
        }));

        // Register socket close handler so viewers are cleaned up
        if (!iosStream.registeredSocketHandlers.has(socket)) {
          iosStream.registeredSocketHandlers.add(socket);
          socket.on('close', () => {
            const s = activeIosStreams.get(deviceId);
            if (!s) return;
            for (const [vid, sock] of s.viewers) {
              if (sock === socket) s.viewers.delete(vid);
            }
            s.registeredSocketHandlers.delete(socket);
            log(`iOS socket closed for device ${deviceId} (${s.viewers.size} viewers)`);
            if (s.viewers.size === 0) {
              setTimeout(() => {
                const cur = activeIosStreams.get(deviceId);
                if (cur && cur.viewers.size === 0) stopIosStream(deviceId);
              }, 30_000);
            }
          });
        }
      }
      return;
    }

    log(`Stream restart requested for device ${deviceId}`);

    // Save current tier so manual restart doesn't drop the user back to tier 1
    const existingStream = activeStreams.get(deviceId);
    const savedTier = existingStream?.bitrateState?.tier ?? 1;

    // Tear down existing stream completely
    stopStream(deviceId);

    // Start fresh
    try {
      let pending = pendingStarts.get(deviceId);
      if (!pending) {
        pending = startDeviceStream(deviceId, deviceManager);
        pendingStarts.set(deviceId, pending);
      }
      const stream = await pending;
      // Restore the tier so the new stream starts at the same quality level
      stream.bitrateState = { tier: savedTier, lastRestartAtMs: Date.now(), healthySinceMs: null };
      pendingStarts.delete(deviceId);

      stream.viewers.set(viewerId, socket);
      stream.broadcaster?.addViewer(viewerId, socket);

      socket.send(JSON.stringify({
        type: 'device-stream-started',
        deviceId,
        banner: stream.banner,
        liveVideo: stream.hasLiveVideo,
        backend: stream.scrcpyProcess ? 'scrcpy' : stream.minicapProcess ? 'minicap' : 'polling',
        screenWidth: stream.screenWidth,
        screenHeight: stream.screenHeight,
      }));

      // Register socket close handler
      if (!stream.registeredSocketHandlers.has(socket)) {
        stream.registeredSocketHandlers.add(socket);
        socket.on('close', () => {
          const s = activeStreams.get(deviceId);
          if (!s) return;
          for (const [vid, sock] of s.viewers) {
            if (sock === socket) {
              s.viewers.delete(vid);
              s.broadcaster?.removeViewer(vid);
            }
          }
          s.registeredSocketHandlers.delete(socket);
          if (s.viewers.size === 0) {
            setTimeout(() => {
              const cur = activeStreams.get(deviceId);
              if (cur && cur.viewers.size === 0) stopStream(deviceId);
            }, 30_000);
          }
        });
      }
    } catch (err: any) {
      pendingStarts.delete(deviceId);
      error(`Failed to restart stream for ${deviceId}: ${err.message}`);
      socket.send(JSON.stringify({ type: 'error', error: `Failed to restart stream: ${err.message}` }));
    }
  }, { requires: ['core.devices:read'] });

  registerWebsocketEndpoint('device-stream-set-tier', (message) => {
    const { deviceId, tier } = message;
    if (!deviceId) return;
    const stream = activeStreams.get(deviceId);
    if (!stream) return;

    if (tier === null || tier === 'auto') {
      if (stream.manualTier === null) return; // already auto
      log(`Manual bitrate cleared for ${deviceId} — resuming auto`);
      stream.manualTier = null;
      return; // tier stays at whatever auto landed on; upstep timer will re-evaluate
    }

    const t = Number(tier);
    if (!Number.isInteger(t) || t < 0 || t > 4) return;
    if (stream.manualTier === t) return; // no-op

    log(`Manual bitrate set for ${deviceId} — pinning to tier ${t} (${bitrateForTier(t)} bps)`);
    stream.manualTier = t;
    stream.bitrateState = { tier: t, lastRestartAtMs: Date.now(), healthySinceMs: null };
    triggerStreamReset(stream, 'manual');
  }, { requires: ['core.devices:read'] });

  registerWebsocketEndpoint('device-stream-request-keyframe', (message) => {
    const { deviceId, viewerId, reason } = message;
    if (!deviceId) return;
    const stream = activeStreams.get(deviceId);
    if (!stream) return; // viewer raced a stream stop — silent no-op

    if (reason !== 'gap' && reason !== 'decode-error' && reason !== 'watchdog') {
      log(`keyframe-request ${deviceId} ignored: unknown reason ${JSON.stringify(reason)}`);
      return;
    }
    stream.keyframeStats.requestsReceived++;
    stream.keyframeStats.lastReason = reason;
    const action = stream.keyframeCoordinator.request();
    if (action === 'coalesced') stream.keyframeStats.requestsCoalesced++;
    log(`keyframe-request ${deviceId} viewer=${viewerId ?? '?'} reason=${reason} action=${action}`);
  }, { requires: ['core.devices:read'] });

  // Forward touch input to device
  registerWebsocketEndpoint('device-touch', async (message, _socket) => {
    const { deviceId, eventType, x, y } = message;
    if (!deviceId || !eventType) return;

    deviceManager.recordInteraction(deviceId);

    // iOS: route touch through WDA (or drop if WDA unavailable)
    if (isIosDevice(deviceId)) {
      if (activeIosStreams.has(deviceId) && iosDeviceManager && eventType === 'down') {
        try {
          await iosDeviceManager.wdaTap(deviceId, x, y);
        } catch (err: any) {
          error(`WDA tap failed for ${deviceId}: ${err.message}`);
        }
      }
      return;
    }

    const stream = activeStreams.get(deviceId);

    // Pre-emptive IDR: a touch-down often signals motion that stresses
    // the on-device H.264 encoder. Asking scrcpy for a fresh keyframe
    // here means the IDR lands during the high-motion period rather
    // than waiting up to one full GOP for the natural cadence. The
    // Step 2 coordinator's 500 ms rate-limit collapses rapid taps.
    if (stream && eventType === 'down') {
      const action = stream.keyframeCoordinator.request();
      log(`keyframe-request ${deviceId} reason=touch action=${action}`);
    }

    if (stream?.minitouchSocket) {
      // Minitouch available — coordinates are already device pixels
      const cmd = buildMinitouchCommand(eventType, x, y);
      stream.minitouchSocket.write(cmd);
    } else if (eventType === 'down') {
      // ADB tap fallback (only fire on 'down' to avoid duplicate taps)
      try {
        await execAsync(
          `adb -s ${deviceId} shell input tap ${Math.round(x)} ${Math.round(y)}`,
          { timeout: 5000 },
        );
      } catch (err: any) {
        error(`ADB tap failed for ${deviceId}: ${err.message}`);
      }
    }
  }, { requires: ['core.devices:manage'] });

  // Swipe / drag gesture
  registerWebsocketEndpoint('device-swipe', async (message, socket) => {
    const { deviceId, startX, startY, endX, endY, durationMs } = message;
    if (!deviceId || startX == null || startY == null || endX == null || endY == null) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing swipe parameters' }));
      return;
    }

    deviceManager.recordInteraction(deviceId);
    const duration = durationMs ?? 300;

    // iOS: route swipe through WDA (or drop if WDA unavailable)
    if (isIosDevice(deviceId)) {
      if (activeIosStreams.has(deviceId) && iosDeviceManager) {
        try {
          await iosDeviceManager.wdaSwipe(deviceId, startX, startY, endX, endY, duration / 1000);
          socket.send(JSON.stringify({ type: 'device-swipe-done', deviceId }));
        } catch (err: any) {
          error(`WDA swipe failed for ${deviceId}: ${err.message}`);
          socket.send(JSON.stringify({ type: 'error', error: `Swipe failed: ${err.message}` }));
        }
      }
      return;
    }

    const stream = activeStreams.get(deviceId);
    if (stream?.minitouchSocket) {
      // Minitouch is active — real-time touch down/move/up events already
      // handled the swipe, so skip to avoid double-scrolling.
      socket.send(JSON.stringify({ type: 'device-swipe-done', deviceId }));
      return;
    } else {
      // ADB swipe fallback
      try {
        await execAsync(
          `adb -s ${deviceId} shell input swipe ${Math.round(startX)} ${Math.round(startY)} ${Math.round(endX)} ${Math.round(endY)} ${duration}`,
          { timeout: 10000 },
        );
      } catch (err: any) {
        error(`ADB swipe failed for ${deviceId}: ${err.message}`);
        socket.send(JSON.stringify({ type: 'error', error: `Swipe failed: ${err.message}` }));
        return;
      }
    }

    socket.send(JSON.stringify({ type: 'device-swipe-done', deviceId }));
  }, { requires: ['core.devices:manage'] });

  // Navigation buttons (back, home, recents)
  const NAV_KEYCODES: Record<string, string> = {
    back: 'KEYCODE_BACK',
    home: 'KEYCODE_HOME',
    recents: 'KEYCODE_APP_SWITCH',
    power: 'KEYCODE_POWER',
    wake: 'KEYCODE_WAKEUP',
    sleep: 'KEYCODE_SLEEP',
  };

  // iOS nav button → WDA button name mapping
  const IOS_NAV_BUTTONS: Record<string, string> = {
    home: 'home',
    power: 'power',
    wake: 'power',
    sleep: 'power',
    volumeup: 'volumeUp',
    volumedown: 'volumeDown',
  };

  registerWebsocketEndpoint('device-nav', async (message, socket) => {
    const { deviceId, button } = message;
    if (!deviceId || !button) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId or button' }));
      return;
    }

    deviceManager.recordInteraction(deviceId);

    // iOS: route nav through WDA press button (or drop if WDA unavailable)
    if (isIosDevice(deviceId)) {
      if (activeIosStreams.has(deviceId) && iosDeviceManager) {
        const wdaButton = IOS_NAV_BUTTONS[button];
        if (!wdaButton) {
          socket.send(JSON.stringify({ type: 'error', error: `Unsupported iOS nav button: ${button}` }));
          return;
        }
        try {
          await iosDeviceManager.wdaPressButton(deviceId, wdaButton);
          socket.send(JSON.stringify({ type: 'device-nav-done', deviceId, button }));
        } catch (err: any) {
          error(`WDA nav button ${button} failed for ${deviceId}: ${err.message}`);
          socket.send(JSON.stringify({ type: 'error', error: `Nav failed: ${err.message}` }));
        }
      }
      return;
    }

    const keycode = NAV_KEYCODES[button];
    if (!keycode) {
      socket.send(JSON.stringify({ type: 'error', error: `Unknown nav button: ${button}` }));
      return;
    }

    try {
      await execAsync(`adb -s ${deviceId} shell input keyevent ${keycode}`, { timeout: 5000 });
      socket.send(JSON.stringify({ type: 'device-nav-done', deviceId, button }));
    } catch (err: any) {
      error(`Nav button ${button} failed for ${deviceId}: ${err.message}`);
      socket.send(JSON.stringify({ type: 'error', error: `Nav failed: ${err.message}` }));
    }
  }, { requires: ['core.devices:manage'] });

  // Browser key name → ADB keycode mapping
  const KEY_MAP: Record<string, string> = {
    'Enter': 'KEYCODE_ENTER',
    'Backspace': 'KEYCODE_DEL',
    'Delete': 'KEYCODE_FORWARD_DEL',
    'Escape': 'KEYCODE_BACK',
    'Tab': 'KEYCODE_TAB',
    ' ': 'KEYCODE_SPACE',
    'ArrowUp': 'KEYCODE_DPAD_UP',
    'ArrowDown': 'KEYCODE_DPAD_DOWN',
    'ArrowLeft': 'KEYCODE_DPAD_LEFT',
    'ArrowRight': 'KEYCODE_DPAD_RIGHT',
    'Home': 'KEYCODE_HOME',
    'End': 'KEYCODE_MOVE_END',
    'PageUp': 'KEYCODE_PAGE_UP',
    'PageDown': 'KEYCODE_PAGE_DOWN',
  };

  // Forward key events to device via ADB (or WDA for iOS)
  registerWebsocketEndpoint('device-key', async (message, socket) => {
    const { deviceId, key } = message;
    if (!deviceId || !key) {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing deviceId or key' }));
      return;
    }

    deviceManager.recordInteraction(deviceId);

    // iOS: key input not yet supported via WDA — skip silently
    if (isIosDevice(deviceId)) {
      return;
    }

    try {
      const keycode = KEY_MAP[key];
      if (keycode) {
        await execAsync(`adb -s ${deviceId} shell input keyevent ${keycode}`, { timeout: 5000 });
      } else if (key.length === 1) {
        // Single character — use adb input text (execFile avoids shell parsing)
        await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'text', key], { timeout: 5000 });
      } else {
        // Unknown special key — ignore
        return;
      }
      socket.send(JSON.stringify({ type: 'device-key-sent', deviceId, key }));
    } catch (err: any) {
      error(`Failed to send key ${key} to ${deviceId}: ${err.message}`);
      socket.send(JSON.stringify({ type: 'error', error: `Key event failed: ${err.message}` }));
    }
  }, { requires: ['core.devices:manage'] });

  // Clean up stale ADB forwards and device processes from a previous server run.
  (async () => {
    try {
      // Remove all ADB forwards in our port range — they persist across restarts
      const { stdout: fwdList } = await execAsync('adb forward --list', { timeout: 5000 }).catch(() => ({ stdout: '' }));
      let removed = 0;
      for (const line of fwdList.split('\n')) {
        const match = line.match(/tcp:(\d+)/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= STREAM_PORT_START && port <= STREAM_PORT_END) {
            await execAsync(`adb forward --remove tcp:${port}`).catch(() => {});
            removed++;
          }
        }
      }
      if (removed > 0) {
        log(`Boot: removed ${removed} stale ADB forward(s)`);
      }

      // Mark devices for stale process cleanup on first stream start
      const { stdout } = await execAsync('adb devices', { timeout: 5000 });
      const lines = stdout.split('\n').filter(l => l.includes('\tdevice'));
      for (const line of lines) {
        const id = line.split('\t')[0];
        previouslyStreamed.add(id);
      }
      if (lines.length > 0) {
        log(`Boot: marked ${lines.length} device(s) for stale process cleanup on first stream start`);
      }
    } catch {
      // ADB not available or no devices
    }
  })();

  log('Live stream WebSocket endpoints registered');
}

/** Check if a device has active stream viewers (used by standby to skip sleeping).
 *  Also returns true while a stream start is still in flight — during the
 *  multi-second Android stream setup no viewer is registered yet, which
 *  previously let the standby loop flip stay_on_while_plugged_in off and let
 *  the device's own idle timer turn the screen off mid-startup. */
export function hasActiveViewers(deviceId: string): boolean {
  if (pendingStarts.has(deviceId)) return true;
  const stream = activeStreams.get(deviceId);
  if ((stream?.viewers.size ?? 0) > 0) return true;
  const iosStream = activeIosStreams.get(deviceId);
  return (iosStream?.viewers.size ?? 0) > 0;
}

/** Test-only: seed/clear pendingStarts so unit tests can assert the behaviour above. */
export function __setPendingForTest(deviceId: string, pending: Promise<DeviceStream> | null): void {
  if (pending) pendingStarts.set(deviceId, pending);
  else pendingStarts.delete(deviceId);
}

export { activeStreams, stopStream, allocatePort, clearDeviceStreamCache, STREAM_PORT_START, STREAM_PORT_END };

// Test-only exports — keeps internals private in normal use.
export const startPollingFallbackForTest = startPollingFallback;
export const _captureFrameViaAdbImpl = captureFrameViaAdb;
export const startDeviceStreamForTest = startDeviceStream;
export const attachMinicapExitHandlerForTest = attachMinicapExitHandler;
export const attachScrcpyExitHandlerForTest = attachScrcpyExitHandler;
export function __setStartStreamOverridesForTest(overrides: StartStreamOverrides | null): void {
  _startStreamOverrides = overrides;
}
