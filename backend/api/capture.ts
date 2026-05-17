import { registerEndpoint } from './api-service';
import type { CaptureSessionManager } from '../services/capture-session-manager';
import { createLoggers } from '../logs';
import { isValidCountryCode } from '../utils/validators';

const { log, error } = createLoggers('capture-api');

export function registerCaptureEndpoints(captureManager: CaptureSessionManager): void {
  // POST /v1/capture/start — start traffic capture for a device
  registerEndpoint('POST', '/v1/capture/start', async (req, res) => {
    const { deviceId, proxyMode, proxyCountry, tlsProfile } = req.body;

    if (!deviceId) {
      res.status(400).json({ success: false, error: 'deviceId is required' });
      return;
    }

    // Validate country code when NordVPN mode is selected
    if (proxyMode === 'nordvpn' && proxyCountry && !isValidCountryCode(proxyCountry)) {
      res.status(400).json({ success: false, error: 'Invalid country code' });
      return;
    }

    // Build proxy options if provided
    const proxyOptions = proxyMode
      ? { mode: proxyMode as 'none' | 'normal' | 'nordvpn', country: proxyCountry }
      : undefined;

    try {
      const result = await captureManager.startCapture(deviceId, proxyOptions, tlsProfile);
      log(`Capture started for device ${deviceId}, session ${result.sessionId}`);
      res.json({ success: true, data: { sessionId: result.sessionId } });
    } catch (err: any) {
      error(`Failed to start capture: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/capture/stop — stop traffic capture for a device
  registerEndpoint('POST', '/v1/capture/stop', async (req, res) => {
    const { deviceId } = req.body;

    if (!deviceId) {
      res.status(400).json({ success: false, error: 'deviceId is required' });
      return;
    }

    try {
      await captureManager.stopCapture(deviceId);
      log(`Capture stopped for device ${deviceId}`);
      res.json({ success: true });
    } catch (err: any) {
      error(`Failed to stop capture: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/capture/status/:deviceId — get capture status
  registerEndpoint('GET', '/v1/capture/status/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;

    const capturing = captureManager.isCapturing(deviceId);
    const sessionId = captureManager.getSessionId(deviceId);
    const subsystems = captureManager.getSubsystems(deviceId) ?? null;

    res.json({
      success: true,
      data: {
        capturing,
        sessionId: sessionId ?? null,
        subsystems,
      },
    });
  }, { requires: ['core.traffic:read'] });
}
