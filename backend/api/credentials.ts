import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { credentials } from '../db/schema';
import type { AppDatabase } from '../db/index';

function parseCustomFields(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatCredential(row: any) {
  return {
    ...row,
    customFields: parseCustomFields(row.customFields),
  };
}

export function registerCredentialsEndpoints(db: AppDatabase): void {
  // GET /v1/credentials/list — list all credentials, optional ?appId= filter
  registerEndpoint('GET', '/v1/credentials/list', (req, res) => {
    const appId = req.query.appId as string | undefined;
    let query = db.select().from(credentials);
    let result;
    if (appId) {
      result = query.where(eq(credentials.appId, appId)).all();
    } else {
      result = query.all();
    }
    res.json({ success: true, data: result.map(formatCredential) });
  }, { requires: ['core.credentials:read'] });

  // POST /v1/credentials/add — create a new credential
  registerEndpoint('POST', '/v1/credentials/add', (req, res) => {
    const { appId, username, password, customFields } = req.body;

    if (!appId || typeof appId !== 'string') {
      res.status(400).json({ success: false, error: 'appId is required' });
      return;
    }
    if (!username || typeof username !== 'string') {
      res.status(400).json({ success: false, error: 'username is required' });
      return;
    }
    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'password is required' });
      return;
    }

    const now = new Date();
    db.insert(credentials)
      .values({
        appId,
        username,
        password,
        customFields: customFields ? JSON.stringify(customFields) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Get the inserted row (last insert rowid)
    const all = db.select().from(credentials).all();
    const inserted = all[all.length - 1];

    res.status(201).json({ success: true, data: formatCredential(inserted) });
  }, { requires: ['core.credentials:write'] });

  // PUT /v1/credentials/update/:id — partial update
  registerEndpoint('PUT', '/v1/credentials/update/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    const existing = db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (req.body.appId !== undefined) updates.appId = req.body.appId;
    if (req.body.username !== undefined) updates.username = req.body.username;
    if (req.body.password !== undefined) updates.password = req.body.password;
    if (req.body.customFields !== undefined) {
      updates.customFields = req.body.customFields ? JSON.stringify(req.body.customFields) : null;
    }

    db.update(credentials).set(updates).where(eq(credentials.id, id)).run();

    const updated = db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id))
      .all()[0];

    res.json({ success: true, data: formatCredential(updated) });
  }, { requires: ['core.credentials:write'] });

  // DELETE /v1/credentials/delete/:id — delete by id
  registerEndpoint('DELETE', '/v1/credentials/delete/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }

    const existing = db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    db.delete(credentials).where(eq(credentials.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.credentials:write'] });
}
