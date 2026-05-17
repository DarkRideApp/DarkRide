import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { proxies } from '../db/schema';
import type { AppDatabase } from '../db/index';

export function registerProxyEndpoints(db: AppDatabase): void {
  // GET /v1/proxy/list — list all proxies with status
  registerEndpoint('GET', '/v1/proxy/list', (_req, res) => {
    const result = db.select().from(proxies).all();
    res.json({ success: true, data: result });
  }, { requires: ['core.proxies:manage'] });

  // POST /v1/proxy/add — add new proxy
  registerEndpoint('POST', '/v1/proxy/add', (req, res) => {
    const { url, username, password } = req.body;

    if (!url) {
      res.status(400).json({ success: false, error: 'url is required' });
      return;
    }

    db.insert(proxies)
      .values({
        url,
        username: username || null,
        password: password || null,
        createdAt: new Date(),
      })
      .run();

    const inserted = db.select().from(proxies).all();
    const proxy = inserted[inserted.length - 1];
    res.status(201).json({ success: true, data: proxy });
  }, { requires: ['core.proxies:manage'] });

  // GET /v1/proxy/view/:id — view proxy details
  registerEndpoint('GET', '/v1/proxy/view/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid proxy id' });
      return;
    }

    const proxy = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    if (!proxy) {
      res.status(404).json({ success: false, error: 'Proxy not found' });
      return;
    }

    res.json({ success: true, data: proxy });
  }, { requires: ['core.proxies:manage'] });

  // PUT /v1/proxy/update/:id — update proxy config
  registerEndpoint('PUT', '/v1/proxy/update/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid proxy id' });
      return;
    }

    const existing = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Proxy not found' });
      return;
    }

    const updates: Record<string, any> = {};
    if (req.body.url !== undefined) updates.url = req.body.url;
    if (req.body.username !== undefined) updates.username = req.body.username;
    if (req.body.password !== undefined) updates.password = req.body.password;
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

    if (Object.keys(updates).length > 0) {
      db.update(proxies).set(updates).where(eq(proxies.id, id)).run();
    }

    const updated = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.proxies:manage'] });

  // DELETE /v1/proxy/delete/:id — remove proxy
  registerEndpoint('DELETE', '/v1/proxy/delete/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid proxy id' });
      return;
    }

    const existing = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Proxy not found' });
      return;
    }

    db.delete(proxies).where(eq(proxies.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.proxies:manage'] });

  // POST /v1/proxy/enable/:id — enable proxy
  registerEndpoint('POST', '/v1/proxy/enable/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid proxy id' });
      return;
    }

    const existing = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Proxy not found' });
      return;
    }

    db.update(proxies).set({ enabled: true }).where(eq(proxies.id, id)).run();
    const updated = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.proxies:manage'] });

  // POST /v1/proxy/disable/:id — disable proxy
  registerEndpoint('POST', '/v1/proxy/disable/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid proxy id' });
      return;
    }

    const existing = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Proxy not found' });
      return;
    }

    db.update(proxies).set({ enabled: false }).where(eq(proxies.id, id)).run();
    const updated = db.select().from(proxies).where(eq(proxies.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.proxies:manage'] });
}
