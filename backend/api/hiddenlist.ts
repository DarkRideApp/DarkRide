import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { hiddenDomains } from '../db/schema';
import { syncHiddenlistFile } from '../services/hiddenlist-writer';
import type { AppDatabase } from '../db/index';

export function registerHiddenlistEndpoints(db: AppDatabase): void {
  // GET /v1/hiddenlist/list — list all hidden domains
  registerEndpoint('GET', '/v1/hiddenlist/list', (_req, res) => {
    const result = db.select().from(hiddenDomains).all();
    res.json({ success: true, data: result });
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/hiddenlist/add — add a domain to the hiddenlist
  registerEndpoint('POST', '/v1/hiddenlist/add', (req, res) => {
    const { domain } = req.body;

    if (!domain || typeof domain !== 'string') {
      res.status(400).json({ success: false, error: 'domain is required' });
      return;
    }

    // Normalize: lowercase, strip leading wildcard prefix
    const normalized = domain.toLowerCase().replace(/^\*\./, '');

    // Check for duplicate — return existing entry (idempotent)
    const existing = db
      .select()
      .from(hiddenDomains)
      .where(eq(hiddenDomains.domain, normalized))
      .all()[0];

    if (existing) {
      res.status(201).json({ success: true, data: existing });
      return;
    }

    db.insert(hiddenDomains)
      .values({ domain: normalized, createdAt: new Date() })
      .run();

    const inserted = db
      .select()
      .from(hiddenDomains)
      .where(eq(hiddenDomains.domain, normalized))
      .all()[0];

    syncHiddenlistFile(db);
    res.status(201).json({ success: true, data: inserted });
  }, { requires: ['core.traffic:manage'] });

  // DELETE /v1/hiddenlist/remove/:id — remove a domain from the hiddenlist
  registerEndpoint('DELETE', '/v1/hiddenlist/remove/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    const existing = db
      .select()
      .from(hiddenDomains)
      .where(eq(hiddenDomains.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Hidden domain not found' });
      return;
    }

    db.delete(hiddenDomains).where(eq(hiddenDomains.id, id)).run();
    syncHiddenlistFile(db);
    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });
}
