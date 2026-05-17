import { registerEndpoint } from './api-service';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import type { ClaimManager } from '../auth/claim-manager';
import type { SessionManager } from '../auth/session-manager';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export function registerAdminUserEndpoints(
  db: BetterSQLite3Database<any>,
  claimManager: ClaimManager,
  sessionManager: SessionManager,
) {
  // GET /v1/admin/users — list all users
  // Supports optional `kind` query param: 'human' (default), 'core-service', 'plugin-service', 'all'
  registerEndpoint('GET', '/v1/admin/users', (req, res) => {
    const kindParam = (req.query.kind as string | undefined) ?? 'human';

    let rows: any[];
    if (kindParam === 'all') {
      rows = db.select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        providerId: users.providerId,
        scopes: users.scopes,
        kind: users.kind,
        serviceOwner: users.serviceOwner,
        enabled: users.enabled,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      }).from(users).all();
    } else if (kindParam === 'human' || kindParam === 'core-service' || kindParam === 'plugin-service') {
      rows = db.select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        providerId: users.providerId,
        scopes: users.scopes,
        kind: users.kind,
        serviceOwner: users.serviceOwner,
        enabled: users.enabled,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      }).from(users).where(eq(users.kind, kindParam as any)).all();
    } else {
      res.status(400).json({ success: false, error: `Invalid kind: ${kindParam}` });
      return;
    }

    res.json({ success: true, data: rows });
  }, { requires: ['core.users:admin'] });

  // GET /v1/admin/users/:id — get user detail
  registerEndpoint('GET', '/v1/admin/users/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid user ID' }); return; }
    const user = db.select().from(users).where(eq(users.id, id)).get();
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }
    res.json({ success: true, data: user });
  }, { requires: ['core.users:admin'] });

  // PATCH /v1/admin/users/:id — update user (displayName, email, enabled, scopes)
  // Service accounts only allow scopes edits; other fields are rejected.
  registerEndpoint('PATCH', '/v1/admin/users/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid user ID' }); return; }

    const row = db.select().from(users).where(eq(users.id, id)).get();
    if (!row) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    if (row.kind !== 'human') {
      const forbidden = ['displayName', 'email', 'enabled', 'passwordHash', 'passwordMustChange']
        .filter(k => req.body[k] !== undefined);
      if (forbidden.length > 0) {
        res.status(400).json({
          success: false,
          error: `Cannot modify ${forbidden.join(', ')} on a service account; only scopes are editable.`,
        });
        return;
      }
      if (req.body.scopes === undefined) {
        res.status(400).json({ success: false, error: 'No editable fields provided' });
        return;
      }
      db.update(users).set({ scopes: req.body.scopes as any, updatedAt: new Date() }).where(eq(users.id, id)).run();
      res.json({ success: true });
      return;
    }

    const { displayName, email, enabled, scopes } = req.body;
    const updates: any = { updatedAt: new Date() };
    if (displayName !== undefined) updates.displayName = displayName || null;
    if (email !== undefined) updates.email = email || null;
    if (enabled !== undefined) updates.enabled = enabled;
    if (scopes !== undefined) updates.scopes = scopes;

    db.update(users).set(updates).where(eq(users.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.users:admin'] });

  // DELETE /v1/admin/users/:id — delete user (cascades sessions + keys)
  // Service accounts cannot be deleted directly; they are removed via plugin uninstall.
  registerEndpoint('DELETE', '/v1/admin/users/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid user ID' }); return; }

    const row = db.select().from(users).where(eq(users.id, id)).get();
    if (!row) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    if (row.kind !== 'human') {
      res.status(400).json({
        success: false,
        error: row.kind === 'plugin-service'
          ? `Cannot delete a plugin service account. Uninstall the owning plugin "${row.serviceOwner}" to remove it.`
          : `Cannot delete a ${row.kind} account; it is managed in-code.`,
      });
      return;
    }

    // Don't let admin delete themselves
    if (req.authUser && req.authUser.userId === id) {
      res.status(400).json({ success: false, error: 'Cannot delete your own account' });
      return;
    }

    db.delete(users).where(eq(users.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.users:admin'] });

  // POST /v1/admin/users/:id/reset — generate reset claim URL
  // Service accounts have no password and cannot be reset.
  registerEndpoint('POST', '/v1/admin/users/:id/reset', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid user ID' }); return; }

    const row = db.select().from(users).where(eq(users.id, id)).get();
    if (!row) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    if (row.kind !== 'human') {
      res.status(400).json({
        success: false,
        error: `Cannot reset password on a ${row.kind} account`,
      });
      return;
    }

    try {
      const result = claimManager.createResetClaim(id);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }, { requires: ['core.users:admin'] });

  // POST /v1/admin/users/:id/revoke-sessions — revoke all sessions
  // Service accounts have no interactive sessions.
  registerEndpoint('POST', '/v1/admin/users/:id/revoke-sessions', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid user ID' }); return; }

    const row = db.select().from(users).where(eq(users.id, id)).get();
    if (!row) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    if (row.kind !== 'human') {
      res.status(400).json({
        success: false,
        error: `Cannot revoke sessions on a ${row.kind} account (they have no interactive sessions)`,
      });
      return;
    }

    sessionManager.revokeAllForUser(id);
    res.json({ success: true });
  }, { requires: ['core.users:admin'] });
}
