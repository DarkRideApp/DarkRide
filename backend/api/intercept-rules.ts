import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { interceptRules } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { syncInterceptConfig } from '../services/intercept-config-writer';

export function registerInterceptRuleEndpoints(
  db: AppDatabase,
  broadcastFn: (msg: any) => void,
): void {
  // GET /v1/intercept/rules — list all rules ordered by priority ASC
  registerEndpoint('GET', '/v1/intercept/rules', (_req, res) => {
    const rules = db
      .select()
      .from(interceptRules)
      .orderBy(interceptRules.priority)
      .all();
    res.json({ success: true, data: rules });
  }, { requires: ['core.traffic:read'] });

  // POST /v1/intercept/rules — create a new rule
  registerEndpoint('POST', '/v1/intercept/rules', (req, res) => {
    const {
      name,
      matchHostname,
      matchPath,
      matchMethod,
      matchStatusCode,
      matchHeader,
      matchBody,
      phase,
      actions,
      deviceFilter,
      priority,
      enabled,
    } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ success: false, error: 'name is required and must be a non-empty string' });
      return;
    }

    if (!matchHostname || typeof matchHostname !== 'string' || matchHostname.trim() === '') {
      res.status(400).json({ success: false, error: 'matchHostname is required and must be a non-empty string' });
      return;
    }

    if (phase !== 'request' && phase !== 'response') {
      res.status(400).json({ success: false, error: "phase must be 'request' or 'response'" });
      return;
    }

    // Accept actions as string or array
    let actionsStr: string;
    if (typeof actions === 'string') {
      try {
        JSON.parse(actions); // validate it's valid JSON
        actionsStr = actions;
      } catch {
        res.status(400).json({ success: false, error: 'actions must be a valid JSON array' });
        return;
      }
    } else if (Array.isArray(actions)) {
      actionsStr = JSON.stringify(actions);
    } else if (actions === undefined || actions === null) {
      actionsStr = '[]';
    } else {
      res.status(400).json({ success: false, error: 'actions must be a valid JSON array' });
      return;
    }

    const now = new Date();
    const result = db.insert(interceptRules).values({
      name: name.trim(),
      matchHostname: matchHostname.trim(),
      matchPath: matchPath ?? null,
      matchMethod: matchMethod ?? null,
      matchStatusCode: matchStatusCode ?? null,
      matchHeader: matchHeader ?? null,
      matchBody: matchBody ?? null,
      phase,
      actions: actionsStr,
      deviceFilter: deviceFilter ?? null,
      priority: priority ?? 0,
      enabled: enabled !== undefined ? enabled : true,
      createdAt: now,
      updatedAt: now,
    }).run();

    const insertedId = Number(result.lastInsertRowid);
    const inserted = db
      .select()
      .from(interceptRules)
      .where(eq(interceptRules.id, insertedId))
      .all()[0];

    syncInterceptConfig(db);
    broadcastFn({ type: 'intercept-rules-changed' });
    res.status(201).json({ success: true, data: inserted });
  }, { requires: ['core.traffic:manage'] });

  // PUT /v1/intercept/rules/:id — update an existing rule
  registerEndpoint('PUT', '/v1/intercept/rules/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid rule id' });
      return;
    }

    const existing = db
      .select()
      .from(interceptRules)
      .where(eq(interceptRules.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Rule not found' });
      return;
    }

    const {
      name,
      matchHostname,
      matchPath,
      matchMethod,
      matchStatusCode,
      matchHeader,
      matchBody,
      phase,
      actions,
      deviceFilter,
      priority,
      enabled,
    } = req.body;

    // Validation for fields that are provided
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ success: false, error: 'name must be a non-empty string' });
        return;
      }
    }

    if (matchHostname !== undefined) {
      if (typeof matchHostname !== 'string' || matchHostname.trim() === '') {
        res.status(400).json({ success: false, error: 'matchHostname must be a non-empty string' });
        return;
      }
    }

    if (phase !== undefined && phase !== 'request' && phase !== 'response') {
      res.status(400).json({ success: false, error: "phase must be 'request' or 'response'" });
      return;
    }

    // Build update set
    const updateSet: Record<string, any> = { updatedAt: new Date() };

    if (name !== undefined) updateSet.name = name.trim();
    if (matchHostname !== undefined) updateSet.matchHostname = matchHostname.trim();
    if ('matchPath' in req.body) updateSet.matchPath = matchPath ?? null;
    if ('matchMethod' in req.body) updateSet.matchMethod = matchMethod ?? null;
    if ('matchStatusCode' in req.body) updateSet.matchStatusCode = matchStatusCode ?? null;
    if ('matchHeader' in req.body) updateSet.matchHeader = matchHeader ?? null;
    if ('matchBody' in req.body) updateSet.matchBody = matchBody ?? null;
    if (phase !== undefined) updateSet.phase = phase;
    if ('deviceFilter' in req.body) updateSet.deviceFilter = deviceFilter ?? null;
    if (priority !== undefined) updateSet.priority = priority;
    if (enabled !== undefined) updateSet.enabled = enabled;

    if (actions !== undefined) {
      if (typeof actions === 'string') {
        try {
          JSON.parse(actions);
          updateSet.actions = actions;
        } catch {
          res.status(400).json({ success: false, error: 'actions must be a valid JSON array' });
          return;
        }
      } else if (Array.isArray(actions)) {
        updateSet.actions = JSON.stringify(actions);
      } else {
        res.status(400).json({ success: false, error: 'actions must be a valid JSON array' });
        return;
      }
    }

    db.update(interceptRules).set(updateSet).where(eq(interceptRules.id, id)).run();

    const updated = db
      .select()
      .from(interceptRules)
      .where(eq(interceptRules.id, id))
      .all()[0];

    syncInterceptConfig(db);
    broadcastFn({ type: 'intercept-rules-changed' });
    res.json({ success: true, data: updated });
  }, { requires: ['core.traffic:manage'] });

  // DELETE /v1/intercept/rules/:id — delete a rule
  registerEndpoint('DELETE', '/v1/intercept/rules/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid rule id' });
      return;
    }

    const existing = db
      .select()
      .from(interceptRules)
      .where(eq(interceptRules.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Rule not found' });
      return;
    }

    db.delete(interceptRules).where(eq(interceptRules.id, id)).run();

    syncInterceptConfig(db);
    broadcastFn({ type: 'intercept-rules-changed' });
    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // PATCH /v1/intercept/rules/:id/toggle — toggle enabled field
  registerEndpoint('PATCH', '/v1/intercept/rules/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid rule id' });
      return;
    }

    const existing = db
      .select()
      .from(interceptRules)
      .where(eq(interceptRules.id, id))
      .all()[0];

    if (!existing) {
      res.status(404).json({ success: false, error: 'Rule not found' });
      return;
    }

    db.update(interceptRules)
      .set({ enabled: !existing.enabled, updatedAt: new Date() })
      .where(eq(interceptRules.id, id))
      .run();

    const updated = db
      .select()
      .from(interceptRules)
      .where(eq(interceptRules.id, id))
      .all()[0];

    syncInterceptConfig(db);
    broadcastFn({ type: 'intercept-rules-changed' });
    res.json({ success: true, data: updated });
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/intercept/rules/export — export all rules as JSON
  registerEndpoint('GET', '/v1/intercept/rules/export', (_req, res) => {
    const rules = db
      .select()
      .from(interceptRules)
      .orderBy(interceptRules.priority)
      .all()
      .map((r) => ({
        name: r.name,
        enabled: r.enabled,
        matchHostname: r.matchHostname,
        matchPath: r.matchPath,
        matchMethod: r.matchMethod,
        matchStatusCode: r.matchStatusCode,
        matchHeader: r.matchHeader,
        matchBody: r.matchBody,
        phase: r.phase,
        actions: r.actions,
        deviceFilter: r.deviceFilter,
        priority: r.priority,
      }));
    res.json({ success: true, data: { version: 1, rules } });
  }, { requires: ['core.traffic:read'] });

  // POST /v1/intercept/rules/import — import rules from JSON
  registerEndpoint('POST', '/v1/intercept/rules/import', (req, res) => {
    const { rules: importedRules, replace } = req.body;

    if (!Array.isArray(importedRules)) {
      res.status(400).json({ success: false, error: 'rules must be an array' });
      return;
    }

    // If replace mode, delete all existing rules first
    if (replace) {
      db.delete(interceptRules).run();
    }

    const now = new Date();
    let imported = 0;

    for (const rule of importedRules) {
      if (!rule.name || !rule.matchHostname || !rule.phase) continue;
      if (rule.phase !== 'request' && rule.phase !== 'response') continue;

      let actionsStr: string;
      if (typeof rule.actions === 'string') {
        actionsStr = rule.actions;
      } else if (Array.isArray(rule.actions)) {
        actionsStr = JSON.stringify(rule.actions);
      } else {
        actionsStr = '[]';
      }

      db.insert(interceptRules).values({
        name: rule.name,
        enabled: rule.enabled !== undefined ? rule.enabled : true,
        matchHostname: rule.matchHostname,
        matchPath: rule.matchPath ?? null,
        matchMethod: rule.matchMethod ?? null,
        matchStatusCode: rule.matchStatusCode ?? null,
        matchHeader: rule.matchHeader ?? null,
        matchBody: rule.matchBody ?? null,
        phase: rule.phase,
        actions: actionsStr,
        deviceFilter: rule.deviceFilter ?? null,
        priority: rule.priority ?? 0,
        createdAt: now,
        updatedAt: now,
      }).run();
      imported++;
    }

    syncInterceptConfig(db);
    broadcastFn({ type: 'intercept-rules-changed' });
    res.json({ success: true, data: { imported } });
  }, { requires: ['core.traffic:manage'] });
}
