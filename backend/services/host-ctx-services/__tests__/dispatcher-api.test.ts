import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from 'undici';
import { createDispatcherApi } from '../dispatcher-api';

describe('createDispatcherApi — pool semantics', () => {
  it('returns the same Dispatcher for structurally-equal specs', () => {
    const dispatcher = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u', password: 'p' },
    };

    const a = dispatcher(spec);
    const b = dispatcher({ ...spec });

    expect(a).toBe(b);
  });

  it('returns distinct Dispatchers for specs with different host', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = dispatcher({ type: 'socks5', host: 'uk.socks.nordhold.net', port: 1080 });

    expect(a).not.toBe(b);
  });

  it('returns distinct Dispatchers for specs with different auth credentials', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u1', password: 'p' },
    });
    const b = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u2', password: 'p' },
    });

    expect(a).not.toBe(b);
  });

  it('returns distinct Dispatchers for different connections caps', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080, connections: 4 });
    const b = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080, connections: 16 });

    expect(a).not.toBe(b);
  });

  it('treats a missing connections value as the default (8) for keying', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080, connections: 8 });

    expect(a).toBe(b);
  });

  it('treats a missing auth as distinct from an empty auth', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: '', password: '' },
    });

    // Both legitimate specs but semantically different — an attacker
    // who can't read auth shouldn't be able to claim "no auth needed".
    expect(a).not.toBe(b);
  });

  it('does not collide when username or password contains the separator character', () => {
    // Regression guard: if the impl's `\x00` separator is ever "fixed"
    // to `:` or `||`, this test catches the resulting hash collision.
    // See the comment on specKey() in dispatcher-api.ts.
    const dispatcher = createDispatcherApi();
    const a = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u:p', password: '' },
    });
    const b = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u', password: ':p' },
    });

    expect(a).not.toBe(b);
  });

  it('returns an undici Dispatcher (has dispatch method)', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });

    expect(a).toBeInstanceOf(Agent);
  });
});

import { SocksClient } from 'socks';
import * as tls from 'tls';

vi.mock('socks');
vi.mock('tls');

