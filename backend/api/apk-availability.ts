import { registerEndpoint } from './api-service';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { computeVersionAvailability } from '../services/apk-availability';
import { ApkRestoreService, RestoreLostError } from '../services/apk-restore-service';

/**
 * Register APK availability and restore endpoints.
 *
 * GET  /v1/apks/:package/:versionId/availability  — returns VersionAvailability object
 * POST /v1/apks/:package/:versionId/restore       — triggers restore, returns RestoreOutcome
 */
export function registerApkAvailabilityEndpoints(
  db: BetterSQLite3Database<any>,
  restoreService: ApkRestoreService,
): void {
  // ── GET /v1/apks/:package/:versionId/availability ──────────────────────────

  registerEndpoint(
    'GET',
    '/v1/apks/:package/:versionId/availability',
    (req, res) => {
      const versionId = Number(req.params.versionId);
      if (!Number.isFinite(versionId)) {
        res.status(400).json({ error: 'invalid versionId' });
        return;
      }
      try {
        const avail = computeVersionAvailability(db, versionId);
        res.json(avail);
      } catch (e: any) {
        if (/unknown/i.test(String(e.message))) {
          res.status(404).json({ error: 'version not found' });
          return;
        }
        throw e;
      }
    },
    { requires: ['core.apk:read'] },
  );

  // ── POST /v1/apks/:package/:versionId/restore ──────────────────────────────

  registerEndpoint(
    'POST',
    '/v1/apks/:package/:versionId/restore',
    async (req, res) => {
      const versionId = Number(req.params.versionId);
      if (!Number.isFinite(versionId)) {
        res.status(400).json({ error: 'invalid versionId' });
        return;
      }
      try {
        const outcome = await restoreService.restore(versionId);
        res.json(outcome);
      } catch (e: any) {
        if (e instanceof RestoreLostError) {
          res.status(409).json({ error: String(e.message) });
          return;
        }
        if (/unknown/i.test(String(e.message))) {
          res.status(404).json({ error: 'version not found' });
          return;
        }
        throw e;
      }
    },
    { requires: ['core.apk:manage'] },
  );
}
