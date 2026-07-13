import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { eq } from 'drizzle-orm';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { proxies, settings, clientCerts } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type {
  ProxySource,
  ProxiedHttpRequest,
  ProxiedHttpResponse,
  ProxiedJob,
  ProxiedJobStatus,
  CaptureEgress,
  TlsProfileName,
} from '../../shared/types/api';
import { getTlsProfile, tlsProfileToNodeOptions } from '../../shared/lib/tls-profiles';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('proxied-request');

const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Read-only view of active capture egress. CaptureSessionManager implements
 * this; the replay path uses it to reproduce a capturing device's proxy + TLS
 * profile. Kept as a narrow interface so the service stays testable with a
 * plain stub and doesn't depend on the whole manager.
 */
export interface EgressResolver {
  getEgress(deviceId: string): CaptureEgress | null;
}

interface ResolvedProxy {
  agent: http.Agent | undefined;
  proxyUrl: string;
  /**
   * TLS cipher profile to pose as, when the source implies one (captureSession
   * derives it from the session). undefined = Node's stock TLS.
   */
  tlsProfile?: TlsProfileName;
}

interface PoolEntry {
  agent: http.Agent;
  displayUrl: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface ProxiedRequestHistoryEntry {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  proxyType: string;
  proxyLabel: string;
  status: 'completed' | 'failed';
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  responseBodyBase64: string | null;
  timingMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string;
}

interface QueueItem {
  request: ProxiedHttpRequest;
  jobId: string | null;
  trackingId: string;
  resolve: (result: ProxiedHttpResponse) => void;
  reject: (err: Error) => void;
}

export interface ProxiedRequestServiceOptions {
  maxConcurrency?: number;
  /** Wired to CaptureSessionManager so `captureSession` replays can resolve egress. */
  egressResolver?: EgressResolver;
}

export class ProxiedRequestService {
  private queue: QueueItem[] = [];
  private jobs = new Map<string, ProxiedJob>();
  private activeCount = 0;
  private maxConcurrency: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private jobCounter = 0;
  private trackingCounter = 0;
  private history: ProxiedRequestHistoryEntry[] = [];
  private readonly MAX_HISTORY = 200;

  private proxyPool = new Map<string, PoolEntry>();
  private poolSweepInterval: ReturnType<typeof setInterval> | null = null;
  private readonly POOL_IDLE_MS = 30 * 60 * 1000;     // 30 min inactivity
  private readonly POOL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
  private readonly POOL_SWEEP_MS = 5 * 60 * 1000;     // sweep every 5 min

  private egressResolver?: EgressResolver;

  constructor(
    private db: AppDatabase,
    options?: ProxiedRequestServiceOptions,
  ) {
    this.maxConcurrency = options?.maxConcurrency ?? 5;
    this.egressResolver = options?.egressResolver;
  }

  start(): void {
    this.cleanupInterval = setInterval(() => this.cleanupJobs(), 60_000);
    this.poolSweepInterval = setInterval(() => this.sweepPool(), this.POOL_SWEEP_MS);
    log('Proxied request service started');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.poolSweepInterval) {
      clearInterval(this.poolSweepInterval);
      this.poolSweepInterval = null;
    }
    for (const [key, entry] of this.proxyPool) {
      this.destroyPoolEntry(key, entry);
    }
    log('Proxied request service stopped');
  }

  submitRequest(req: ProxiedHttpRequest, async?: boolean): Promise<ProxiedHttpResponse> | ProxiedJob {
    const trackingId = this.nextTrackingId();
    const now = new Date().toISOString();

    broadcastToAll({
      type: 'proxied-request-queued',
      id: trackingId,
      url: req.url,
      method: (req.method || 'GET').toUpperCase(),
      proxyType: req.proxy.type,
      proxyLabel: this.getProxyLabel(req.proxy),
      createdAt: now,
    });

    if (async) {
      const job = this.createJob();
      const promise = new Promise<ProxiedHttpResponse>((resolve, reject) => {
        this.queue.push({ request: req, jobId: job.id, trackingId, resolve, reject });
      });

      promise.then(
        (result) => {
          const j = this.jobs.get(job.id);
          if (j) {
            j.status = 'completed';
            j.completedAt = new Date().toISOString();
            j.result = result;
          }
        },
        (err) => {
          const j = this.jobs.get(job.id);
          if (j) {
            j.status = 'failed';
            j.completedAt = new Date().toISOString();
            j.error = err.message;
          }
        },
      );

      this.processQueue();
      return job;
    }

    return new Promise<ProxiedHttpResponse>((resolve, reject) => {
      this.queue.push({ request: req, jobId: null, trackingId, resolve, reject });
      this.processQueue();
    });
  }

