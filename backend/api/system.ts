import { registerEndpoint } from './api-service';
import type { SystemStateService } from '../services/system-state-service';

export function registerSystemEndpoints(systemStateService: SystemStateService): void {
  registerEndpoint('GET', '/v1/system/status', (_req, res) => {
    res.json({
      success: true,
      restartRequired: systemStateService.getRestartRequired(),
    });
  });
}
