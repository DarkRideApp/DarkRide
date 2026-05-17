import { registerEndpoint } from './api-service';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../auth/password';
import type { SessionManager } from '../auth/session-manager';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export function registerProfileEndpoints(
  db: BetterSQLite3Database<any>,
  sessionManager: SessionManager,
) {
  // GET /v1/profile — own user info
  registerEndpoint('GET', '/v1/profile', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const user = db.select().from(users).where(eq(users.id, req.authUser.userId)).get();
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }
    const scopes = (Array.isArray(user.scopes) ? user.scopes : JSON.parse(user.scopes as any)) as string[];
    res.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        scopes,
        providerId: user.providerId,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
    });
  });

  // PATCH /v1/profile — update own displayName + email
  registerEndpoint('PATCH', '/v1/profile', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const { displayName, email } = req.body;
    const updates: any = { updatedAt: new Date() };
    if (displayName !== undefined) updates.displayName = displayName || null;
    if (email !== undefined) updates.email = email || null;
    db.update(users).set(updates).where(eq(users.id, req.authUser.userId)).run();
    res.json({ success: true });
  });

  // POST /v1/profile/password — change own password
  registerEndpoint('POST', '/v1/profile/password', async (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const { currentPassword, newPassword } = req.body;

    const user = db.select().from(users).where(eq(users.id, req.authUser.userId)).get();
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    // If user has a password (local provider), require current password
    if (user.passwordHash && !user.passwordMustChange) {
      if (!currentPassword) {
        res.status(400).json({ success: false, error: 'Current password required' });
        return;
      }
      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        res.status(401).json({ success: false, error: 'Current password is incorrect' });
        return;
      }
    }

    if (!newPassword) {
      res.status(400).json({ success: false, error: 'New password required' });
      return;
    }

    const policy = validatePasswordPolicy(newPassword, user.username, user.email);
    if (!policy.valid) {
      res.status(400).json({ success: false, error: policy.reason });
      return;
    }

    const hash = await hashPassword(newPassword);
    db.update(users).set({
      passwordHash: hash,
      passwordUpdatedAt: new Date(),
      passwordMustChange: false,
      updatedAt: new Date(),
    }).where(eq(users.id, req.authUser.userId)).run();

    res.json({ success: true });
  });

  // GET /v1/profile/sessions — list own active sessions
  registerEndpoint('GET', '/v1/profile/sessions', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const list = sessionManager.listForUser(req.authUser.userId);
    // Mark the current session
    const data = list.map(s => ({
      ...s,
      current: s.id === req.authUser!.sessionId,
    }));
    res.json({ success: true, data });
  });

  // DELETE /v1/profile/sessions/:id — revoke a session
  registerEndpoint('DELETE', '/v1/profile/sessions/:id', (req, res) => {
    if (!req.authUser) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    sessionManager.revoke(req.params.id);
    res.json({ success: true });
  });
}
