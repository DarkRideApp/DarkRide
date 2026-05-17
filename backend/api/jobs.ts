import { registerEndpoint } from './api-service';
import type { JobRegistry } from '../services/job-registry';

export function registerJobEndpoints(jobRegistry: JobRegistry): void {
  registerEndpoint('GET', '/v1/jobs', (_req, res) => {
    res.json({ success: true, data: jobRegistry.getAll() });
  }, { requires: ['core.jobs:manage'] });

  registerEndpoint('POST', '/v1/jobs/:id/run', async (req, res) => {
    const result = await jobRegistry.runJob(req.params.id);
    if (!result.success) {
      const status = result.error === 'Job not found' ? 404
        : result.error === 'Job is disabled' ? 409
        : 400;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  }, { requires: ['core.jobs:manage'] });

  registerEndpoint('PUT', '/v1/jobs/:id/config', (req, res) => {
    const id = req.params.id;
    const jobs = jobRegistry.getAll();
    if (!jobs.find(j => j.id === id)) {
      res.status(404).json({ success: false, error: 'Job not found' });
      return;
    }

    const updates: { enabled?: boolean; schedule?: string } = {};
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
    if (req.body.schedule !== undefined) updates.schedule = req.body.schedule;

    jobRegistry.updateConfig(id, updates);
    res.json({ success: true });
  }, { requires: ['core.jobs:manage'] });
}
