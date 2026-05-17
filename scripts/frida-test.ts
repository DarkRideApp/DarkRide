#!/usr/bin/env npx tsx
/**
 * Frida Test Harness — CLI for iterative Frida script testing against Android devices.
 *
 * Wraps the DarkRide REST API to let Claude Code run Frida scripts, monitor app
 * stability, review logs, edit scripts, and re-run until the target app boots
 * without crashing.
 *
 * Usage:
 *   npx tsx scripts/frida-test.ts <command> [options]
 *
 * Commands:
 *   devices                         List connected devices
 *   scripts [--category <cat>]      List available Frida scripts
 *   run     [options]               Spawn app with scripts, monitor for crash/success
 *   logcat  [options]               Dump filtered logcat for a device
 *
 * Run options:
 *   --device, -d <id>               Device serial (required)
 *   --app, -a <bundleId>            App bundle ID to spawn (required)
 *   --scripts, -s <names>           Comma-separated script names from library
 *   --code, -c <path>               Path to a .js file with inline Frida code
 *   --timeout, -t <seconds>         Monitor duration (default: 30)
 *   --no-logcat                     Skip logcat capture
 *   --no-stop                       Leave Frida running after test
 *   --json                          Machine-readable JSON output
 *   --api <url>                     Override API base (default: http://localhost:3000)
 *
 * Logcat options:
 *   --device, -d <id>               Device serial (required)
 *   --app, -a <bundleId>            Filter logcat by package (optional)
 *   --lines <N>                     Number of logcat lines (default: 200)
 *
 * Examples:
 *   npx tsx scripts/frida-test.ts devices
 *   npx tsx scripts/frida-test.ts scripts --category analytics-bypass
 *   npx tsx scripts/frida-test.ts run -d <your-device-ip>:5555 -a com.example.app \
 *     -s "Dynatrace Full Disable,Flutter Bootloader Check Bypass" -t 30
 *   npx tsx scripts/frida-test.ts logcat -d <your-device-ip>:5555 -a com.example.app
 */

import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

let API_BASE = process.env.DARKRIDE_API || 'http://localhost:3000';
const DEFAULT_TIMEOUT = 30;
const POLL_INTERVAL = 2000;
const INITIAL_POLL_DELAY = 1000; // shorter first poll after spawn

const CRASH_PATTERNS = [
  /Process terminated/i,
  /Process crashed/i,
  /SIGKILL|SIGABRT|SIGSEGV/,
  /Fatal signal/i,
  /FATAL EXCEPTION/i,
  /java\.lang\.RuntimeException/,
  /Unable to start activity/i,
  /\bAbort message\b/i,
  /Build fingerprint:.*Abort/,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeviceInfo {
  id: string;
  name: string | null;
  model: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  isOnline: boolean;
  isRooted: boolean;
  isBusy: boolean;
}

interface ScriptInfo {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  isBuiltin: boolean;
}

interface FridaMessage {
  type: string;
  level?: string;
  payload: any;
  timestamp: string;
}

type Verdict = 'BOOT_SUCCESS' | 'CRASH' | 'TIMEOUT_NO_APP' | 'SPAWN_FAILED';

interface TestReport {
  verdict: Verdict;
  app: string;
  device: string;
  scripts: string[];
  durationMs: number;
  crashSignature: string | null;
  messages: FridaMessage[];
  logcat: string[];
}

interface RunOptions {
  device: string;
  app: string;
  scripts: string[];
  codePath: string | null;
  timeout: number;
  captureLogcat: boolean;
  noStop: boolean;
  json: boolean;
  controlled: boolean;
}

interface CliArgs {
  command: 'devices' | 'scripts' | 'run' | 'logcat' | 'help';
  device?: string;
  app?: string;
  scripts: string[];
  codePath?: string;
  timeout: number;
  captureLogcat: boolean;
  noStop: boolean;
  json: boolean;
  controlled: boolean;
  category?: string;
  lines: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stderr(msg: string): void {
  process.stderr.write(msg + '\n');
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour12: false });
  } catch {
    return iso;
  }
}

function matchesCrashPattern(text: string): string | null {
  for (const pat of CRASH_PATTERNS) {
    if (pat.test(text)) return text.slice(0, 200);
  }
  return null;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const url = `${API_BASE}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let resp: Response;
  try {
    resp = await fetch(url, opts);
  } catch (err: any) {
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to DarkRide API at ${API_BASE}. Is the server running?`);
    }
    throw err;
  }

  const json = (await resp.json()) as any;
  if (!resp.ok || json.success === false) {
    throw new Error(json.error || `API ${method} ${path} failed (${resp.status})`);
  }
  return json.data as T;
}

