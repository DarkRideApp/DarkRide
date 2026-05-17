import { registerEndpoint } from './api-service';
import type { LicenseService } from '../services/license';

export function registerLicenseEndpoints(licenseService: LicenseService): void {
  // GET /v1/license — current license info or null
  registerEndpoint('GET', '/v1/license', async (_req, res) => {
    const info = await licenseService.getLicense();
    if (!info) {
      res.json({ success: true, data: { active: false } });
      return;
    }
    res.json({
      success: true,
      data: {
        active: licenseService.isPro(),
        email: info.email,
        plan: info.plan,
        expiresAt: info.expiresAt.toISOString(),
        issuedAt: info.issuedAt.toISOString(),
        subscriptionId: info.subscriptionId,
        licenseId: info.licenseId,
      },
    });
  }, { requires: ['core.settings:read'] });

  // PUT /v1/license — set / replace the license
  registerEndpoint('PUT', '/v1/license', async (req, res) => {
    const jws = typeof req.body?.jws === 'string' ? req.body.jws : '';
    if (!jws) {
      res.status(400).json({ success: false, error: 'Missing jws field' });
      return;
    }
    const result = await licenseService.setLicense(jws);
    if (!result.ok) {
      res.status(400).json({ success: false, error: result.reason });
      return;
    }
    res.json({
      success: true,
      data: {
        active: true,
        email: result.info.email,
        plan: result.info.plan,
        expiresAt: result.info.expiresAt.toISOString(),
        issuedAt: result.info.issuedAt.toISOString(),
        subscriptionId: result.info.subscriptionId,
        licenseId: result.info.licenseId,
      },
    });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/license — remove the stored license
  registerEndpoint('DELETE', '/v1/license', async (_req, res) => {
    await licenseService.removeLicense();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });
}
