import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import path from 'path';
import { findPosixShell, toShellPath } from '../test-utils/posix-shell';
import {
  buildTurncfgScript,
  buildCoturnContainerSpec,
  loadOrCreateCoturnCreds,
  ensureCoturn,
} from './coturn-manager';

const CREDS = { username: 'darkride', password: 'deadbeefcafef00d0123456789abcdef' };

/**
 * Run the turncfg script through a POSIX shell exactly as the emulator does and
 * return the parsed JSON it prints. Executing the real script (rather than
 * string-matching the printf body) is the only way to verify the contract:
 * the emitted stdout must be valid iceServers JSON with the values
 * substituted in.
 */
function runTurncfg(lanIp: string, creds = CREDS): any {
  const dir = mkdtempSync(path.join(tmpdir(), 'turncfg-'));
  try {
    const file = path.join(dir, 'turncfg.sh');
    writeFileSync(file, buildTurncfgScript(lanIp, creds));
    chmodSync(file, 0o755);
    const sh = findPosixShell();
    if (!sh) throw new Error('no POSIX shell available to run the script');
    const stdout = execFileSync(sh, [toShellPath(file)], { encoding: 'utf-8' });
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildTurncfgScript', () => {
  it('emits a sh script whose stdout is valid iceServers JSON', () => {
    expect(buildTurncfgScript('192.168.1.50', CREDS).startsWith('#!/bin/sh')).toBe(true);
    const parsed = runTurncfg('192.168.1.50');
    expect(Array.isArray(parsed.iceServers)).toBe(true);
    expect(parsed.iceServers).toHaveLength(1);
  });

  it('emits the DUAL-URL array (LAN IP url AND host.docker.internal url)', () => {
    const urls = runTurncfg('192.168.1.50').iceServers[0].urls;
    expect(urls).toEqual([
      'turn:192.168.1.50:3478?transport=udp',
      'turn:host.docker.internal:3478?transport=udp',
    ]);
  });

  it('bakes in the username and credential', () => {
    const server = runTurncfg('10.0.0.7').iceServers[0];
    expect(server.username).toBe('darkride');
    expect(server.credential).toBe(CREDS.password);
  });
});

describe('buildCoturnContainerSpec', () => {
  it('sets Image / name / labels and stores lanIp in a label for idempotency', () => {
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS);
    // Pinned by digest (coturn 4.13.1-r0) for reproducible launches.
    expect(spec.Image).toBe('coturn/coturn@sha256:6a1d1a281b8f64ca1a343429bb0232fa70c5f0eae3c8424ba0859b696e880974');
    expect(spec.name).toBe('darkride-coturn');
    expect(spec.Labels).toMatchObject({
      'darkride.coturn': 'true',
      'darkride.coturn.lanip': '192.168.1.50',
    });
    // A config-hash label drives recreate-on-change in ensureCoturn.
    expect(spec.Labels['darkride.coturn.confighash']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the config hash changes when the args change (creds rotate)', () => {
    const a = buildCoturnContainerSpec('192.168.1.50', CREDS);
    const b = buildCoturnContainerSpec('192.168.1.50', { username: 'darkride', password: 'ffff' });
    expect(a.Labels['darkride.coturn.confighash']).not.toBe(b.Labels['darkride.coturn.confighash']);
  });

  it('passes external-ip == lanIp and the lt-cred user in Cmd', () => {
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS);
    expect(spec.Cmd).toContain('--external-ip=192.168.1.50');
    expect(spec.Cmd).toContain('--user=darkride:deadbeefcafef00d0123456789abcdef');
    expect(spec.Cmd).toContain('--lt-cred-mech');
    expect(spec.Cmd).toContain('--realm=darkride.local');
  });

  it('logs to stdout and avoids the entrypoint echo-n trap + the deprecated --no-cli', () => {
    // The coturn/coturn entrypoint runs `eval "echo $arg"` on every arg, so a
    // bare `-n` becomes empty (echo -n) and breaks parsing. --no-cli is also
    // deprecated and logs an ERROR. Neither must appear; --log-file=stdout must.
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS);
    expect(spec.Cmd).toContain('--log-file=stdout');
    expect(spec.Cmd).not.toContain('-n');
    expect(spec.Cmd).not.toContain('--no-cli');
    expect(spec.Cmd.every((a) => a.length > 0 && a.startsWith('--'))).toBe(true);
  });

  it('publishes 3478/tcp and 3478/udp on host port 3478', () => {
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS);
    expect(spec.ExposedPorts).toMatchObject({ '3478/tcp': {}, '3478/udp': {} });
    expect(spec.HostConfig.PortBindings['3478/tcp']).toEqual([{ HostPort: '3478' }]);
    expect(spec.HostConfig.PortBindings['3478/udp']).toEqual([{ HostPort: '3478' }]);
  });

  it('publishes the full relay UDP range 1:1 (spot-check min and max)', () => {
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS, { minPort: 49160, maxPort: 49200 });
    expect(spec.Cmd).toContain('--min-port=49160');
    expect(spec.Cmd).toContain('--max-port=49200');
    // 1:1 mapping: HostPort equals the container port for every UDP relay port.
    expect(spec.ExposedPorts['49160/udp']).toEqual({});
    expect(spec.ExposedPorts['49200/udp']).toEqual({});
    expect(spec.HostConfig.PortBindings['49160/udp']).toEqual([{ HostPort: '49160' }]);
    expect(spec.HostConfig.PortBindings['49200/udp']).toEqual([{ HostPort: '49200' }]);
    // Every port in [min,max] inclusive is present.
    for (let port = 49160; port <= 49200; port++) {
      expect(spec.HostConfig.PortBindings[`${port}/udp`]).toEqual([{ HostPort: String(port) }]);
    }
  });

  it('defaults the relay range to 49160-49200', () => {
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS);
    expect(spec.Cmd).toContain('--min-port=49160');
    expect(spec.Cmd).toContain('--max-port=49200');
    expect(spec.HostConfig.PortBindings['49160/udp']).toBeDefined();
    expect(spec.HostConfig.PortBindings['49200/udp']).toBeDefined();
  });

  it('uses an unless-stopped restart policy', () => {
    const spec = buildCoturnContainerSpec('192.168.1.50', CREDS);
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
  });
});

