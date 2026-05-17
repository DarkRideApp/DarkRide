import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-utils/create-test-db';
import { interceptRules, clientCerts } from '../db/schema';
import { syncInterceptConfig, getInterceptConfigPath } from './intercept-config-writer';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';

// Mock fs so we don't write actual files during tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { writeFileSync, mkdirSync } from 'fs';

type TestDb = BetterSQLite3Database<typeof schema>;

function insertRule(db: TestDb, overrides: Partial<typeof interceptRules.$inferInsert> = {}) {
  db.insert(interceptRules).values({
    name: 'Test Rule',
    enabled: true,
    matchHostname: '*.example.com',
    matchPath: '/v2/*',
    matchMethod: null,
    phase: 'response',
    actions: JSON.stringify([{ type: 'json-patch', path: '$.data.isAdmin', value: true }]),
    deviceFilter: null,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }).run();
}

function insertCert(db: TestDb, overrides: Partial<typeof clientCerts.$inferInsert> = {}) {
  db.insert(clientCerts).values({
    name: 'Test Cert',
    hostnames: JSON.stringify(['api.example.com']),
    certPem: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
    keyPem: '-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----',
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  }).run();
}

describe('syncInterceptConfig', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  it('writes empty rules and clientCerts when DB is empty', () => {
    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config).toEqual({ rules: [], clientCerts: [] });
  });

  it('returns the correct file path', () => {
    const filePath = syncInterceptConfig(db as any);
    expect(filePath).toBe(getInterceptConfigPath());
    expect(filePath).toContain('data/intercept-config.json');
  });

  it('creates the data directory', () => {
    syncInterceptConfig(db as any);
    expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('orders rules by priority ASC', () => {
    insertRule(db, { name: 'High Priority', priority: 10 });
    insertRule(db, { name: 'Low Priority', priority: 0 });
    insertRule(db, { name: 'Mid Priority', priority: 5 });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.rules.map((r: any) => r.priority)).toEqual([0, 5, 10]);
    expect(config.rules.map((r: any) => r.name)).toEqual(['Low Priority', 'Mid Priority', 'High Priority']);
  });

  it('excludes disabled rules', () => {
    insertRule(db, { name: 'Enabled Rule', enabled: true });
    insertRule(db, { name: 'Disabled Rule', enabled: false });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].name).toBe('Enabled Rule');
  });

  it('excludes disabled client certs', () => {
    insertCert(db, { name: 'Enabled Cert', enabled: true });
    insertCert(db, { name: 'Disabled Cert', enabled: false });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.clientCerts).toHaveLength(1);
    expect(config.clientCerts[0].name).toBe('Enabled Cert');
  });

  it('parses actions from JSON string to array', () => {
    const actions = [{ type: 'json-patch', path: '$.data.isAdmin', value: true }];
    insertRule(db, { actions: JSON.stringify(actions) });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.rules[0].actions).toEqual(actions);
    expect(Array.isArray(config.rules[0].actions)).toBe(true);
  });

  it('parses hostnames from JSON string to array', () => {
    const hostnames = ['cms-v2.adventurelabs.xyz', 'api-v2.adventurelabs.xyz'];
    insertCert(db, { hostnames: JSON.stringify(hostnames) });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.clientCerts[0].hostnames).toEqual(hostnames);
    expect(Array.isArray(config.clientCerts[0].hostnames)).toBe(true);
  });

  it('includes all expected fields in rules', () => {
    insertRule(db, {
      name: 'Force Admin',
      matchHostname: '*.example.com',
      matchPath: '/v2/*',
      matchMethod: null,
      phase: 'response',
      actions: JSON.stringify([{ type: 'json-patch', path: '$.data.isAdmin', value: true }]),
      deviceFilter: null,
      priority: 0,
    });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const rule = config.rules[0];
    expect(rule).toMatchObject({
      id: expect.any(Number),
      name: 'Force Admin',
      matchHostname: '*.example.com',
      matchPath: '/v2/*',
      matchMethod: null,
      phase: 'response',
      actions: [{ type: 'json-patch', path: '$.data.isAdmin', value: true }],
      deviceFilter: null,
      priority: 0,
    });
  });

  it('includes all expected fields in clientCerts', () => {
    insertCert(db, {
      name: 'PortAventura',
      hostnames: JSON.stringify(['cms-v2.adventurelabs.xyz', 'api-v2.adventurelabs.xyz']),
      certPem: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----',
    });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const cert = config.clientCerts[0];
    expect(cert).toMatchObject({
      id: expect.any(Number),
      name: 'PortAventura',
      hostnames: ['cms-v2.adventurelabs.xyz', 'api-v2.adventurelabs.xyz'],
      certPem: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----',
    });
  });

  it('parses deviceFilter from JSON string when present', () => {
    const deviceFilter = { deviceIds: ['emulator-5554'] };
    insertRule(db, { deviceFilter: JSON.stringify(deviceFilter) });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.rules[0].deviceFilter).toEqual(deviceFilter);
  });

  it('sets deviceFilter to null when not present', () => {
    insertRule(db, { deviceFilter: null });

    syncInterceptConfig(db as any);

    const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const config = JSON.parse(written);
    expect(config.rules[0].deviceFilter).toBeNull();
  });
});
