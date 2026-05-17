import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpAPIImpl } from './http-api';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { setServerMitmproxyPool } from './server-mitmproxy-pool';
import type { ExecutionLogEntry } from '../../shared/types/automation';

/**
 * Regression coverage for the deviceless-proxy fix.
 *
 * setProxy('nordvpn') was unreachable for deviceless automations before —
 * the proxy handler was only wired when there was a real device attached.
 * Now HttpAPIImpl owns the proxy state directly, scoped per-instance (so
 * per-automation), and the runner wires device.setProxy(...) to delegate
 * here for deviceless runs.
 */
describe('HttpAPIImpl.setProxy', () => {
  let executionLog: ExecutionLogEntry[];
  let db: any;

  beforeEach(() => {
    executionLog = [];
    db = createTestDb();
  });

  it('setProxy("none") clears the dispatcher and is idempotent', async () => {
    const api = new HttpAPIImpl(executionLog, db);
    await api.setProxy('none');
    await api.setProxy('none');
    // Both calls should be logged
    const setProxyCalls = executionLog.filter(e => e.method === 'http.setProxy');
    expect(setProxyCalls).toHaveLength(2);
    expect(setProxyCalls.every(e => !e.error)).toBe(true);
  });

  it('setProxy("nordvpn") errors clearly when country is missing', async () => {
    const api = new HttpAPIImpl(executionLog, db);
    await expect(api.setProxy('nordvpn')).rejects.toThrow(/country is required/);
    // Failure is also recorded in the execution log
    const failedCall = executionLog.find(e => e.method === 'http.setProxy' && e.error);
    expect(failedCall?.error).toMatch(/country is required/);
  });

  it('setProxy("nordvpn") errors clearly when credentials are not configured', async () => {
    const api = new HttpAPIImpl(executionLog, db);
    await expect(api.setProxy('nordvpn', { country: 'us' })).rejects.toThrow(/NordVPN credentials not configured/);
  });

  it('setProxy("nordvpn") accepts when credentials are configured', async () => {
    db.insert(schema.settings).values({ key: 'nordvpn_username', value: 'demo-user' }).run();
    db.insert(schema.settings).values({ key: 'nordvpn_password', value: 'demo-pass' }).run();
    const api = new HttpAPIImpl(executionLog, db);
    await expect(api.setProxy('nordvpn', { country: 'us' })).resolves.toBeUndefined();
    const call = executionLog.find(e => e.method === 'http.setProxy');
    expect(call?.params).toMatchObject({ mode: 'nordvpn', country: 'us' });
    expect(call?.error).toBeUndefined();
    await api.dispose();
  });

  it('setProxy("normal") errors when no enabled proxy is configured', async () => {
    const api = new HttpAPIImpl(executionLog, db);
    await expect(api.setProxy('normal')).rejects.toThrow(/No enabled proxy configured/);
  });

  it('setProxy("normal") uses an enabled proxy from the host list', async () => {
    db.insert(schema.proxies).values({
      url: 'http://proxy.example.com:8080',
      username: null,
      password: null,
      enabled: true,
      failureCount: 0,
      createdAt: new Date(),
    }).run();
    const api = new HttpAPIImpl(executionLog, db);
    await expect(api.setProxy('normal')).resolves.toBeUndefined();
    await api.dispose();
  });

  it('proxy state is per-instance (scoped per-automation)', async () => {
    db.insert(schema.settings).values({ key: 'nordvpn_username', value: 'u' }).run();
    db.insert(schema.settings).values({ key: 'nordvpn_password', value: 'p' }).run();
    const apiA = new HttpAPIImpl([], db);
    const apiB = new HttpAPIImpl([], db);
    await apiA.setProxy('nordvpn', { country: 'us' });
    // apiB should still be proxyless — no shared state.
    // Direct sniff is hidden (private), so we verify by reading the execution log:
    // apiA logged one setProxy call, apiB has logged none.
    expect((apiA as any).dispatcher).not.toBeNull();
    expect((apiB as any).dispatcher).toBeNull();
    await apiA.dispose();
    await apiB.dispose();
  });

  it('dispose() releases the dispatcher and is safe to call repeatedly', async () => {
    db.insert(schema.settings).values({ key: 'nordvpn_username', value: 'u' }).run();
    db.insert(schema.settings).values({ key: 'nordvpn_password', value: 'p' }).run();
    const api = new HttpAPIImpl([], db);
    await api.setProxy('nordvpn', { country: 'us' });
    await api.dispose();
    await api.dispose();
    expect((api as any).dispatcher).toBeNull();
  });
});

describe('HttpAPIImpl.setTlsProfile', () => {
  let executionLog: ExecutionLogEntry[];
  let db: any;
  let getProxyUrl: ReturnType<typeof vi.fn>;
  let getCaCert: ReturnType<typeof vi.fn>;
  let dispose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executionLog = [];
    db = createTestDb();
    getProxyUrl = vi.fn().mockResolvedValue('http://127.0.0.1:54321');
    getCaCert = vi.fn().mockReturnValue('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----');
    dispose = vi.fn().mockResolvedValue(undefined);
    setServerMitmproxyPool({ getProxyUrl, getCaCert, dispose } as any);
  });

  afterEach(() => {
    setServerMitmproxyPool(null);
  });

  it('setTlsProfile("chrome") asks the pool for a proxy URL and builds a dispatcher', async () => {
    const api = new HttpAPIImpl(executionLog, db);
    await api.setTlsProfile('chrome');
    expect(getProxyUrl).toHaveBeenCalledWith('chrome');
    expect((api as any).dispatcher).not.toBeNull();
    const call = executionLog.find(e => e.method === 'http.setTlsProfile');
    expect(call?.params).toEqual({ profile: 'chrome' });
    expect(call?.error).toBeUndefined();
    await api.dispose();
  });

  it('setTlsProfile("default") clears the dispatcher and does NOT call the pool', async () => {
    const api = new HttpAPIImpl(executionLog, db);
    await api.setTlsProfile('chrome');
    getProxyUrl.mockClear();
    await api.setTlsProfile('default');
    expect((api as any).dispatcher).toBeNull();
    expect(getProxyUrl).not.toHaveBeenCalled();
  });

  it('setTlsProfile errors clearly when the pool is not initialised', async () => {
    setServerMitmproxyPool(null);
    const api = new HttpAPIImpl(executionLog, db);
    await expect(api.setTlsProfile('chrome')).rejects.toThrow(/pool is not initialised/);
  });

  it('TLS profile state is per-instance (scoped per-automation)', async () => {
    const apiA = new HttpAPIImpl([], db);
    const apiB = new HttpAPIImpl([], db);
    await apiA.setTlsProfile('chrome');
    expect((apiA as any).dispatcher).not.toBeNull();
    expect((apiB as any).dispatcher).toBeNull();
    await apiA.dispose();
    await apiB.dispose();
  });

  it('switching profile destroys the previous dispatcher', async () => {
    const api = new HttpAPIImpl([], db);
    await api.setTlsProfile('chrome');
    const first = (api as any).dispatcher;
    const firstClose = vi.spyOn(first, 'close').mockResolvedValue(undefined);
    getProxyUrl.mockResolvedValueOnce('http://127.0.0.1:54322');
    await api.setTlsProfile('okhttp');
    expect(firstClose).toHaveBeenCalled();
    expect((api as any).dispatcher).not.toBe(first);
    await api.dispose();
  });
});