describe('loadOrCreateCoturnCreds', () => {
  let tmp: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'coturn-creds-'));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = tmp;
  });

  afterEach(() => {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the creds file on first call and returns stable creds', () => {
    const creds = loadOrCreateCoturnCreds();
    expect(creds.username).toBe('darkride');
    expect(creds.password.length).toBeGreaterThanOrEqual(24);
    expect(existsSync(path.join(tmp, 'coturn-creds.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(path.join(tmp, 'coturn-creds.json'), 'utf-8'));
    expect(onDisk).toEqual(creds);
  });

  it('returns the SAME creds across calls (persisted, not regenerated)', () => {
    const first = loadOrCreateCoturnCreds();
    const second = loadOrCreateCoturnCreds();
    expect(second).toEqual(first);
  });
});

const LAN = '192.168.1.50';
const WANT_HASH = buildCoturnContainerSpec(LAN, CREDS).Labels['darkride.coturn.confighash'];

/**
 * Minimal fake of the DockerLike surface ensureCoturn touches. `existingInfo`
 * is the inspect() payload of an already-present darkride-coturn (null = none);
 * `imageLocal=false` forces the pull path; `pullFrames` are the JSON lines the
 * pull stream emits; `createThrows` makes createContainer reject.
 */
function fakeDocker(opts: {
  existingInfo?: any;
  imageLocal?: boolean;
  pullFrames?: string[];
  createThrows?: boolean;
} = {}) {
  const start = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const createContainer = opts.createThrows
    ? vi.fn().mockRejectedValue(new Error('daemon down'))
    : vi.fn().mockResolvedValue({ start });
  const existing = opts.existingInfo
    ? { inspect: vi.fn().mockResolvedValue(opts.existingInfo), remove }
    : null;
  const d: any = {
    listContainers: vi.fn().mockResolvedValue(existing ? [{ Id: 'coturn-1' }] : []),
    getContainer: vi.fn().mockReturnValue(existing),
    getImage: vi.fn().mockReturnValue({
      inspect: opts.imageLocal === false
        ? vi.fn().mockRejectedValue(new Error('no such image'))
        : vi.fn().mockResolvedValue({}),
    }),
    pull: vi.fn().mockImplementation(async () =>
      Readable.from((opts.pullFrames ?? []).map(f => f + '\n')),
    ),
    createContainer,
  };
  return { d, start, remove, createContainer };
}

describe('ensureCoturn (container lifecycle)', () => {
  it('creates + starts coturn when none exists, and returns true', async () => {
    const { d, start, createContainer } = fakeDocker();
    const ok = await ensureCoturn(d, LAN, CREDS);
    expect(ok).toBe(true);
    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    // The spec it launches carries the wanted config hash.
    expect(createContainer.mock.calls[0][0].Labels['darkride.coturn.confighash']).toBe(WANT_HASH);
  });

  it('reuses a running container whose config hash matches (no recreate)', async () => {
    const { d, createContainer, remove } = fakeDocker({
      existingInfo: { State: { Running: true }, Config: { Labels: { 'darkride.coturn.confighash': WANT_HASH } } },
    });
    const ok = await ensureCoturn(d, LAN, CREDS);
    expect(ok).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('removes + recreates a container whose config hash is stale', async () => {
    const { d, createContainer, remove } = fakeDocker({
      existingInfo: { State: { Running: true }, Config: { Labels: { 'darkride.coturn.confighash': 'deadbeefdeadbeef' } } },
    });
    const ok = await ensureCoturn(d, LAN, CREDS);
    expect(ok).toBe(true);
    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(createContainer).toHaveBeenCalledTimes(1);
  });

  it('recreates when the container exists but is not running', async () => {
    const { d, createContainer, remove } = fakeDocker({
      existingInfo: { State: { Running: false }, Config: { Labels: { 'darkride.coturn.confighash': WANT_HASH } } },
    });
    const ok = await ensureCoturn(d, LAN, CREDS);
    expect(ok).toBe(true);
    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(createContainer).toHaveBeenCalledTimes(1);
  });

  it('degrades to false (never throws) when a Docker call fails', async () => {
    const { d } = fakeDocker({ createThrows: true });
    await expect(ensureCoturn(d, LAN, CREDS)).resolves.toBe(false);
  });

  it('treats a docker-pull error frame as failure and returns false', async () => {
    // Docker reports pull failures as a `{"error":...}` frame then ends cleanly;
    // ensureCoturnImageLocal must reject on it rather than logging success.
    const { d, createContainer } = fakeDocker({
      imageLocal: false,
      pullFrames: ['{"status":"Pulling from coturn/coturn"}', '{"error":"toomanyrequests: rate limited"}'],
    });
    const ok = await ensureCoturn(d, LAN, CREDS);
    expect(ok).toBe(false);
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('pulls then creates when the image is absent and the pull succeeds', async () => {
    const { d, createContainer, start } = fakeDocker({
      imageLocal: false,
      pullFrames: ['{"status":"Pulling from coturn/coturn"}', '{"status":"Download complete"}'],
    });
    const ok = await ensureCoturn(d, LAN, CREDS);
    expect(ok).toBe(true);
    expect(d.pull).toHaveBeenCalledTimes(1);
    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
