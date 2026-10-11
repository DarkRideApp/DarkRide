import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { settings } from '../../db/schema';
import { DEFAULT_SETTINGS, SettingsError, loadSettings, saveSettings } from './settings';

const fresh = () => createTestDb([settings]);

describe('adb proxy settings', () => {
  it('returns the defaults when nothing is stored: disabled, all interfaces, 6500-6599', () => {
    expect(loadSettings(fresh())).toEqual({ enabled: false, bindHost: '0.0.0.0', portStart: 6500, portEnd: 6599 });
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });

  it('saves and reloads a full change', () => {
    const db = fresh();
    const saved = saveSettings(db, { enabled: true, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 });
    expect(saved).toEqual({ enabled: true, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 });
    expect(loadSettings(db)).toEqual(saved);
  });

  it('merges a partial patch over the stored values', () => {
    const db = fresh();
    saveSettings(db, { portStart: 7000, portEnd: 7009 });
    expect(saveSettings(db, { enabled: true })).toEqual({ enabled: true, bindHost: '0.0.0.0', portStart: 7000, portEnd: 7009 });
  });

  it('accepts an IPv6 bind address', () => {
    expect(saveSettings(fresh(), { bindHost: '::' }).bindHost).toBe('::');
  });

  it.each([
    [{ bindHost: 'my-host.local' }],
    [{ bindHost: '' }],
    [{ portStart: 80 }],
    [{ portStart: 7000, portEnd: 6999 }],
    [{ portEnd: 70000 }],
    [{ portStart: 6500.5 }],
    [{ portStart: 2000, portEnd: 4000 }],
  ])('rejects %j', (patch) => {
    expect(() => saveSettings(fresh(), patch)).toThrow(SettingsError);
  });

  it('does not store anything when validation fails', () => {
    const db = fresh();
    expect(() => saveSettings(db, { enabled: true, bindHost: 'nope' })).toThrow(SettingsError);
    expect(loadSettings(db).enabled).toBe(false);
  });

  it('falls back to the default for a corrupt stored value', () => {
    const db = fresh();
    db.insert(settings).values([
      { key: 'adb_proxy.port_start', value: 'abc' },
      { key: 'adb_proxy.enabled', value: 'maybe' },
    ]).run();
    expect(loadSettings(db)).toEqual(DEFAULT_SETTINGS);
  });

  it('leaves unrelated settings untouched', () => {
    const db = fresh();
    db.insert(settings).values({ key: 'other', value: 'x' }).run();
    saveSettings(db, { enabled: true });
    expect(db.select().from(settings).all().find((r) => r.key === 'other')?.value).toBe('x');
  });
});
