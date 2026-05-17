import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { blockedDomains } from '../db/schema';
import { syncBlocklistFile } from '../services/blocklist-writer';
import type { AppDatabase } from '../db/index';

export function registerBlocklistEndpoints(db: AppDatabase): void {
  // GET /v1/blocklist/list — list all blocked domains
  registerEndpoint('GET', '/v1/blocklist/list', (_req, res) => {
    const result = db.select().from(blockedDomains).all();
    res.json({ success: true, data: result });
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/blocklist/add — add a domain to the blocklist
  registerEndpoint('POST', '/v1/blocklist/add', (req, res) => {
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
      .from(blockedDomains)
      .where(eq(blockedDomains.domain, normalized))
      .all()[0];

    if (existing) {
      res.status(201).json({ success: true, data: existing });
      return;
    }

    db.insert(blockedDomains)
      .values({ domain: normalized, createdAt: new Date() })
      .run();

    const inserted = db
      .select()
      .from(blockedDomains)
      .where(eq(blockedDomains.domain, normalized))
      .all()[0];

    syncBlocklistFile(db);
    res.status(201).json({ success: true, data: inserted });
  }, { requires: ['core.traffic:manage'] });

  // DELETE /v1/blocklist/remove/:id — remove a domain from the blocklist
  registerEndpoint('DELETE', '/v1/blocklist/remove/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    const existing = db
      .select()
      .from(blockedDomains)
      .where(eq(blockedDomains.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Blocked domain not found' });
      return;
    }

    db.delete(blockedDomains).where(eq(blockedDomains.id, id)).run();
    syncBlocklistFile(db);
    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });
}
