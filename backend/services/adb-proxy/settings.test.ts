import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../test-utils/create-test-db';
import { settings } from '../../db/schema';
import { DEFAULT_SETTINGS, SettingsError, loadSettings, saveSettings, type AdbProxySettings } from './settings';

const fresh = () => createTestDb([settings]);

const store = (db: ReturnType<typeof fresh>, rows: Record<string, string>) => {
  db.insert(settings).values(Object.entries(rows).map(([key, value]) => ({ key, value }))).run();
};

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

  it.each<[Partial<AdbProxySettings>]>([
    [{ bindHost: 'my-host.local' }],
    [{ bindHost: '' }],
    [{ portStart: 80, portEnd: 90 }],
    [{ portStart: 1023, portEnd: 1030 }],
    [{ portStart: 65530, portEnd: 65536 }],
    [{ portStart: 69500, portEnd: 70000 }],
    [{ portStart: 7000, portEnd: 6999 }],
    [{ portStart: 6500.5 }],
    [{ portStart: Number.NaN, portEnd: Number.NaN }],
    [{ portStart: 2000, portEnd: 4000 }],
    [{ portStart: 7000, portEnd: 8000 }],
    [{ enabled: 1 as unknown as boolean }],
    [{ enabled: 'true' as unknown as boolean }],
    [{ enabled: null as unknown as boolean }],
  ])('rejects %j', (patch) => {
    expect(() => saveSettings(fresh(), patch)).toThrow(SettingsError);
  });

  it.each<[Partial<AdbProxySettings>]>([
    [{ portStart: 1024, portEnd: 1030 }],
    [{ portStart: 65530, portEnd: 65535 }],
    [{ portStart: 7000, portEnd: 7999 }],
    [{ portStart: 7000, portEnd: 7000 }],
  ])('accepts %j', (patch) => {
    expect(saveSettings(fresh(), patch)).toMatchObject(patch);
  });

  it('does not store anything when validation fails', () => {
    const db = fresh();
    expect(() => saveSettings(db, { enabled: true, bindHost: 'nope' })).toThrow(SettingsError);
    expect(loadSettings(db).enabled).toBe(false);
    expect(db.select().from(settings).all()).toEqual([]);
  });

  it('writes all four keys or none when a write fails partway', () => {
    const db = fresh();
    db.$client.exec(
      "CREATE TRIGGER fail_port_end BEFORE INSERT ON settings WHEN NEW.key = 'adb_proxy.port_end' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
    );
    expect(() => saveSettings(db, { enabled: true, portStart: 7000, portEnd: 7009 })).toThrow(/simulated write failure/);
    expect(db.select().from(settings).all()).toEqual([]);
  });

  it('falls back to the default for a corrupt stored value', () => {
    const db = fresh();
    store(db, { 'adb_proxy.port_start': 'abc', 'adb_proxy.enabled': 'maybe' });
    expect(loadSettings(db)).toEqual(DEFAULT_SETTINGS);
  });

  it('reads valid values stored under the raw key names', () => {
    const db = fresh();
    store(db, {
      'adb_proxy.enabled': 'true',
      'adb_proxy.bind_host': '192.168.1.5',
      'adb_proxy.port_start': '7000',
      'adb_proxy.port_end': '7009',
    });
    expect(loadSettings(db)).toEqual({ enabled: true, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 });
  });

  it('writes the raw key names it reads back', () => {
    const db = fresh();
    saveSettings(db, { enabled: true, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 });
    const rows = Object.fromEntries(db.select().from(settings).all().map((r) => [r.key, r.value]));
    expect(rows).toEqual({
      'adb_proxy.enabled': 'true',
      'adb_proxy.bind_host': '192.168.1.5',
      'adb_proxy.port_start': '7000',
      'adb_proxy.port_end': '7009',
    });
  });

  it.each([
    ['enabled', 'adb_proxy.enabled', { enabled: false, bindHost: '192.168.1.5', portStart: 7000, portEnd: 7009 }],
    ['bind host', 'adb_proxy.bind_host', { enabled: true, bindHost: '0.0.0.0', portStart: 7000, portEnd: 7009 }],
    ['port end', 'adb_proxy.port_end', { enabled: true, bindHost: '192.168.1.5', portStart: 6500, portEnd: 6599 }],
  ])('a corrupt stored %s only resets its own field (the port pair resets together)', (_label, key, expected) => {
    const db = fresh();
    store(db, {
      'adb_proxy.enabled': 'true',
      'adb_proxy.bind_host': '192.168.1.5',
      'adb_proxy.port_start': '7000',
      'adb_proxy.port_end': '7009',
    });
    db.update(settings).set({ value: 'garbage' }).where(eq(settings.key, key)).run();
    expect(loadSettings(db)).toEqual(expected);
  });

  it.each([
    ['a privileged start port', { 'adb_proxy.port_start': '80' }],
    ['a start with no stored end above the default end', { 'adb_proxy.port_start': '7000' }],
    ['an end above 65535', { 'adb_proxy.port_end': '70000' }],
    ['an inverted pair', { 'adb_proxy.port_start': '7000', 'adb_proxy.port_end': '6999' }],
    ['a span over 1000 ports', { 'adb_proxy.port_start': '6500', 'adb_proxy.port_end': '8000' }],
    ['a privileged pair', { 'adb_proxy.port_start': '80', 'adb_proxy.port_end': '90' }],
    ['a pair starting just below 1024', { 'adb_proxy.port_start': '1023', 'adb_proxy.port_end': '1030' }],
    ['a pair ending just above 65535', { 'adb_proxy.port_start': '65530', 'adb_proxy.port_end': '65536' }],
  ])('loads the default port range for %s', (_label, rows) => {
    const db = fresh();
    store(db, rows);
    const loaded = loadSettings(db);
    expect([loaded.portStart, loaded.portEnd]).toEqual([6500, 6599]);
  });

  it.each([
    ['the lowest allowed pair', '1024', '1030'],
    ['the highest allowed pair', '65530', '65535'],
    ['a span of exactly 1000 ports', '7000', '7999'],
  ])('loads %s as stored', (_label, start, end) => {
    const db = fresh();
    store(db, { 'adb_proxy.port_start': start, 'adb_proxy.port_end': end });
    const loaded = loadSettings(db);
    expect([loaded.portStart, loaded.portEnd]).toEqual([Number(start), Number(end)]);
  });

  it('heals a corrupt stored range on the next save', () => {
    const db = fresh();
    store(db, { 'adb_proxy.port_start': '80' });
    expect(saveSettings(db, { enabled: true })).toEqual({ ...DEFAULT_SETTINGS, enabled: true });
    expect(db.select().from(settings).all().find((r) => r.key === 'adb_proxy.port_start')?.value).toBe('6500');
  });

  it('leaves unrelated settings untouched', () => {
    const db = fresh();
    db.insert(settings).values({ key: 'other', value: 'x' }).run();
    saveSettings(db, { enabled: true });
    expect(db.select().from(settings).all().find((r) => r.key === 'other')?.value).toBe('x');
  });
});
