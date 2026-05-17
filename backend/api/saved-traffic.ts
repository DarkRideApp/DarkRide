import { registerEndpoint } from './api-service';
import type { SavedTrafficStore } from '../services/saved-traffic-store';

export function registerSavedTrafficEndpoints(store: SavedTrafficStore): void {
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
