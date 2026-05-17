import { eq } from 'drizzle-orm';
import { ProxyAgent, Socks5ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import type { HttpAPI, HttpRequestOptions, HttpResponse, ExecutionLogEntry } from '../../shared/types/automation';
import { settings, proxies } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { getServerMitmproxyPool } from './server-mitmproxy-pool';

/**
 * Server-side HTTP helper exposed to automations as `http.*`. All methods
 * issue ordinary `fetch` requests from the DarkRide server process — no
 * device involvement, no mitmproxy interception. Available in every
 * automation, deviceless or not.
 *
 * Each call is appended to the supplied executionLog so the user sees it
 * in the session timeline alongside device.* calls.
 *
 * Per-automation scoping: each automation run constructs its own
 * HttpAPIImpl, so `setProxy` state lives on the instance and never bleeds
 * into other concurrent automations. Calling `dispose()` releases the
 * underlying dispatcher's sockets.
 */
export class HttpAPIImpl implements HttpAPI {
  private dispatcher: Dispatcher | null = null;

  constructor(
    private executionLog: ExecutionLogEntry[],
    private db?: AppDatabase,
  ) {}

  async setProxy(mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }): Promise<void> {
    const start = Date.now();
    const params: Record<string, any> = { mode };
    if (options?.country) params.country = options.country;
    try {
      const next = await this.buildDispatcher(mode, options);
      // Destroy the previous dispatcher's sockets before swapping — otherwise
      // long-lived connections leak until GC.
      try { await this.dispatcher?.close?.(); } catch { /* best-effort */ }
      this.dispatcher = next;
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        method: 'http.setProxy',
        params,
        result: { configured: mode },
        durationMs: Date.now() - start,
      });
    } catch (err: any) {
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        method: 'http.setProxy',
        params,
        error: err.message,
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  /**
   * Apply a TLS fingerprint profile. Routes subsequent requests through a
   * server-side mitmproxy instance (one per profile, lazy-spawned and
   * shared across automations) so outbound TLS uses the spoofed JA3.
   *
   * 'default' clears any previously-set profile and goes back to direct
   * fetches. Switching profiles destroys any current dispatcher first.
   */
  async setTlsProfile(profile: 'default' | 'chrome' | 'okhttp'): Promise<void> {
    const start = Date.now();
    try {
      try { await this.dispatcher?.close?.(); } catch { /* best-effort */ }
      if (profile === 'default') {
        this.dispatcher = null;
      } else {
        const pool = getServerMitmproxyPool();
        if (!pool) {
          throw new Error('Server-side TLS spoofing pool is not initialised on this host');
        }
        const proxyUrl = await pool.getProxyUrl(profile);
        const ca = pool.getCaCert();
        // undici's ProxyAgent passes `connect` options to the inner TLS
        // connection to the destination (made through the proxy). Trust
        // the mitmproxy CA so the leaf cert mitmproxy presents for the
        // destination validates. Fallback to rejectUnauthorized:false
        // if the CA file isn't readable for some reason — the request
        // is still going through our own localhost mitmproxy.
        const connect: Record<string, any> = ca ? { ca } : { rejectUnauthorized: false };
        this.dispatcher = new ProxyAgent({ uri: proxyUrl, connect });
      }
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        method: 'http.setTlsProfile',
        params: { profile },
        result: { configured: profile },
        durationMs: Date.now() - start,
      });
    } catch (err: any) {
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        method: 'http.setTlsProfile',
        params: { profile },
        error: err.message,
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  /** Release the underlying dispatcher's sockets. Call once when the automation ends. */
  async dispose(): Promise<void> {
    try { await this.dispatcher?.close?.(); } catch { /* best-effort */ }
    this.dispatcher = null;
  }

  private async buildDispatcher(
    mode: 'none' | 'normal' | 'nordvpn',
    options?: { country?: string },
  ): Promise<Dispatcher | null> {
    if (mode === 'none') return null;
    if (mode === 'nordvpn') {
      if (!options?.country) {
        throw new Error('country is required for nordvpn proxy mode');
      }
      if (!this.db) {
        throw new Error('HttpAPI not wired with DB — cannot read NordVPN credentials');
      }
      const usernameRow = this.db.select().from(settings).where(eq(settings.key, 'nordvpn_username')).all()[0];
      const passwordRow = this.db.select().from(settings).where(eq(settings.key, 'nordvpn_password')).all()[0];
      if (!usernameRow?.value || !passwordRow?.value) {
        throw new Error('NordVPN credentials not configured. Set them in Settings → Integrations.');
      }
      const user = encodeURIComponent(usernameRow.value);
      const pass = encodeURIComponent(passwordRow.value);
      const uri = `socks5://${user}:${pass}@${options.country}.socks.nordhold.net:1080`;
      return new Socks5ProxyAgent(uri);
    }
    // mode === 'normal'
    if (!this.db) throw new Error('HttpAPI not wired with DB — cannot read proxy list');
    const row = this.db.select().from(proxies).where(eq(proxies.enabled, true)).all()[0];
    if (!row) throw new Error('No enabled proxy configured in the host proxy list');
    return row.url.startsWith('socks')
      ? new Socks5ProxyAgent(row.url)
      : new ProxyAgent(row.url);
  }

  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('get', url, undefined, options);
  }

  post(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('post', url, body, options);
  }

  put(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('put', url, body, options);
  }

  delete(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('delete', url, undefined, options);
  }

  patch(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('patch', url, body, options);
  }

  private async send(
    method: 'get' | 'post' | 'put' | 'delete' | 'patch',
    url: string,
    body: any,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse> {
    const start = Date.now();
    const params: Record<string, any> = { url };
    if (body !== undefined) params.body = body;
    if (options?.headers) params.headers = options.headers;
    if (options?.timeout != null) params.timeout = options.timeout;

    const controller = new AbortController();
    const timeoutId = options?.timeout
      ? setTimeout(() => controller.abort(), options.timeout)
      : undefined;

    try {
      const init: RequestInit = {
        method: method.toUpperCase(),
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.headers = {
          'Content-Type': 'application/json',
          ...(options?.headers ?? {}),
        };
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      } else if (options?.headers) {
        init.headers = options.headers;
      }
      if (this.dispatcher) {
        // undici-specific option — Node's built-in fetch is undici under the
        // hood. TypeScript's RequestInit doesn't know about it.
        (init as any).dispatcher = this.dispatcher;
      }
      const response = await fetch(url, init);
      const responseBody = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const result: HttpResponse = { status: response.status, headers, body: responseBody };
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        method: `http.${method}`,
        params,
        result: { status: result.status },
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err: any) {
      this.executionLog.push({
        timestamp: new Date().toISOString(),
        method: `http.${method}`,
        params,
        error: err.message,
        durationMs: Date.now() - start,
      });
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
