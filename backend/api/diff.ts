import { registerEndpoint } from './api-service';
import type { AppDatabase } from '../db/index';
import type { ApkDiffEngine } from '../services/apk-diff-engine';

export function registerApkDiffEndpoints(db: AppDatabase, diffEngine: ApkDiffEngine): void {
  /** GET /v1/apps/diff/:versionId — get the diff report for an APK version */
  registerEndpoint('GET', '/v1/apps/diff/:versionId', async (req, res) => {
    const versionId = parseInt(req.params.versionId, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ error: 'Invalid versionId' });
      return;
    }
    const report = diffEngine.getDiffReport(versionId);
    res.json({ success: true, report });
  }, { requires: ['core.apk:read'] });

  /** POST /v1/apps/diff/:versionId/run — trigger or rerun diff analysis */
  registerEndpoint('POST', '/v1/apps/diff/:versionId/run', async (req, res) => {
    const versionId = parseInt(req.params.versionId, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ error: 'Invalid versionId' });
      return;
    }
    const result = diffEngine.triggerDiffManual(versionId);
    res.json({ success: true, ...result });
  }, { requires: ['core.apk:manage'] });
}
