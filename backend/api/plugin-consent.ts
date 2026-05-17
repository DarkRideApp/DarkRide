import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { pluginState } from '../db/schema';
import { getScopeMetadata } from '../auth/scopes-registry';
import type { AppDatabase } from '../db/index';
import type { PluginManager } from '../plugins/plugin-manager';

/**
 * Register plugin scope-consent endpoints.
 *
 * GET  /v1/plugins/:name/scope-status    — report manifest vs approved scopes
 * POST /v1/plugins/:name/approve-scopes  — persist approval and enable plugin
 * POST /v1/plugins/:name/deny-scopes     — clear approval and disable plugin
 *
 * All routes require core.plugins:manage.
 */
export function registerPluginConsentEndpoints(
  db: AppDatabase,
  pluginManager: PluginManager,
): void {
  // ── GET /v1/plugins/:name/scope-status ─────────────────────────────────────

  registerEndpoint(
    'GET',
    '/v1/plugins/:name/scope-status',
    (req, res) => {
      const { name } = req.params;

      if (!pluginManager.hasPlugin(name)) {
        res.status(404).json({ success: false, error: 'Unknown plugin' });
        return;
      }

      const stateRow = db
        .select()
        .from(pluginState)
        .where(eq(pluginState.name, name))
        .get();

      const approved = (stateRow?.approvedAiScopes as string[] | null) ?? null;
      const manifest = pluginManager.getManifest(name);
      const status = pluginManager.getConsentStatus(name, approved);

      res.json({
        success: true,
        plugin: name,
        enabled: stateRow?.enabled ?? false,
        manifestScopes: manifest.aiScopes,
        approvedScopes: approved,
        state: status.state,
        // Annotate added/removed with UI metadata
        added: status.added.map((key) => ({ key, metadata: getScopeMetadata(key) })),
        removed: status.removed,
      });
    },
    { requires: ['core.plugins:manage'] },
  );

  // ── POST /v1/plugins/:name/approve-scopes ──────────────────────────────────

  registerEndpoint(
    'POST',
    '/v1/plugins/:name/approve-scopes',
    (req, res) => {
      const { name } = req.params;

      if (!pluginManager.hasPlugin(name)) {
        res.status(404).json({ success: false, error: 'Unknown plugin' });
        return;
      }

      const requested = req.body?.approvedScopes;

      if (!Array.isArray(requested)) {
        res.status(400).json({ success: false, error: 'approvedScopes must be an array' });
        return;
      }

      const manifestSet = new Set(pluginManager.getManifest(name).aiScopes);
      const invalid = (requested as string[]).filter((s) => !manifestSet.has(s));

      if (invalid.length > 0) {
        res.status(400).json({
          success: false,
          error: `Scopes not in manifest: ${invalid.join(', ')}`,
        });
        return;
      }

      db.update(pluginState)
        .set({
          approvedAiScopes: requested as any,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(pluginState.name, name))
        .run();

      pluginManager.applyConsent(name, requested as string[]);

      const status = pluginManager.getConsentStatus(name, requested as string[]);

      res.json({
        success: true,
        plugin: name,
        approvedScopes: requested,
        state: status.state,
      });
    },
    { requires: ['core.plugins:manage'] },
  );

  // ── POST /v1/plugins/:name/deny-scopes ─────────────────────────────────────

  registerEndpoint(
    'POST',
    '/v1/plugins/:name/deny-scopes',
    (req, res) => {
      const { name } = req.params;

      if (!pluginManager.hasPlugin(name)) {
        res.status(404).json({ success: false, error: 'Unknown plugin' });
        return;
      }

      db.update(pluginState)
        .set({
          approvedAiScopes: null,
          enabled: false,
          updatedAt: new Date(),
        })
        .where(eq(pluginState.name, name))
        .run();

      pluginManager.applyConsent(name, null);

      res.json({ success: true, plugin: name, enabled: false });
    },
    { requires: ['core.plugins:manage'] },
  );
}
