import { describe, it, expect } from 'vitest';
import { parseAvdList, parseSystemImageList } from '../avd-helpers';

const SAMPLE_AVD_LIST = `
Available Android Virtual Devices:
    Name: Pixel_8_API_34
  Device: pixel_8 (Google)
    Path: /home/user/.android/avd/Pixel_8_API_34.avd
  Target: Google APIs (Google Inc.)
          Based on: Android 14.0 (API level 34) Tag/ABI: google_apis/x86_64
---------
    Name: Tablet_Test
  Device: pixel_tablet (Google)
    Path: /home/user/.android/avd/Tablet_Test.avd
  Target: Default Android System Image
          Based on: Android 13.0 (API level 33) Tag/ABI: default/x86_64
`;

describe('parseAvdList', () => {
  it('parses avdmanager list avd output into named entries', () => {
    const r = parseAvdList(SAMPLE_AVD_LIST);
    expect(r).toEqual([
      { name: 'Pixel_8_API_34', device: 'pixel_8 (Google)', target: 'Google APIs', androidVersion: '14.0', apiLevel: 34, abi: 'google_apis/x86_64' },
      { name: 'Tablet_Test',    device: 'pixel_tablet (Google)', target: 'Default Android System Image', androidVersion: '13.0', apiLevel: 33, abi: 'default/x86_64' },
    ]);
  });

  it('returns empty array on empty input', () => {
    expect(parseAvdList('')).toEqual([]);
    expect(parseAvdList('Available Android Virtual Devices:\n')).toEqual([]);
  });
});

describe('parseSystemImageList', () => {
  it('parses sdkmanager --list output for system-images;android-XX;...', () => {
    const sample = `
Installed packages:
  Path                                        | Version | Description                  | Location
  ------                                      | ------- | -------                      | --------
  system-images;android-34;google_apis;x86_64 | 11      | Google APIs Intel x86_64...  | system-images/...
  platform-tools                              | 34.0.5  | Android SDK Platform-Tools   | platform-tools

Available Packages:
  Path                                        | Version | Description
  ------                                      | ------- | -------
  system-images;android-33;default;x86_64     | 5       | Default Android System Image
  system-images;android-32;google_apis;arm64-v8a | 4    | Google APIs ARM 64
`;
    const r = parseSystemImageList(sample);
    expect(r).toContainEqual({ pkg: 'system-images;android-34;google_apis;x86_64', apiLevel: 34, tag: 'google_apis', abi: 'x86_64', installed: true });
    expect(r).toContainEqual({ pkg: 'system-images;android-33;default;x86_64', apiLevel: 33, tag: 'default', abi: 'x86_64', installed: false });
    expect(r).toContainEqual({ pkg: 'system-images;android-32;google_apis;arm64-v8a', apiLevel: 32, tag: 'google_apis', abi: 'arm64-v8a', installed: false });
  });
});
