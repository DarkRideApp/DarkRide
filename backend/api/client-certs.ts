import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { clientCerts } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { syncInterceptConfig } from '../services/intercept-config-writer';

function parseHostnames(hostnames: any): string | null {
  if (Array.isArray(hostnames)) {
    return JSON.stringify(hostnames.map((h: any) => String(h).trim()).filter(Boolean));
  }
  if (typeof hostnames === 'string') {
    // Try JSON array first
    const trimmed = hostnames.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return JSON.stringify(parsed.map((h: any) => String(h).trim()).filter(Boolean));
        }
      } catch {
        // fall through to comma-separated
      }
    }
    // Comma-separated string
    const parts = trimmed.split(',').map((h) => h.trim()).filter(Boolean);
    return JSON.stringify(parts);
  }
  return null;
}

function parseHostnamesForResponse(hostnamesJson: string): string[] {
  try {
    return JSON.parse(hostnamesJson);
  } catch {
    return [];
  }
}

function formatRow(row: any) {
  return {
    ...row,
    hostnames: parseHostnamesForResponse(row.hostnames),
  };
}

export function registerClientCertEndpoints(
  db: AppDatabase,
  broadcastFn: (msg: any) => void,
): void {
  // GET /v1/certs — list all certs
  registerEndpoint('GET', '/v1/certs', (_req, res) => {
    const rows = db.select().from(clientCerts).all();
    res.json({ success: true, data: rows.map(formatRow) });
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/certs — create a cert
  registerEndpoint('POST', '/v1/certs', (req, res) => {
    const { name, hostnames, certPem, keyPem, enabled } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ success: false, error: 'name is required and must be a non-empty string' });
      return;
    }

    if (hostnames === undefined || hostnames === null) {
      res.status(400).json({ success: false, error: 'hostnames is required' });
      return;
    }

    const hostnamesStr = parseHostnames(hostnames);
    if (hostnamesStr === null) {
      res.status(400).json({ success: false, error: 'hostnames must be an array or comma-separated string' });
      return;
    }

    if (!certPem || typeof certPem !== 'string' || certPem.trim() === '') {
      res.status(400).json({ success: false, error: 'certPem is required and must be a non-empty string' });
      return;
    }

    if (!keyPem || typeof keyPem !== 'string' || keyPem.trim() === '') {
      res.status(400).json({ success: false, error: 'keyPem is required and must be a non-empty string' });
      return;
    }

    const now = new Date();
    const result = db.insert(clientCerts).values({
      name: name.trim(),
      hostnames: hostnamesStr,
      certPem: certPem.trim(),
      keyPem: keyPem.trim(),
      enabled: enabled !== undefined ? enabled : true,
      createdAt: now,
    }).run();

    const insertedId = Number(result.lastInsertRowid);
    const inserted = db.select().from(clientCerts).where(eq(clientCerts.id, insertedId)).all()[0];

    syncInterceptConfig(db);
    broadcastFn({ type: 'client-certs-changed' });
    res.status(201).json({ success: true, data: formatRow(inserted) });
  }, { requires: ['core.traffic:manage'] });

  // PUT /v1/certs/:id — update a cert
  registerEndpoint('PUT', '/v1/certs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid cert id' });
      return;
    }

    const existing = db.select().from(clientCerts).where(eq(clientCerts.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Cert not found' });
      return;
    }

    const { name, hostnames, certPem, keyPem, enabled } = req.body;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ success: false, error: 'name must be a non-empty string' });
        return;
      }
    }

    if (certPem !== undefined) {
      if (typeof certPem !== 'string' || certPem.trim() === '') {
        res.status(400).json({ success: false, error: 'certPem must be a non-empty string' });
        return;
      }
    }

    if (keyPem !== undefined) {
      if (typeof keyPem !== 'string' || keyPem.trim() === '') {
        res.status(400).json({ success: false, error: 'keyPem must be a non-empty string' });
        return;
      }
    }

    const updateSet: Record<string, any> = {};

    if (name !== undefined) updateSet.name = name.trim();

    if (hostnames !== undefined) {
      const hostnamesStr = parseHostnames(hostnames);
      if (hostnamesStr === null) {
        res.status(400).json({ success: false, error: 'hostnames must be an array or comma-separated string' });
        return;
      }
      updateSet.hostnames = hostnamesStr;
    }

    if (certPem !== undefined) updateSet.certPem = certPem.trim();
    if (keyPem !== undefined) updateSet.keyPem = keyPem.trim();
    if (enabled !== undefined) updateSet.enabled = enabled;

    db.update(clientCerts).set(updateSet).where(eq(clientCerts.id, id)).run();

    const updated = db.select().from(clientCerts).where(eq(clientCerts.id, id)).all()[0];

    syncInterceptConfig(db);
    broadcastFn({ type: 'client-certs-changed' });
    res.json({ success: true, data: formatRow(updated) });
  }, { requires: ['core.traffic:manage'] });

  // DELETE /v1/certs/:id — delete a cert
  registerEndpoint('DELETE', '/v1/certs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid cert id' });
      return;
    }

    const existing = db.select().from(clientCerts).where(eq(clientCerts.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Cert not found' });
      return;
    }

    db.delete(clientCerts).where(eq(clientCerts.id, id)).run();

    syncInterceptConfig(db);
    broadcastFn({ type: 'client-certs-changed' });
    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // PATCH /v1/certs/:id/toggle — toggle enabled field
  registerEndpoint('PATCH', '/v1/certs/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid cert id' });
      return;
    }

    const existing = db.select().from(clientCerts).where(eq(clientCerts.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Cert not found' });
      return;
    }

    db.update(clientCerts)
      .set({ enabled: !existing.enabled })
      .where(eq(clientCerts.id, id))
      .run();

    const updated = db.select().from(clientCerts).where(eq(clientCerts.id, id)).all()[0];

    syncInterceptConfig(db);
    broadcastFn({ type: 'client-certs-changed' });
    res.json({ success: true, data: formatRow(updated) });
  }, { requires: ['core.traffic:manage'] });
}
