import { registerEndpoint } from './api-service';
import type { AppDatabase } from '../db/index';
import type { ProxiedRequestService } from '../services/proxied-request-service';
import type { ProxiedHttpRequest } from '../../shared/types/api';
import { isValidCountryCode, isPrivateIp } from '../utils/validators';
import { lookup } from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

async function isPrivateHost(hostname: string): Promise<boolean> {
  try {
    const { address } = await dnsLookup(hostname);
    return isPrivateIp(address);
  } catch {
    return false; // DNS failure — let the request fail naturally
  }
}

function validateProxiedRequest(body: any): { valid: true; request: ProxiedHttpRequest } | { valid: false; error: string } {
  if (!body.url || typeof body.url !== 'string') {
    return { valid: false, error: 'url is required and must be a string' };
  }

  try {
    new URL(body.url);
  } catch {
    return { valid: false, error: 'url is not a valid URL' };
  }

  if (!body.proxy || typeof body.proxy !== 'object') {
    return { valid: false, error: 'proxy is required' };
  }

  const { proxy } = body;
  if (!proxy.type || !['proxyId', 'nordvpn', 'inline', 'direct'].includes(proxy.type)) {
    return { valid: false, error: 'proxy.type must be one of: proxyId, nordvpn, inline, direct' };
  }

  if (proxy.type === 'proxyId') {
    if (typeof proxy.proxyId !== 'number' || !Number.isInteger(proxy.proxyId)) {
      return { valid: false, error: 'proxy.proxyId must be an integer' };
    }
  } else if (proxy.type === 'nordvpn') {
    if (!proxy.country || typeof proxy.country !== 'string') {
      return { valid: false, error: 'proxy.country is required for nordvpn type' };
    }
    if (!isValidCountryCode(proxy.country)) {
      return { valid: false, error: 'Invalid country code' };
    }
  } else if (proxy.type === 'inline') {
    if (!proxy.url || typeof proxy.url !== 'string') {
      return { valid: false, error: 'proxy.url is required for inline type' };
    }
    try {
      new URL(proxy.url);
    } catch {
      return { valid: false, error: 'proxy.url is not a valid URL' };
    }
  }

  return {
    valid: true,
    request: {
      url: body.url,
      method: body.method,
      headers: body.headers,
      body: body.body,
      timeout: body.timeout,
      followRedirects: body.followRedirects,
      maxRedirects: body.maxRedirects,
      proxy: body.proxy,
    },
  };
}

export function registerProxiedRequestEndpoints(
  _db: AppDatabase,
  service: ProxiedRequestService,
): void {
  // POST /v1/proxied-request — single request
  registerEndpoint('POST', '/v1/proxied-request', async (req, res) => {
    const validation = validateProxiedRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({ success: false, error: validation.error });
      return;
    }

    const targetHostname = new URL(validation.request.url).hostname;
    if (await isPrivateHost(targetHostname)) {
      res.status(400).json({ success: false, error: 'Requests to private/internal network addresses are not allowed' });
      return;
    }

    const isAsync = req.query.async === 'true';

    if (isAsync) {
      const job = service.submitRequest(validation.request, true);
      res.status(202).json({ success: true, data: job });
      return;
    }

    try {
      const result = await (service.submitRequest(validation.request, false) as Promise<any>);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(502).json({ success: false, error: err.message });
    }
  });

  // GET /v1/proxied-request/job/:id — poll async job
  registerEndpoint('GET', '/v1/proxied-request/job/:id', (req, res) => {
    const job = service.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Job not found' });
      return;
    }
    res.json({ success: true, data: job });
  });

  // POST /v1/proxied-request/batch — batch requests
  registerEndpoint('POST', '/v1/proxied-request/batch', async (req, res) => {
    const { requests, concurrency, async: isAsync } = req.body;

    if (!Array.isArray(requests)) {
      res.status(400).json({ success: false, error: 'requests must be an array' });
      return;
    }

    if (requests.length === 0) {
      res.status(400).json({ success: false, error: 'requests array must not be empty' });
      return;
    }

    if (requests.length > 100) {
      res.status(400).json({ success: false, error: 'Maximum 100 requests per batch' });
      return;
    }

    // Validate all requests first
    const validated: ProxiedHttpRequest[] = [];
    for (let i = 0; i < requests.length; i++) {
      const v = validateProxiedRequest(requests[i]);
      if (!v.valid) {
        res.status(400).json({ success: false, error: `Request at index ${i}: ${v.error}` });
        return;
      }
      validated.push(v.request);
    }

    // SSRF check: reject any request targeting a private/internal address
    for (let i = 0; i < validated.length; i++) {
      const hostname = new URL(validated[i].url).hostname;
      if (await isPrivateHost(hostname)) {
        res.status(400).json({ success: false, error: `Request at index ${i}: Requests to private/internal network addresses are not allowed` });
        return;
      }
    }

    if (isAsync) {
      const jobs = validated.map((r, index) => {
        const job = service.submitRequest(r, true);
        return { index, jobId: (job as any).id };
      });
      res.status(202).json({ success: true, data: { jobs } });
      return;
    }

    // Sync batch: run with concurrency limit
    const batchConcurrency = Math.min(Math.max(concurrency ?? 5, 1), 20);
    const results: Array<{ index: number; result?: any; error?: string }> = [];

    // Process in chunks of batchConcurrency
    for (let i = 0; i < validated.length; i += batchConcurrency) {
      const chunk = validated.slice(i, i + batchConcurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map((r) => service.submitRequest(r, false) as Promise<any>),
      );

      for (let j = 0; j < chunkResults.length; j++) {
        const cr = chunkResults[j];
        if (cr.status === 'fulfilled') {
          results.push({ index: i + j, result: cr.value });
        } else {
          results.push({ index: i + j, error: cr.reason.message });
        }
      }
    }

    res.json({ success: true, data: { results } });
  });

  // GET /v1/proxied-request/status — service status
  registerEndpoint('GET', '/v1/proxied-request/status', (_req, res) => {
    res.json({ success: true, data: service.getStatus() });
  });

  // GET /v1/proxied-request/history — request history
  registerEndpoint('GET', '/v1/proxied-request/history', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    res.json({ success: true, data: service.getHistory(limit) });
  });
}
