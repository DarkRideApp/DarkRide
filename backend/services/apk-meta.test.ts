import { describe, it, expect } from 'vitest';
import { parseQuickMetaOutput } from './apk-meta';

describe('parseQuickMetaOutput', () => {
  it('parses valid metadata', () => {
    const meta = parseQuickMetaOutput(JSON.stringify({ packageName: 'com.x.y', versionCode: 42, versionName: '4.2' }));
    expect(meta).toEqual({ packageName: 'com.x.y', versionCode: 42, versionName: '4.2' });
  });

  it('throws on script-reported error', () => {
    expect(() => parseQuickMetaOutput(JSON.stringify({ error: 'Not an APK' }))).toThrow(/Not an APK/);
  });

  it('throws on missing identity fields', () => {
    expect(() => parseQuickMetaOutput(JSON.stringify({ packageName: null, versionCode: null, versionName: null }))).toThrow(/identity/i);
    expect(() => parseQuickMetaOutput('not json')).toThrow(/unexpected output/i);
  });

  it('preserves a null versionName', () => {
    const meta = parseQuickMetaOutput(JSON.stringify({ packageName: 'com.x.y', versionCode: 7, versionName: null }));
    expect(meta).toEqual({ packageName: 'com.x.y', versionCode: 7, versionName: null });
  });

  it('lets a script-reported error take precedence over present identity fields', () => {
    expect(() => parseQuickMetaOutput(JSON.stringify({ error: 'boom', packageName: 'com.x.y', versionCode: 7 }))).toThrow(/boom/);
  });
});
