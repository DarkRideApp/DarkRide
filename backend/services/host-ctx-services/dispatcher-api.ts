import { Agent, type Dispatcher } from 'undici';
import { createHash } from 'crypto';
import { SocksClient } from 'socks';
import * as tls from 'tls';
import type { DispatcherApi, DispatcherSpec } from '@darkrideapp/plugin-sdk';

const DEFAULT_CONNECTIONS = 8;

/**
 * Stable canonical pool key. Credentials are hashed so rotated creds
 * naturally produce a cache miss (no leaked credentials in the key
 * string itself, and no need for an explicit invalidate API).
 *
 * Missing auth and `{username:'',password:''}` are intentionally
 * distinct keys — "no auth" and "empty auth" are different specs.
 *
 * The `\x00` byte between username and password is deliberate: NUL is
 * RFC 1929 forbidden in SOCKS5 credentials, so the separator can never
 * appear inside either field. A `:` separator (as used in HTTP Basic
 * auth) would let `{username: 'u:p', password: ''}` and
 * `{username: 'u', password: ':p'}` hash to the same value — a
 * collision a future reader might introduce by "fixing" the separator
 * to look more conventional. Don't.
 */
function specKey(spec: DispatcherSpec): string {
  const connections = spec.connections ?? DEFAULT_CONNECTIONS;
  let authPart: string;
  if (spec.auth === undefined) {
    authPart = '-';
  } else {
    authPart = createHash('sha256')
      .update(`${spec.auth.username}\x00${spec.auth.password}`)
      .digest('hex')
      .slice(0, 16);
  }
  return `socks5:${spec.host}:${spec.port}:${connections}:${authPart}`;
}

export interface DispatcherService extends DispatcherApi {
  /**
   * Close every pooled Dispatcher. Called from host shutdown after
   * pluginManager.stopAll() has drained in-flight plugin work.
   */
  closeAll(): Promise<void>;
}

export function createDispatcherApi(): DispatcherService {
  const pool = new Map<string, Dispatcher>();
  const connectFns = new Map<string, (opts: any, cb: any) => void>();

  // Lifted from darkride-disney-auth/backend/services/proxy.ts (the
  // canonical implementation moved here per spec 2026-05-19). Two
  // changes from the original: (1) connections cap respected;
  // (2) auth made optional (the disney-auth version always had creds).
  function buildAgent(spec: DispatcherSpec): { agent: Dispatcher; connect: any } {
    const connect = (opts: any, callback: any): void => {
      const { hostname, port, protocol, servername } = opts as {
        hostname: string;
        port: string | number;
        protocol?: string;
        servername?: string;
      };
      const destPort =
        typeof port === 'number'
          ? port
          : parseInt(port ?? '0', 10) || (protocol === 'https:' ? 443 : 80);

      SocksClient.createConnection({
        proxy: {
          host: spec.host,
          port: spec.port,
          type: 5,
          ...(spec.auth ? { userId: spec.auth.username, password: spec.auth.password } : {}),
        },
        command: 'connect',
        destination: { host: hostname, port: destPort },
      })
        .then(({ socket }) => {
          if (protocol === 'https:') {
            const tlsSocket = tls.connect({
              socket,
              servername: servername ?? hostname,
              ALPNProtocols: ['http/1.1'],
            });
            tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
            tlsSocket.once('error', (err: Error) => callback(err, null));
          } else {
            callback(null, socket);
          }
        })
        .catch((err: Error) => callback(err, null));
    };

    const agent = new Agent({
      connections: spec.connections ?? DEFAULT_CONNECTIONS,
      connect,
    });
    return { agent, connect };
  }

  const api = ((spec: DispatcherSpec): Dispatcher => {
    const key = specKey(spec);
    const existing = pool.get(key);
    if (existing) return existing;
    const { agent, connect } = buildAgent(spec);
    pool.set(key, agent);
    connectFns.set(key, connect);
    return agent;
  }) as DispatcherService;

  api.closeAll = async () => {
    const all = [...pool.values()];
    pool.clear();
    connectFns.clear();
    await Promise.allSettled(all.map((a) => a.close()));
  };

  // Test-only accessor — production code never calls this. Used by
  // dispatcher-api.test.ts to drive the SOCKS5 connect callback
  // directly without a real TCP target.
  (api as any).__testConnectFor = (spec: DispatcherSpec) => connectFns.get(specKey(spec));

  return api;
}