// --- Endpoint wrappers ---

async function listDevices(): Promise<DeviceInfo[]> {
  return api('GET', '/v1/device/list');
}

async function listScripts(): Promise<ScriptInfo[]> {
  return api('GET', '/v1/frida/scripts');
}

async function getFridaStatus(deviceId: string): Promise<{ status: string }> {
  return api('GET', `/v1/frida/status/${encodeURIComponent(deviceId)}`);
}

async function startFrida(deviceId: string): Promise<void> {
  await api('POST', `/v1/frida/start/${encodeURIComponent(deviceId)}`);
}

async function stopFrida(deviceId: string): Promise<void> {
  await api('POST', `/v1/frida/stop/${encodeURIComponent(deviceId)}`);
}

async function spawnApp(
  deviceId: string,
  bundleId: string,
  scripts: string[],
  code?: string,
  mode?: string,
): Promise<any> {
  return api('POST', `/v1/frida/spawn/${encodeURIComponent(deviceId)}`, {
    bundleId,
    scripts: scripts.length ? scripts : undefined,
    code: code || undefined,
    mode: mode || undefined,
  });
}

async function getMessages(
  deviceId: string,
  since: number,
): Promise<{ messages: FridaMessage[]; next_index: number }> {
  return api('GET', `/v1/frida/messages/${encodeURIComponent(deviceId)}?since=${since}`);
}

async function listRunningApps(
  deviceId: string,
): Promise<Array<{ name: string; identifier: string; pid: number | null }>> {
  return api('GET', `/v1/frida/apps/${encodeURIComponent(deviceId)}`);
}

