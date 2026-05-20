import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process BEFORE importing the provider (same pattern as plugin-installer.test.ts:4-20).
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { createAdbDeviceProvider } from '../adb-device';

function mockAdbDevices(stdout: string) {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

describe('adb-device provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isAvailable returns true when adb succeeds', async () => {
    mockAdbDevices('List of devices attached\n');
    const p = createAdbDeviceProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(true);
  });

  it('isAvailable returns false with installHint when adb is missing', async () => {
    (execFile as any).mockImplementation((_c: string, _a: string[], _o: any, cb: Function) => {
      const err: any = new Error('spawn adb ENOENT');
      err.code = 'ENOENT';
      cb(err);
    });
    const p = createAdbDeviceProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(false);
    expect(av.installHint).toMatch(/adb/i);
  });

  it('listInstances parses "adb devices" output into one instance per row', async () => {
    mockAdbDevices(
      `List of devices attached\n` +
      `R3CR70ABC123\tdevice\n` +
      `emulator-5554\tdevice\n` +
      `RANDOM_SERIAL\toffline\n`,
    );
    const p = createAdbDeviceProvider();
    const instances = await p.listInstances();
    expect(instances).toEqual([
      { id: 'R3CR70ABC123', displayName: 'R3CR70ABC123', state: 'running', serial: 'R3CR70ABC123', spawnedByDarkride: false },
      { id: 'emulator-5554', displayName: 'emulator-5554', state: 'running', serial: 'emulator-5554', spawnedByDarkride: false },
      { id: 'RANDOM_SERIAL', displayName: 'RANDOM_SERIAL', state: 'stopped', serial: 'RANDOM_SERIAL', spawnedByDarkride: false },
    ]);
  });

  it('startInstance is a no-op (adb-device does not spawn)', async () => {
    const p = createAdbDeviceProvider();
    // Returns immediately with the existing serial; never calls execFile to spawn anything.
    const r = await p.startInstance('R3CR70ABC123');
    expect(r).toEqual({ id: 'R3CR70ABC123', serial: 'R3CR70ABC123' });
  });

  it('stopInstance is a no-op (adb-device does not kill)', async () => {
    const p = createAdbDeviceProvider();
    await expect(p.stopInstance('R3CR70ABC123')).resolves.toBeUndefined();
  });

  it('getNetworkConfig returns wireguard mode', () => {
    const p = createAdbDeviceProvider();
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'wireguard' });
  });

  it('filters out adb daemon diagnostic lines ("* daemon ...")', async () => {
    // adb prints these on first invocation after daemon restart. Without
    // filtering they become phantom instances with id="*".
    mockAdbDevices(
      `* daemon not running; starting now at tcp:5037\n` +
      `* daemon started successfully\n` +
      `List of devices attached\n` +
      `R3CR70ABC123\tdevice\n`,
    );
    const p = createAdbDeviceProvider();
    const instances = await p.listInstances();
    expect(instances).toEqual([
      { id: 'R3CR70ABC123', displayName: 'R3CR70ABC123', state: 'running', serial: 'R3CR70ABC123', spawnedByDarkride: false },
    ]);
  });

  it('maps adb "unauthorized" state to error + actionable lastError', async () => {
    mockAdbDevices(
      `List of devices attached\n` +
      `R3CR70ABC123\tunauthorized\n`,
    );
    const p = createAdbDeviceProvider();
    const instances = await p.listInstances();
    expect(instances).toEqual([
      {
        id: 'R3CR70ABC123',
        displayName: 'R3CR70ABC123',
        state: 'error',
        serial: 'R3CR70ABC123',
        spawnedByDarkride: false,
        lastError: 'Authorisation required — accept the RSA fingerprint prompt on the device',
      },
    ]);
  });
});
