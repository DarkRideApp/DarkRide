import { describe, it, expect, vi, beforeEach } from 'vitest';
import { definePlugin } from '@darkrideapp/plugin-sdk';
import { PluginManager } from './plugin-manager';

// Capture log output for WARN assertions without printing to stdout in tests.
// vi.hoisted() runs before module imports so the reference is valid inside vi.mock().
const { mockLog } = vi.hoisted(() => ({ mockLog: vi.fn() }));
vi.mock('../logs', () => ({
  createLoggers: () => ({ log: mockLog, error: vi.fn(), warn: vi.fn() }),
}));

describe('PluginManager aiScopes validation', () => {
  it('accepts a plugin with concrete known scopes', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'ok', version: '1.0.0',
      aiScopes: ['core.apk:read', 'mcp'],
      register: () => {},
    });
    expect(() => mgr.loadPlugin(plugin)).not.toThrow();
  });

  it('rejects wildcard scopes with actionable message', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'bad-wildcard', version: '1.0.0',
      aiScopes: ['core.apk:*'],
      register: () => {},
    });
    expect(() => mgr.loadPlugin(plugin)).toThrow(
      /bad-wildcard.*aiScopes.*core\.apk:\*.*wildcard/i,
    );
  });

  it('rejects unknown scopes with a hint about server version', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'bad-unknown', version: '1.0.0',
      aiScopes: ['core.nonexistent:read'],
      register: () => {},
    });
    expect(() => mgr.loadPlugin(plugin)).toThrow(
      /bad-unknown.*aiScopes.*core\.nonexistent:read.*unknown.*server version/i,
    );
  });

  it('accepts empty aiScopes (plugin opts out of AI)', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'no-ai', version: '1.0.0',
      register: () => {},
    });
    expect(() => mgr.loadPlugin(plugin)).not.toThrow();
  });
});

import { ServiceUserManager } from '../auth/service-user-manager';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { applyMigrations } from '../test-utils/create-test-db';

describe('PluginManager consent gate', () => {
  let mgr: PluginManager;
  let svcUsers: ServiceUserManager;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = OFF');
    applyMigrations(sqlite);
    const db = drizzle(sqlite, { schema });
    svcUsers = new ServiceUserManager(db);
    mgr = new PluginManager();
    mgr.setServiceUserManager(svcUsers);
  });

  it('getConsentStatus returns unconsented when approvedScopes is null', () => {
    mgr.loadPlugin(definePlugin({
      name: 'pending', version: '1.0.0',
      aiScopes: ['core.apk:read'], register: () => {},
    }));
    expect(mgr.getConsentStatus('pending', null)).toEqual({
      state: 'unconsented',
      added: ['core.apk:read'],
      removed: [],
    });
  });

  it('getConsentStatus returns ok when approved matches manifest', () => {
    mgr.loadPlugin(definePlugin({
      name: 'approved', version: '1.0.0',
      aiScopes: ['core.apk:read'], register: () => {},
    }));
    expect(mgr.getConsentStatus('approved', ['core.apk:read'])).toEqual({
      state: 'ok',
      added: [],
      removed: [],
    });
  });

  it('getConsentStatus returns drift-wider when manifest adds a new scope', () => {
    mgr.loadPlugin(definePlugin({
      name: 'widened', version: '2.0.0',
      aiScopes: ['core.apk:read', 'core.apk:manage'],
      register: () => {},
    }));
    expect(mgr.getConsentStatus('widened', ['core.apk:read'])).toEqual({
      state: 'drift-wider',
      added: ['core.apk:manage'],
      removed: [],
    });
  });

  it('getConsentStatus returns ok-narrowed when manifest drops a scope', () => {
    mgr.loadPlugin(definePlugin({
      name: 'narrowed', version: '2.0.0',
      aiScopes: ['core.apk:read'],
      register: () => {},
    }));
    expect(mgr.getConsentStatus('narrowed', ['core.apk:read', 'core.apk:manage'])).toEqual({
      state: 'ok-narrowed',
      added: [],
      removed: ['core.apk:manage'],
    });
  });

  it('applyConsent with null approvedScopes removes the service user', () => {
    mgr.loadPlugin(definePlugin({
      name: 'denied', version: '1.0.0',
      aiScopes: ['core.apk:read'], register: () => {},
    }));
    mgr.applyConsent('denied', ['core.apk:read']);   // approve first
    expect(svcUsers.getPluginServiceUser('denied')).not.toBeNull();
    mgr.applyConsent('denied', null);                  // then deny
    expect(svcUsers.getPluginServiceUser('denied')).toBeNull();
  });

  it('applyConsent provisions the service user with the intersection', () => {
    mgr.loadPlugin(definePlugin({
      name: 'approved', version: '1.0.0',
      aiScopes: ['core.apk:read', 'core.apk:manage'],
      register: () => {},
    }));
    // user approved only core.apk:read; manifest wants both — provision should be narrower
    mgr.applyConsent('approved', ['core.apk:read']);
    const row = svcUsers.getPluginServiceUser('approved')!;
    expect(row.scopes).toEqual(['core.apk:read']);
  });

  it('applyConsent on unknown plugin throws', () => {
    expect(() => mgr.applyConsent('ghost', ['core.apk:read']))
      .toThrow(/ghost.*not loaded/i);
  });
});

describe('PluginManager darkride version constraint', () => {
  beforeEach(() => {
    mockLog.mockClear();
  });

  it('warns when plugin darkride constraint is not satisfied by core version', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'future-plugin', version: '1.0.0',
      darkride: '^99.0.0',
      register: () => {},
    });
    mgr.loadPlugin(plugin);
    const warnCalls = mockLog.mock.calls.filter((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a.includes('WARN')),
    );
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0].join(' ')).toMatch(/future-plugin/);
    expect(warnCalls[0].join(' ')).toMatch(/\^99\.0\.0/);
  });

  it('does NOT warn when plugin darkride constraint is satisfied by core version', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'compat-plugin', version: '1.0.0',
      darkride: '^1.0.0',
      register: () => {},
    });
    mgr.loadPlugin(plugin);
    const warnCalls = mockLog.mock.calls.filter((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a.includes('WARN')),
    );
    expect(warnCalls.length).toBe(0);
  });

  it('skips the version check entirely when darkride field is absent', () => {
    const mgr = new PluginManager();
    const plugin = definePlugin({
      name: 'no-constraint', version: '1.0.0',
      register: () => {},
    });
    mgr.loadPlugin(plugin);
    const warnCalls = mockLog.mock.calls.filter((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a.includes('WARN')),
    );
    expect(warnCalls.length).toBe(0);
  });
});
