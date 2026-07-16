import { registerEndpoint } from './api-service';
import { eq } from 'drizzle-orm';
import type { SavedTrafficStore } from '../services/saved-traffic-store';
import type { AppDatabase } from '../db/index';
import { capturedTraffic } from '../db/schema';

export function registerSavedTrafficEndpoints(store: SavedTrafficStore, db: AppDatabase): void {
  // POST /v1/traffic/saved — persist a captured entry (by id) into saved traffic.
  // Lets the UI "Save this request" without an automation hook calling req.save().
  registerEndpoint('POST', '/v1/traffic/saved', (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'id is required' });
      return;
    }
    const entry = db.select().from(capturedTraffic).where(eq(capturedTraffic.id, id)).all()[0];
    if (!entry) {
      res.status(404).json({ success: false, error: 'Captured traffic not found' });
      return;
    }
    store.save({
      url: entry.requestUrl,
      method: entry.requestMethod,
      requestHeaders: entry.requestHeaders ?? null,
      requestBody: entry.requestBody ?? null,
      responseStatus: entry.responseStatus ?? null,
      responseHeaders: entry.responseHeaders ?? null,
      responseBody: entry.responseBody ?? null,
      deviceId: entry.deviceId ?? null,
    });
    res.json({ success: true, data: { saved: true } });
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/traffic/saved — list or search saved traffic
  // ?url=<pattern> — filter by URL (regex or substring)
  registerEndpoint('GET', '/v1/traffic/saved', (req, res) => {
    const urlPattern = req.query.url as string | undefined;

    if (urlPattern) {
      const results = store.search(urlPattern);
      if (results.length === 0) {
        res.status(404).json({ success: false, error: 'No matching saved traffic' });
        return;
      }
      res.json({ success: true, data: results });
    } else {
      res.json({ success: true, data: store.list() });
    }
  }, { requires: ['core.traffic:read'] });

  // GET /v1/traffic/saved/latest — get the single most recent match
  // ?url=<pattern> — required URL pattern (regex or substring)
  registerEndpoint('GET', '/v1/traffic/saved/latest', (req, res) => {
    const urlPattern = req.query.url as string | undefined;
    if (!urlPattern) {
      res.status(400).json({ success: false, error: 'url query parameter is required' });
      return;
    }

    const results = store.search(urlPattern);
    if (results.length === 0) {
      res.status(404).json({ success: false, error: 'No matching saved traffic' });
      return;
    }

    res.json({ success: true, data: results[0] });
  }, { requires: ['core.traffic:read'] });

  // DELETE /v1/traffic/saved/:id — delete a saved traffic entry
  registerEndpoint('DELETE', '/v1/traffic/saved/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    if (store.delete(id)) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Not found' });
    }
  }, { requires: ['core.traffic:manage'] });

  // DELETE /v1/traffic/saved — delete all saved traffic
  registerEndpoint('DELETE', '/v1/traffic/saved', (_req, res) => {
    store.deleteAll();
    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });
}
