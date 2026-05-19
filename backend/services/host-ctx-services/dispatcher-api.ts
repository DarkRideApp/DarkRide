import { Agent, type Dispatcher } from 'undici';
import { createHash } from 'crypto';
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

  function buildAgent(spec: DispatcherSpec): Dispatcher {
    // Phase 2.4: SOCKS5 connect callback will go here. For now a bare
    // Agent so pool semantics can be unit-tested in isolation.
    return new Agent({ connections: spec.connections ?? DEFAULT_CONNECTIONS });
  }

  const api = ((spec: DispatcherSpec): Dispatcher => {
    const key = specKey(spec);
    const existing = pool.get(key);
    if (existing) return existing;
    const agent = buildAgent(spec);
    pool.set(key, agent);
    return agent;
  }) as DispatcherService;

  api.closeAll = async () => {
    const all = [...pool.values()];
    pool.clear();
    await Promise.allSettled(all.map((a) => a.close()));
  };

  return api;
}
