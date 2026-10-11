import net from 'node:net';
import { inArray } from 'drizzle-orm';
import { settings } from '../../db/schema';
import type { AppDatabase } from '../../db/index';

export interface AdbProxySettings {
  enabled: boolean;
  bindHost: string;
  portStart: number;
  portEnd: number;
}

export const DEFAULT_SETTINGS: AdbProxySettings = {
  enabled: false,
  bindHost: '0.0.0.0',
  portStart: 6500,
  portEnd: 6599,
};

const KEYS = {
  enabled: 'adb_proxy.enabled',
  bindHost: 'adb_proxy.bind_host',
  portStart: 'adb_proxy.port_start',
  portEnd: 'adb_proxy.port_end',
} as const;

const MAX_RANGE = 1000;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

function validate(s: AdbProxySettings): void {
  if (net.isIP(s.bindHost) === 0) throw new SettingsError('bind host must be an IP address');
  if (!Number.isInteger(s.portStart) || !Number.isInteger(s.portEnd)) throw new SettingsError('ports must be whole numbers');
  if (s.portStart < 1024 || s.portEnd > 65535) throw new SettingsError('ports must be between 1024 and 65535');
  if (s.portStart > s.portEnd) throw new SettingsError('port range start must not exceed its end');
  if (s.portEnd - s.portStart + 1 > MAX_RANGE) throw new SettingsError(`port range may not exceed ${MAX_RANGE} ports`);
}

function parseInt10(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

export function loadSettings(db: AppDatabase): AdbProxySettings {
  const rows = db.select().from(settings).where(inArray(settings.key, Object.values(KEYS))).all();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const enabled = byKey.get(KEYS.enabled);
  const host = byKey.get(KEYS.bindHost);
  return {
    enabled: enabled === 'true' ? true : enabled === 'false' ? false : DEFAULT_SETTINGS.enabled,
    bindHost: host !== undefined && net.isIP(host) !== 0 ? host : DEFAULT_SETTINGS.bindHost,
    portStart: parseInt10(byKey.get(KEYS.portStart), DEFAULT_SETTINGS.portStart),
    portEnd: parseInt10(byKey.get(KEYS.portEnd), DEFAULT_SETTINGS.portEnd),
  };
}

export function saveSettings(db: AppDatabase, patch: Partial<AdbProxySettings>): AdbProxySettings {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next: AdbProxySettings = { ...loadSettings(db), ...defined };
  validate(next);
  const values: Array<[string, string]> = [
    [KEYS.enabled, String(next.enabled)],
    [KEYS.bindHost, next.bindHost],
    [KEYS.portStart, String(next.portStart)],
    [KEYS.portEnd, String(next.portEnd)],
  ];
  for (const [key, value] of values) {
    db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }
  return next;
}
