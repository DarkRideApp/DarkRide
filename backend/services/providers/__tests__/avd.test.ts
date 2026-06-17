import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process BEFORE importing the provider (canonical pattern).
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile, spawn } from 'child_process';
import { createAvdProvider } from '../avd';

function mockExec(stdout: string) {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockExecFailure(message: string, code?: string) {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const err: any = new Error(message);
    if (code) err.code = code;
    cb(err);
  });
}

describe('avd provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isAvailable returns true when both emulator and avdmanager are present', async () => {
    mockExec('Android Emulator usage: ...');
    const p = createAvdProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(true);
  });

  it('isAvailable returns false with installHint when emulator is missing', async () => {
    mockExecFailure('spawn emulator ENOENT', 'ENOENT');
    const p = createAvdProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(false);
    expect(av.installHint).toMatch(/Android Studio|cmdline-tools/i);
  });

  it('listInstances calls "avdmanager list avd" and parses the output', async () => {
    mockExec(
      `Available Android Virtual Devices:\n` +
      `    Name: Pixel_8_API_34\n` +
      `  Device: pixel_8 (Google)\n` +
      `    Path: /home/user/.android/avd/Pixel_8_API_34.avd\n` +
      `  Target: Google APIs (Google Inc.)\n` +
      `          Based on: Android 14.0 (API level 34) Tag/ABI: google_apis/x86_64\n`,
    );
    const p = createAvdProvider();
    const instances = await p.listInstances();
    expect(instances).toEqual([{
      id: 'Pixel_8_API_34',
      displayName: 'Pixel_8_API_34',
      state: 'stopped',
      spawnedByDarkride: false,
      metadata: { device: 'pixel_8 (Google)', androidVersion: '14.0', apiLevel: 34, abi: 'google_apis/x86_64' },
    }]);
  });

  it('createInstance runs `avdmanager create avd` with the given name + system image', async () => {
    mockExec('AVD "test" created');
    const p = createAvdProvider();
    const inst = await p.createInstance!({
      displayName: 'test',
      config: { systemImagePackage: 'system-images;android-34;google_apis;x86_64', deviceProfile: 'pixel_8' },
    });
    // The SDK-resolver may rewrite `avdmanager` to an absolute path
    // (e.g. /home/x/Android/Sdk/cmdline-tools/latest/bin/avdmanager) when
    // ANDROID_HOME or a default install dir exists on the test host. Match
    // either form by checking the basename.
    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/|\\)avdmanager(\.bat)?$/),
      ['create', 'avd', '-n', 'test', '-k', 'system-images;android-34;google_apis;x86_64', '-d', 'pixel_8'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(inst.state).toBe('created');
  });

  it('startInstance spawns `emulator -avd <name>` and returns the serial', async () => {
    const mockChild = { unref: vi.fn(), pid: 12345, on: vi.fn() };
    (spawn as any).mockReturnValue(mockChild);
    const p = createAvdProvider({ pickFreePort: () => 5554, waitForAdbSerial: vi.fn().mockResolvedValue(true) });
    const r = await p.startInstance('Pixel_8_API_34');
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/|\\)emulator(\.exe)?$/),
      ['-avd', 'Pixel_8_API_34', '-no-window', '-port', '5554'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(r.serial).toBe('emulator-5554');
  });

  it('stopInstance runs `adb -s emulator-<port> emu kill`', async () => {
    mockExec('OK');
    const p = createAvdProvider({ pickFreePort: () => 5556, waitForAdbSerial: vi.fn().mockResolvedValue(true) });
    const mockChild = { unref: vi.fn(), pid: 12345, on: vi.fn() };
    (spawn as any).mockReturnValue(mockChild);
    await p.startInstance('Pixel_8_API_34');
    await p.stopInstance('Pixel_8_API_34');
    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/|\\)adb(\.exe)?$/),
      ['-s', 'emulator-5556', 'emu', 'kill'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('deleteInstance runs `avdmanager delete avd -n <name>`', async () => {
    mockExec('AVD deleted');
    const p = createAvdProvider();
    await p.deleteInstance!('Pixel_8_API_34');
    expect(execFile).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/|\\)avdmanager(\.bat)?$/),
      ['delete', 'avd', '-n', 'Pixel_8_API_34'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('getNetworkConfig returns wireguard mode', () => {
    const p = createAvdProvider();
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'wireguard' });
  });
});