  getJob(jobId: string): ProxiedJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  getStatus(): { queueLength: number; activeCount: number; maxConcurrency: number } {
    return {
      queueLength: this.queue.length,
      activeCount: this.activeCount,
      maxConcurrency: this.maxConcurrency,
    };
  }

  getHistory(limit?: number): ProxiedRequestHistoryEntry[] {
    const entries = [...this.history].reverse();
    return limit ? entries.slice(0, limit) : entries;
  }

  private getProxyLabel(proxy: ProxySource): string {
    switch (proxy.type) {
      case 'proxyId': return `Proxy #${proxy.proxyId}`;
      case 'nordvpn': return `NordVPN ${proxy.country}`;
      case 'inline': return proxy.url;
      case 'direct': return 'Direct';
      case 'captureSession': return `Capture session (${proxy.deviceId})`;
    }
  }

  private nextTrackingId(): string {
    this.trackingCounter++;
    return `req_${Date.now()}_${this.trackingCounter}`;
  }

  private addHistoryEntry(entry: ProxiedRequestHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }
  }

  resolveProxy(source: ProxySource): ResolvedProxy {
    switch (source.type) {
      case 'proxyId': {
        const row = this.db
          .select()
          .from(proxies)
          .where(eq(proxies.id, source.proxyId))
          .all()[0];
        if (!row) throw new Error(`Proxy with id ${source.proxyId} not found`);
        if (!row.enabled) throw new Error(`Proxy with id ${source.proxyId} is disabled`);

        const parsed = new URL(row.url);
        if (row.username) parsed.username = row.username;
        if (row.password) parsed.password = row.password;
        const cacheKey = parsed.toString();
        const displayUrl = row.username ? `${parsed.protocol}//${parsed.host}` : row.url;

        return this.getOrCreateAgent(cacheKey, () => this.buildAgent(cacheKey), displayUrl);
      }
      case 'nordvpn': {
        const usernameRow = this.db
          .select()
          .from(settings)
          .where(eq(settings.key, 'nordvpn_username'))
          .all()[0];
        const passwordRow = this.db
          .select()
          .from(settings)
          .where(eq(settings.key, 'nordvpn_password'))
          .all()[0];

        if (!usernameRow || !passwordRow) {
          throw new Error('NordVPN credentials not configured');
        }

        const host = `${source.country}.socks.nordhold.net`;
        const cacheKey = `socks5://${usernameRow.value}:${passwordRow.value}@${host}:1080`;
        const displayUrl = `socks5://${host}:1080`;

        return this.getOrCreateAgent(cacheKey, () => new SocksProxyAgent(cacheKey, { keepAlive: true }), displayUrl);
      }
      case 'inline': {
        const parsed = new URL(source.url);
        const cacheKey = parsed.toString();
        const displayUrl = source.url;

        return this.getOrCreateAgent(cacheKey, () => this.buildAgent(cacheKey), displayUrl);
      }
      case 'direct':
        return { agent: undefined, proxyUrl: 'direct' };
      case 'captureSession': {
        // Reproduce the capturing device's egress: same proxy + TLS profile the
        // app's own traffic used. If the device isn't capturing (or no resolver
        // is wired) we can't know its egress — fall back to direct and say so in
        // proxyUsed rather than fail the replay.
        const egress = this.egressResolver?.getEgress(source.deviceId) ?? null;
        if (!egress) {
          return {
            agent: undefined,
            proxyUrl: `capture session (device ${source.deviceId} not capturing — direct)`,
          };
        }
        const profileTag = egress.tlsProfile && egress.tlsProfile !== 'default'
          ? `, ${egress.tlsProfile}`
          : '';
        if (egress.proxyMode === 'nordvpn' && egress.proxyCountry) {
          // Reuse the exact NordVPN branch (credential lookup + SOCKS agent pool).
          const inner = this.resolveProxy({ type: 'nordvpn', country: egress.proxyCountry });
          return {
            agent: inner.agent,
            proxyUrl: `capture session (nordvpn:${egress.proxyCountry}${profileTag})`,
            tlsProfile: egress.tlsProfile,
          };
        }
        // 'normal' upstream mode picks a proxy from the rotating pool per
        // mitmproxy process — that exact selection isn't recorded in egress, so
        // it can't be reproduced deterministically here. Both 'none' and
        // 'normal' therefore egress directly; the label distinguishes them.
        const modeNote = egress.proxyMode === 'normal'
          ? 'normal upstream not reproducible — direct'
          : 'direct';
        return {
          agent: undefined,
          proxyUrl: `capture session (${modeNote}${profileTag})`,
          tlsProfile: egress.tlsProfile,
        };
      }
      default:
        throw new Error(`Unknown proxy source type: ${(source as any).type}`);
    }
  }

  async makeRequest(
    req: ProxiedHttpRequest,
    proxy: ResolvedProxy,
  ): Promise<ProxiedHttpResponse> {
    const startTime = Date.now();
    const method = (req.method || 'GET').toUpperCase();
    const followRedirects = req.followRedirects !== false;
    const maxRedirects = req.maxRedirects ?? 5;
    const timeout = req.timeout ?? 30_000;

    let currentUrl = req.url;
    let currentMethod = method;
    let currentBody = req.body ?? null;
    let redirectCount = 0;

    // Effective TLS profile: an explicit request-level profile wins; otherwise
    // inherit whatever the resolved proxy implied (captureSession derives it
    // from the session). undefined = Node's stock TLS.
    const tlsProfile: TlsProfileName | undefined = req.tlsProfile ?? proxy.tlsProfile;

    while (true) {
      const result = await this.doSingleRequest(
        currentUrl,
        currentMethod,
        req.headers ?? {},
        currentBody,
        timeout,
        proxy,
        tlsProfile,
      );

      if (
        followRedirects &&
        result.statusCode &&
        [301, 302, 303, 307, 308].includes(result.statusCode) &&
        result.headers.location
      ) {
        if (redirectCount >= maxRedirects) {
          throw new Error(`Max redirects (${maxRedirects}) exceeded`);
        }
        redirectCount++;

        const location = result.headers.location;
        currentUrl = new URL(location, currentUrl).toString();

        if ([301, 302, 303].includes(result.statusCode)) {
          currentMethod = 'GET';
          currentBody = null;
        }
        continue;
      }

      const timingMs = Date.now() - startTime;

      // Decompress response body based on Content-Encoding header
      let body = result.body;
      const contentEncoding = (result.headers['content-encoding'] || '').toLowerCase().trim();
      if (contentEncoding && body.length > 0) {
        try {
          if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
            body = Buffer.from(zlib.gunzipSync(body));
          } else if (contentEncoding === 'deflate') {
            body = Buffer.from(zlib.inflateSync(body));
          } else if (contentEncoding === 'br') {
            body = Buffer.from(zlib.brotliDecompressSync(body));
          }
        } catch (e) {
          log(`Failed to decompress ${contentEncoding} response: ${e}`);
        }
      }

      const contentType = (result.headers['content-type'] || '').toLowerCase();
      const isText = contentType.includes('text') ||
        contentType.includes('json') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('html') ||
        contentType.includes('css') ||
        contentType.includes('svg') ||
        contentType.includes('yaml') ||
        contentType.includes('form-urlencoded');

      const responseHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(result.headers)) {
        if (val !== undefined) {
          responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
        }
      }

      return {
        status: result.statusCode!,
        headers: responseHeaders,
        body: isText ? body.toString('utf-8') : null,
        bodyBase64: isText ? null : body.toString('base64'),
        url: currentUrl,
        timingMs,
        proxyUsed: proxy.proxyUrl,
      };
    }
  }

  private buildAgent(fullUrl: string): http.Agent {
    const parsed = new URL(fullUrl);

    if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:' || parsed.protocol === 'socks4:') {
      return new SocksProxyAgent(fullUrl, { keepAlive: true });
    }

    if (parsed.protocol === 'https:') {
      return new HttpsProxyAgent(fullUrl, { keepAlive: true }) as unknown as http.Agent;
    }

    return new HttpProxyAgent(fullUrl, { keepAlive: true }) as unknown as http.Agent;
  }

  private getOrCreateAgent(cacheKey: string, factory: () => http.Agent, displayUrl: string): ResolvedProxy {
    const existing = this.proxyPool.get(cacheKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return { agent: existing.agent, proxyUrl: existing.displayUrl };
    }

    const agent = factory();
    const now = Date.now();
    this.proxyPool.set(cacheKey, {
      agent,
      displayUrl,
      createdAt: now,
      lastUsedAt: now,
    });
    log(`Pool: created agent for ${displayUrl} (pool size: ${this.proxyPool.size})`);
    return { agent, proxyUrl: displayUrl };
  }

  sweepPool(): void {
    const now = Date.now();
    for (const [key, entry] of this.proxyPool) {
      const idle = now - entry.lastUsedAt;
      const age = now - entry.createdAt;
      if (idle > this.POOL_IDLE_MS) {
        log(`Pool: evicting idle agent for ${entry.displayUrl} (idle ${Math.round(idle / 1000)}s)`);
        this.destroyPoolEntry(key, entry);
      } else if (age > this.POOL_MAX_AGE_MS) {
        log(`Pool: evicting expired agent for ${entry.displayUrl} (age ${Math.round(age / 1000)}s)`);
        this.destroyPoolEntry(key, entry);
      }
    }
  }

  private destroyPoolEntry(key: string, entry: PoolEntry): void {
    entry.agent.destroy();
    this.proxyPool.delete(key);
  }

  private findClientCertForHostname(hostname: string): { certPem: string; keyPem: string } | null {
    const certs = this.db.select().from(clientCerts).where(eq(clientCerts.enabled, true)).all();
    for (const cert of certs) {
      const hostnames: string[] = JSON.parse(cert.hostnames);
      if (hostnames.includes(hostname)) {
        return { certPem: cert.certPem, keyPem: cert.keyPem };
      }
    }
    return null;
  }

  /**
   * Build the Node request options for a single hop. Extracted from
   * doSingleRequest so the TLS-profile / client-cert wiring is unit-testable
   * without spying on the (non-configurable) https.request namespace binding.
   */
  private buildRequestOptions(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    proxy: ResolvedProxy,
    tlsProfile?: TlsProfileName,
  ): { options: http.RequestOptions; isHttps: boolean } {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const reqHeaders = { ...headers };
    if (body && !reqHeaders['content-length']) {
      reqHeaders['content-length'] = Buffer.byteLength(body).toString();
    }

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: reqHeaders,
      agent: proxy.agent,
    };

    if (isHttps && parsed.hostname) {
      const clientCert = this.findClientCertForHostname(parsed.hostname);
      if (clientCert) {
        (options as any).cert = clientCert.certPem;
        (options as any).key = clientCert.keyPem;
      }

      // Pose the requested client TLS cipher profile (chrome/okhttp). This is
      // cipher-list parity, NOT byte-exact JA3 — Node/OpenSSL can't control
      // GREASE or extension ordering, and exposes no per-request TLS 1.3
      // ciphersuite option. Same fidelity limit the capture session itself has
      // (mitmproxy's spoof is also cipher-list-level). Only applies to https.
      const profile = getTlsProfile(tlsProfile);
      if (profile) {
        Object.assign(options, tlsProfileToNodeOptions(profile));
      }
    }

    return { options, isHttps };
  }

  private doSingleRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    timeout: number,
    proxy: ResolvedProxy,
    tlsProfile?: TlsProfileName,
  ): Promise<{ statusCode: number | undefined; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const { options, isHttps } = this.buildRequestOptions(url, method, headers, body, proxy, tlsProfile);
      const requestFn = isHttps ? https.request : http.request;

      const req = requestFn(options, (res) => {
        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_RESPONSE_SIZE) {
            req.destroy(new Error('Response too large (>50MB)'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (val !== undefined) {
              responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
            }
          }
          resolve({
            statusCode: res.statusCode,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
          });
        });

        res.on('error', reject);
      });

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Request timeout after ${timeout}ms`));
      });

      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  private createJob(): ProxiedJob {
    this.jobCounter++;
    const id = `job_${Date.now()}_${this.jobCounter}`;
    const job: ProxiedJob = {
      id,
      status: 'pending',
      createdAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    return job;
  }

  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const item = this.queue.shift()!;
      this.activeCount++;

      if (item.jobId) {
        const job = this.jobs.get(item.jobId);
        if (job) job.status = 'running';
      }

      this.executeItem(item).finally(() => {
        this.activeCount--;
        this.processing = false;
        this.processQueue();
      });
    }

    this.processing = false;
  }

  private async executeItem(item: QueueItem): Promise<void> {
    const startedAt = new Date().toISOString();
    broadcastToAll({
      type: 'proxied-request-started',
      id: item.trackingId,
      startedAt,
    });

    try {
      const proxy = this.resolveProxy(item.request.proxy);
      const result = await this.makeRequest(item.request, proxy);

      const completedAt = new Date().toISOString();
      const responseSize = result.body
        ? Buffer.byteLength(result.body, 'utf-8')
        : result.bodyBase64
          ? Math.ceil((result.bodyBase64.length * 3) / 4)
          : 0;

      broadcastToAll({
        type: 'proxied-request-completed',
        id: item.trackingId,
        status: result.status,
        timingMs: result.timingMs,
        responseSize,
        proxyUsed: result.proxyUsed,
        completedAt,
      });

      this.addHistoryEntry({
        id: item.trackingId,
        url: item.request.url,
        method: (item.request.method || 'GET').toUpperCase(),
        headers: item.request.headers ?? null,
        body: item.request.body ?? null,
        proxyType: item.request.proxy.type,
        proxyLabel: this.getProxyLabel(item.request.proxy),
        status: 'completed',
        responseStatus: result.status,
        responseHeaders: result.headers,
        responseBody: result.body,
        responseBodyBase64: result.bodyBase64 ?? null,
        timingMs: result.timingMs,
        error: null,
        createdAt: startedAt,
        completedAt,
      });

      item.resolve(result);
    } catch (err: any) {
      const completedAt = new Date().toISOString();
      broadcastToAll({
        type: 'proxied-request-failed',
        id: item.trackingId,
        error: err.message,
        completedAt,
      });

      this.addHistoryEntry({
        id: item.trackingId,
        url: item.request.url,
        method: (item.request.method || 'GET').toUpperCase(),
        headers: item.request.headers ?? null,
        body: item.request.body ?? null,
        proxyType: item.request.proxy.type,
        proxyLabel: this.getProxyLabel(item.request.proxy),
        status: 'failed',
        responseStatus: null,
        responseHeaders: null,
        responseBody: null,
        responseBodyBase64: null,
        timingMs: null,
        error: err.message,
        createdAt: startedAt,
        completedAt,
      });

      item.reject(err);
    }
  }

  private cleanupJobs(): void {
    const now = Date.now();
    const COMPLETED_TTL = 10 * 60 * 1000; // 10 min
    const MAX_TTL = 30 * 60 * 1000; // 30 min

    for (const [id, job] of this.jobs) {
      const createdAt = new Date(job.createdAt).getTime();
      const age = now - createdAt;

      if (
        (job.status === 'completed' || job.status === 'failed') &&
        age > COMPLETED_TTL
      ) {
        this.jobs.delete(id);
      } else if (age > MAX_TTL) {
        this.jobs.delete(id);
      }
    }
  }
}
