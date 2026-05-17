import { registerEndpoint } from './api-service';
import { ApiKeyManager } from '../auth/api-key-manager';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export function registerApiKeyEndpoints(
  db: BetterSQLite3Database<any>,
  apiKeyManager: ApiKeyManager,
) {
  // GET /v1/profile/api-keys — list my keys
  registerEndpoint('GET', '/v1/profile/api-keys', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const keys = apiKeyManager.listForUser(req.authUser.userId);
    res.json({ success: true, data: keys });
  });

  // POST /v1/profile/api-keys — create a new key
  registerEndpoint('POST', '/v1/profile/api-keys', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const { name, scopes, expiresAt } = req.body;
    if (!name || !scopes || !Array.isArray(scopes)) {
      res.status(400).json({ success: false, error: 'name and scopes[] required' });
      return;
    }
    try {
      const result = apiKeyManager.create(
        req.authUser.userId,
        name,
        scopes,
        expiresAt ? new Date(expiresAt) : null,
      );
      // Return the plaintext key ONCE — it won't be shown again
      res.status(201).json({
        success: true,
        data: {
          id: result.id,
          key: result.key,       // shown once, then never again
          keyPrefix: result.keyPrefix,
        },
      });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // DELETE /v1/profile/api-keys/:id — revoke my key
  registerEndpoint('DELETE', '/v1/profile/api-keys/:id', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const keyId = parseInt(req.params.id, 10);
    if (isNaN(keyId)) { res.status(400).json({ success: false, error: 'Invalid key ID' }); return; }
    const revoked = apiKeyManager.revoke(keyId, req.authUser.userId);
    if (!revoked) { res.status(404).json({ success: false, error: 'Key not found' }); return; }
    res.json({ success: true });
  });

  // GET /v1/admin/api-keys — list all keys (admin only)
  registerEndpoint('GET', '/v1/admin/api-keys', (req, res) => {
    const keys = apiKeyManager.listAll();
    res.json({ success: true, data: keys });
  }, { requires: ['core.users:admin'] });

  // DELETE /v1/admin/api-keys/:id — revoke any key (admin only)
  registerEndpoint('DELETE', '/v1/admin/api-keys/:id', (req, res) => {
    const keyId = parseInt(req.params.id, 10);
    if (isNaN(keyId)) { res.status(400).json({ success: false, error: 'Invalid key ID' }); return; }
    const revoked = apiKeyManager.revokeAsAdmin(keyId);
    if (!revoked) { res.status(404).json({ success: false, error: 'Key not found' }); return; }
    res.json({ success: true });
  }, { requires: ['core.users:admin'] });
}