describe('createDispatcherApi — SOCKS5 connect callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls SocksClient.createConnection with the right proxy params on connect', async () => {
    // Verify directly via the captured connect option. We expose the
    // last-built agent's connect callback via a test-only accessor on
    // the api object (added in the implementation below) so tests can
    // drive it without needing a real TCP target.
    const fakeRawSocket = { fake: 'raw' } as any;
    vi.mocked(SocksClient.createConnection).mockResolvedValue({
      socket: fakeRawSocket,
    } as any);

    const fakeTlsSocket: any = {
      once: vi.fn(),
    };
    fakeTlsSocket.once.mockImplementation((event: string, cb: any) => {
      if (event === 'secureConnect') queueMicrotask(cb);
      return fakeTlsSocket;
    });
    vi.mocked(tls.connect).mockReturnValue(fakeTlsSocket);

    const api = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'usr', password: 'pwd' },
    };
    api(spec);

    // Pull out the connect callback we registered on the Agent
    const connectFn = (api as any).__testConnectFor(spec);
    expect(typeof connectFn).toBe('function');

    await new Promise<void>((resolve, reject) => {
      connectFn(
        { hostname: 'example.com', port: 443, protocol: 'https:', servername: 'example.com' },
        (err: any, socket: any) => {
          try {
            expect(err).toBeNull();
            expect(socket).toBe(fakeTlsSocket);
            expect(SocksClient.createConnection).toHaveBeenCalledWith({
              proxy: { host: 'us.socks.nordhold.net', port: 1080, type: 5, userId: 'usr', password: 'pwd' },
              command: 'connect',
              destination: { host: 'example.com', port: 443 },
            });
            expect(tls.connect).toHaveBeenCalledWith({
              socket: fakeRawSocket,
              servername: 'example.com',
              ALPNProtocols: ['http/1.1'],
            });
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  });

  it('returns the raw SOCKS socket directly for non-HTTPS targets', async () => {
    const fakeRawSocket = { fake: 'raw' } as any;
    vi.mocked(SocksClient.createConnection).mockResolvedValue({
      socket: fakeRawSocket,
    } as any);

    const api = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
    };
    api(spec);

    const connectFn = (api as any).__testConnectFor(spec);
    await new Promise<void>((resolve, reject) => {
      connectFn(
        { hostname: 'example.com', port: 80, protocol: 'http:' },
        (err: any, socket: any) => {
          try {
            expect(err).toBeNull();
            expect(socket).toBe(fakeRawSocket);
            expect(tls.connect).not.toHaveBeenCalled();
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  });

  it('propagates SocksClient errors via the connect callback', async () => {
    const socksErr = new Error('socks: connection refused');
    vi.mocked(SocksClient.createConnection).mockRejectedValue(socksErr);

    const api = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
    };
    api(spec);

    const connectFn = (api as any).__testConnectFor(spec);
    await new Promise<void>((resolve, reject) => {
      connectFn(
        { hostname: 'example.com', port: 443, protocol: 'https:' },
        (err: any, socket: any) => {
          try {
            expect(err).toBe(socksErr);
            expect(socket).toBeNull();
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  });

  it('propagates TLS handshake errors via the connect callback', async () => {
    // SOCKS tunnel succeeds; TLS upgrade then fails. The connect
    // callback must surface the TLS error, not silently complete.
    const fakeRawSocket = { fake: 'raw' } as any;
    vi.mocked(SocksClient.createConnection).mockResolvedValue({
      socket: fakeRawSocket,
    } as any);

    const tlsErr = new Error('tls: handshake failed');
    const fakeTlsSocket: any = {
      once: vi.fn(),
    };
    fakeTlsSocket.once.mockImplementation((event: string, cb: any) => {
      // Fire 'error' instead of 'secureConnect'
      if (event === 'error') queueMicrotask(() => cb(tlsErr));
      return fakeTlsSocket;
    });
    vi.mocked(tls.connect).mockReturnValue(fakeTlsSocket);

    const api = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
    };
    api(spec);

    const connectFn = (api as any).__testConnectFor(spec);
    await new Promise<void>((resolve, reject) => {
      connectFn(
        { hostname: 'example.com', port: 443, protocol: 'https:' },
        (err: any, socket: any) => {
          try {
            expect(err).toBe(tlsErr);
            expect(socket).toBeNull();
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  });
});

describe('createDispatcherApi — lifecycle', () => {
  it('closeAll() closes every pooled dispatcher and clears the pool', async () => {
    const api = createDispatcherApi();
    const a = api({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = api({ type: 'socks5', host: 'uk.socks.nordhold.net', port: 1080 });
    // Mock close so the spy doesn't recurse into undici internals:
    // DispatcherBase.close() with no callback wraps itself in a Promise
    // by calling this.close(cb), which would double-count the spy.
    const closeSpyA = vi.spyOn(a, 'close').mockResolvedValue();
    const closeSpyB = vi.spyOn(b, 'close').mockResolvedValue();

    await api.closeAll();

    expect(closeSpyA).toHaveBeenCalledTimes(1);
    expect(closeSpyB).toHaveBeenCalledTimes(1);

    // After closeAll the pool is empty — next call constructs fresh
    const aAgain = api({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    expect(aAgain).not.toBe(a);
  });

  it('closeAll() does not throw when an individual close rejects', async () => {
    const api = createDispatcherApi();
    const a = api({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    vi.spyOn(a, 'close').mockRejectedValue(new Error('drain timeout'));

    // Should NOT propagate — closeAll uses Promise.allSettled, so a
    // single bad agent doesn't block shutdown of the rest.
    await expect(api.closeAll()).resolves.toBeUndefined();
  });
});

describe('createDispatcherApi — concurrent construction', () => {
  it('50 concurrent calls with equal specs construct exactly one Agent', async () => {
    const api = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u', password: 'p' },
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(api(spec))),
    );

    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it('mixed concurrent calls across distinct specs each construct exactly one Agent', async () => {
    const api = createDispatcherApi();
    const usSpec = { type: 'socks5' as const, host: 'us.socks.nordhold.net', port: 1080 };
    const ukSpec = { type: 'socks5' as const, host: 'uk.socks.nordhold.net', port: 1080 };

    const results = await Promise.all([
      ...Array.from({ length: 25 }, () => Promise.resolve(api(usSpec))),
      ...Array.from({ length: 25 }, () => Promise.resolve(api(ukSpec))),
    ]);

    const uniqueUs = new Set(results.slice(0, 25));
    const uniqueUk = new Set(results.slice(25));
    expect(uniqueUs.size).toBe(1);
    expect(uniqueUk.size).toBe(1);
    expect([...uniqueUs][0]).not.toBe([...uniqueUk][0]);
  });
});