async function shellCommand(deviceId: string, command: string): Promise<string> {
  const result = await api<{ output: string }>(
    'POST',
    `/v1/device/shell/${encodeURIComponent(deviceId)}`,
    { command },
  );
  return result.output;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const raw = process.argv.slice(2);
  const args: CliArgs = {
    command: 'help',
    scripts: [],
    timeout: DEFAULT_TIMEOUT,
    captureLogcat: true,
    noStop: false,
    json: false,
    controlled: false,
    lines: 200,
  };

  if (raw.length === 0) return args;

  // First non-flag arg is the subcommand
  const first = raw[0];
  if (!first.startsWith('-')) {
    if (['devices', 'scripts', 'run', 'logcat', 'help'].includes(first)) {
      args.command = first as CliArgs['command'];
    } else {
      stderr(`Unknown command: ${first}`);
      args.command = 'help';
      return args;
    }
  }

  for (let i = 1; i < raw.length; i++) {
    const arg = raw[i];
    const next = () => {
      if (i + 1 >= raw.length) throw new Error(`Missing value for ${arg}`);
      return raw[++i];
    };

    switch (arg) {
      case '--device': case '-d': args.device = next(); break;
      case '--app': case '-a': args.app = next(); break;
      case '--scripts': case '-s': args.scripts = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--code': case '-c': args.codePath = next(); break;
      case '--timeout': case '-t': args.timeout = parseInt(next(), 10); break;
      case '--no-logcat': args.captureLogcat = false; break;
      case '--no-stop': args.noStop = true; break;
      case '--controlled': args.controlled = true; break;
      case '--json': args.json = true; break;
      case '--category': args.category = next(); break;
      case '--lines': args.lines = parseInt(next(), 10); break;
      case '--api': API_BASE = next(); break;
      case '--help': case '-h': args.command = 'help'; break;
      default:
        stderr(`Unknown flag: ${arg}`);
        break;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Subcommand: devices
// ---------------------------------------------------------------------------

async function cmdDevices(args: CliArgs): Promise<void> {
  const devices = await listDevices();

  if (args.json) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }

  if (devices.length === 0) {
    console.log('No devices connected.');
    return;
  }

  console.log('=== Connected Devices ===\n');
  console.log(
    `${pad('ID', 28)} ${pad('Name', 14)} ${pad('Model', 18)} ${pad('Android', 9)} ${pad('Status', 8)} Root`,
  );
  console.log('-'.repeat(90));

  for (const d of devices) {
    const status = d.isOnline ? (d.isBusy ? 'busy' : 'online') : 'offline';
    console.log(
      `${pad(d.id, 28)} ${pad(d.name || '-', 14)} ${pad(d.model || '-', 18)} ${pad(d.androidVersion || '-', 9)} ${pad(status, 8)} ${d.isRooted ? 'yes' : 'no'}`,
    );
  }

  const online = devices.filter((d) => d.isOnline).length;
  console.log(`\nTotal: ${devices.length} devices (${online} online)`);
}

// ---------------------------------------------------------------------------
// Subcommand: scripts
// ---------------------------------------------------------------------------

async function cmdScripts(args: CliArgs): Promise<void> {
  let scripts = await listScripts();

  if (args.category) {
    scripts = scripts.filter((s) => s.category === args.category);
  }

  if (args.json) {
    console.log(JSON.stringify(scripts, null, 2));
    return;
  }

  if (scripts.length === 0) {
    console.log('No scripts found.');
    return;
  }

  // Group by category
  const groups = new Map<string, ScriptInfo[]>();
  for (const s of scripts) {
    const cat = s.category || 'uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(s);
  }

  console.log('=== Frida Script Library ===\n');

  for (const [category, items] of groups) {
    console.log(`${category} (${items.length}):`);
    for (const s of items) {
      const desc = s.description ? s.description.slice(0, 60) : '';
      console.log(`  ${pad(s.name, 45)} ${desc}`);
    }
    console.log('');
  }

  console.log(`Total: ${scripts.length} scripts`);
}

// ---------------------------------------------------------------------------
// Subcommand: run
// ---------------------------------------------------------------------------

async function cmdRun(args: CliArgs): Promise<void> {
  if (!args.device) {
    stderr('Error: --device is required for run command');
    process.exit(2);
  }
  if (!args.app) {
    stderr('Error: --app is required for run command');
    process.exit(2);
  }

  const opts: RunOptions = {
    device: args.device,
    app: args.app,
    scripts: args.scripts,
    codePath: args.codePath || null,
    timeout: args.timeout,
    captureLogcat: args.captureLogcat,
    noStop: args.noStop,
    json: args.json,
    controlled: args.controlled,
  };

  const report = await executeRun(opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.verdict === 'BOOT_SUCCESS' ? 0 : 1);
}

async function executeRun(opts: RunOptions): Promise<TestReport> {
  const allMessages: FridaMessage[] = [];
  let logcatLines: string[] = [];
  let crashSignature: string | null = null;
  let verdict: Verdict = 'BOOT_SUCCESS';

  // --- Phase 1: Setup ---
  stderr(`[setup] Checking device ${opts.device}...`);

  const devices = await listDevices();
  const device = devices.find((d) => d.id === opts.device);
  if (!device) {
    stderr(`[setup] Error: Device ${opts.device} not found.`);
    stderr(`[setup] Available devices: ${devices.map((d) => d.id).join(', ') || 'none'}`);
    return { verdict: 'SPAWN_FAILED', app: opts.app, device: opts.device, scripts: opts.scripts, durationMs: 0, crashSignature: 'Device not found', messages: [], logcat: [] };
  }
  if (!device.isOnline) {
    stderr(`[setup] Error: Device ${opts.device} is offline.`);
    return { verdict: 'SPAWN_FAILED', app: opts.app, device: opts.device, scripts: opts.scripts, durationMs: 0, crashSignature: 'Device offline', messages: [], logcat: [] };
  }

  const label = [device.manufacturer, device.model, device.androidVersion ? `Android ${device.androidVersion}` : ''].filter(Boolean).join(', ');
  stderr(`[setup] Device: ${opts.device} (${label})`);

  // Start frida-server if needed
  try {
    const status = await getFridaStatus(opts.device);
    if (status.status !== 'running') throw new Error('not running');
    stderr('[setup] Frida server already running');
  } catch {
    stderr('[setup] Starting frida-server...');
    await startFrida(opts.device);
    stderr('[setup] Frida server started');
  }

  // Read inline code file
  let inlineCode: string | undefined;
  if (opts.codePath) {
    try {
      inlineCode = readFileSync(opts.codePath, 'utf-8');
      stderr(`[setup] Loaded code from ${opts.codePath} (${inlineCode.length} chars)`);
    } catch (err: any) {
      stderr(`[setup] Error reading code file: ${err.message}`);
      return { verdict: 'SPAWN_FAILED', app: opts.app, device: opts.device, scripts: opts.scripts, durationMs: 0, crashSignature: `Cannot read code file: ${err.message}`, messages: [], logcat: [] };
    }
  }

  // Clear logcat before spawn
  if (opts.captureLogcat) {
    try {
      await shellCommand(opts.device, 'logcat -c');
    } catch { /* best effort */ }
  }

  // --- Phase 2: Spawn ---
  const scriptLabel = [...opts.scripts, opts.codePath ? `(+${opts.codePath})` : ''].filter(Boolean).join(', ') || '(no scripts)';
  stderr(`[spawn] Spawning ${opts.app} with: ${scriptLabel}`);

  const startTime = Date.now();
  try {
    await spawnApp(opts.device, opts.app, opts.scripts, inlineCode, opts.controlled ? 'controlled' : undefined);
  } catch (err: any) {
    stderr(`[spawn] FAILED: ${err.message}`);
    return { verdict: 'SPAWN_FAILED', app: opts.app, device: opts.device, scripts: opts.scripts, durationMs: Date.now() - startTime, crashSignature: err.message, messages: [], logcat: [] };
  }

  stderr(`[spawn] App spawned, monitoring for ${opts.timeout}s...`);

  // --- Phase 3: Monitor loop ---
  let messageIndex = 0;
  let isFirstPoll = true;

  while (Date.now() - startTime < opts.timeout * 1000) {
    await sleep(isFirstPoll ? INITIAL_POLL_DELAY : POLL_INTERVAL);
    isFirstPoll = false;

    // Poll messages
    try {
      const result = await getMessages(opts.device, messageIndex);
      if (result.messages.length > 0) {
        for (const msg of result.messages) {
          allMessages.push(msg);
          const payload = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
          const prefix = msg.type === 'error' ? '[frida:err]' : '[frida]';
          stderr(`${prefix} ${shortTime(msg.timestamp)} ${payload}`);

          // Check for crash
          const crash = matchesCrashPattern(payload);
          if (crash && !crashSignature) {
            crashSignature = crash;
            verdict = 'CRASH';
          }
        }
        messageIndex = result.next_index;
      }
    } catch {
      // Message polling failure — frida may have exited
    }

    // Break early on detected crash
    if (verdict === 'CRASH') {
      stderr(`[poll]  CRASH detected: ${crashSignature}`);
      break;
    }

    // Check if app is still running (skip first 5 seconds to avoid race)
    const elapsed = Date.now() - startTime;
    if (elapsed > 5000) {
      try {
        const apps = await listRunningApps(opts.device);
        const running = apps.find((a) => a.identifier === opts.app && a.pid);
        if (!running) {
          // Do one more message poll to catch any final crash output
          try {
            const final = await getMessages(opts.device, messageIndex);
            for (const msg of final.messages) {
              allMessages.push(msg);
              const payload = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
              stderr(`[frida] ${shortTime(msg.timestamp)} ${payload}`);
              const crash = matchesCrashPattern(payload);
              if (crash && !crashSignature) crashSignature = crash;
            }
          } catch { /* ignore */ }

          crashSignature = crashSignature || 'App not found in process list';
          verdict = 'CRASH';
          stderr('[poll]  App is no longer running');
          break;
        }
        const secs = Math.round(elapsed / 1000);
        stderr(`[poll]  ${secs}s - app running (pid ${running.pid})`);
      } catch {
        // App list query failed — non-fatal, will retry
      }
    } else {
      const secs = Math.round(elapsed / 1000);
      stderr(`[poll]  ${secs}s - waiting for app to stabilize...`);
    }
  }

  // If we timed out and no crash detected, verify app is still running
  if (verdict === 'BOOT_SUCCESS') {
    try {
      const apps = await listRunningApps(opts.device);
      const running = apps.find((a) => a.identifier === opts.app && a.pid);
      if (!running) {
        verdict = 'TIMEOUT_NO_APP';
        crashSignature = crashSignature || 'App not running at end of timeout';
      }
    } catch { /* assume success if we can't check */ }
  }

  const durationMs = Date.now() - startTime;

  if (verdict === 'BOOT_SUCCESS') {
    stderr(`[done]  ${(durationMs / 1000).toFixed(1)}s elapsed - app still running. SUCCESS`);
  }

  // --- Phase 4: Logcat ---
  if (opts.captureLogcat) {
    try {
      const raw = await shellCommand(opts.device, 'logcat -d -t 200');
      const lines = raw.split('\n');
      // Filter for the target app or crash indicators
      const appPkg = opts.app.split('.').slice(-2).join('.');
      const crashKeywords = /FATAL|signal|AndroidRuntime|art|crash|died|kill/i;
      logcatLines = lines.filter(
        (l) => l.includes(opts.app) || l.includes(appPkg) || crashKeywords.test(l),
      );
      // Also check logcat for crash patterns
      if (verdict !== 'CRASH') {
        for (const line of logcatLines) {
          const crash = matchesCrashPattern(line);
          if (crash) {
            verdict = 'CRASH';
            crashSignature = crashSignature || crash;
            break;
          }
        }
      }
    } catch { /* logcat capture failed — non-fatal */ }
  }

  // --- Phase 5: Cleanup ---
  if (!opts.noStop) {
    try {
      await stopFrida(opts.device);
      stderr('[cleanup] Frida stopped');
    } catch { /* best effort */ }
  }

  return {
    verdict,
    app: opts.app,
    device: opts.device,
    scripts: opts.scripts,
    durationMs,
    crashSignature,
    messages: allMessages,
    logcat: logcatLines,
  };
}

function printReport(report: TestReport): void {
  const w = 55;
  const line = '='.repeat(w);
  const thin = '-'.repeat(w);

  console.log('');
  console.log(line);
  console.log(' FRIDA TEST REPORT');
  console.log(line);
  console.log('');
  console.log(`Verdict:  ${report.verdict}`);
  console.log(`App:      ${report.app}`);
  console.log(`Device:   ${report.device}`);
  console.log(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(`Scripts:  ${report.scripts.join(', ') || '(none)'}`);

  if (report.crashSignature) {
    console.log(`Crash:    ${report.crashSignature}`);
  }

  console.log('');
  console.log(`--- Frida Messages (${report.messages.length}) ---`);
  if (report.messages.length === 0) {
    console.log('  (no messages)');
  } else {
    for (const msg of report.messages) {
      const payload = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
      const prefix = msg.type === 'error' ? 'ERR' : msg.type === 'send' ? 'SND' : 'LOG';
      console.log(`  ${shortTime(msg.timestamp)} [${prefix}] ${payload}`);
    }
  }

  if (report.logcat.length > 0) {
    console.log('');
    console.log(`--- Logcat (${report.logcat.length} lines) ---`);
    for (const line of report.logcat.slice(-50)) {
      console.log(`  ${line}`);
    }
  }

  console.log('');
  console.log(line);
}

// ---------------------------------------------------------------------------
// Subcommand: logcat
// ---------------------------------------------------------------------------

async function cmdLogcat(args: CliArgs): Promise<void> {
  if (!args.device) {
    stderr('Error: --device is required for logcat command');
    process.exit(2);
  }

  const raw = await shellCommand(args.device, `logcat -d -t ${args.lines}`);
  const lines = raw.split('\n');

  if (args.app) {
    const appPkg = args.app.split('.').slice(-2).join('.');
    const crashKeywords = /FATAL|signal|AndroidRuntime|art|crash|died|kill/i;
    const filtered = lines.filter(
      (l) => l.includes(args.app!) || l.includes(appPkg) || crashKeywords.test(l),
    );
    for (const line of filtered) console.log(line);
    stderr(`\n(${filtered.length} of ${lines.length} lines matched filter for ${args.app})`);
  } else {
    for (const line of lines) console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  // Re-use the JSDoc header
  const src = readFileSync(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), 'utf-8');
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (match) {
    const help = match[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim();
    console.log(help);
  } else {
    console.log('Usage: npx tsx scripts/frida-test.ts <command> [options]');
    console.log('Commands: devices, scripts, run, logcat, help');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  // SIGINT handler — clean up Frida if running
  let cleanupDevice: string | null = null;
  process.on('SIGINT', async () => {
    if (cleanupDevice) {
      stderr('\n[cleanup] Caught SIGINT, stopping Frida...');
      try { await stopFrida(cleanupDevice); } catch { /* ignore */ }
    }
    process.exit(130);
  });

  switch (args.command) {
    case 'devices':
      await cmdDevices(args);
      break;
    case 'scripts':
      await cmdScripts(args);
      break;
    case 'run':
      cleanupDevice = args.device || null;
      await cmdRun(args);
      break;
    case 'logcat':
      await cmdLogcat(args);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  stderr(`Fatal: ${err.message}`);
  process.exit(1);
});
