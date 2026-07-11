/**
 * Interactive request/response interception ("breakpoints") API.
 *
 * Separate from the rule-based Intercept feature (intercept-rules.ts). Here a
 * live flow is paused in-flight by the mitmproxy addon, surfaced to every
 * connected UI, edited, and forwarded/dropped by hand.
 *
 * Endpoints:
 *   POST /v1/intercept/hold     — called by the addon; long-polls until resolved
 *   POST /v1/intercept/resolve  — called by a UI; delivers the verdict
 *   GET  /v1/intercept/armed    — read the armed config
 *   POST /v1/intercept/armed    — set the armed config (writes the addon file + broadcasts)
 *   GET  /v1/intercept/held     — snapshot of held flows (for a UI that just connected)
 */

import { registerEndpoint } from './api-service';
import {
  hold,
  resolveHold,
  listHeld,
  getArmed,
  setArmed,
  holdMatches,
  type HoldResolution,
} from '../services/intercept-hold-store';
import type { HeldFlow, InterceptArmedConfig } from '../../shared/types/websocket';
import { createLoggers } from '../logs';

const { error: logError } = createLoggers('intercept-live-api');

type BroadcastFn = (msg: any) => void;
type SyncHoldConfigFn = (config: InterceptArmedConfig) => void;

export function registerInterceptLiveEndpoints(
  broadcastFn: BroadcastFn,
  syncHoldConfig: SyncHoldConfigFn,
): void {
  // POST /v1/intercept/hold — long-poll entry point called by the addon.
  registerEndpoint('POST', '/v1/intercept/hold', async (req, res) => {
    const { flowId, phase, deviceId, sessionId, method, url, headers, body, statusCode } = req.body || {};

    if (!flowId || (phase !== 'request' && phase !== 'response')) {
      res.status(400).json({ success: false, error: "flowId and a valid phase ('request'|'response') are required" });
      return;
    }

    const flow: HeldFlow = {
      flowId,
      phase,
      deviceId: deviceId || null,
      sessionId: sessionId ?? null,
      method: method || 'GET',
      url: url || '',
      headers: headers && typeof headers === 'object' ? headers : {},
      body: body ?? null,
      statusCode: statusCode ?? null,
      createdAt: Date.now(),
    };

    // Defensive server-side guard: if a stale addon posts a flow that no longer
    // matches (or interception was disarmed), forward it immediately instead of
    // hanging the device's traffic.
    if (!holdMatches(flow, phase)) {
      res.json({ action: 'forward' });
      return;
    }

    broadcastFn({ type: 'intercept-held', flowId, phase, flow });

    let resolution: HoldResolution;
    try {
      resolution = await hold(flow);
    } catch (err: any) {
      logError(`hold error for ${flowId}: ${err.message}`);
      resolution = { action: 'forward' };
    }

    // Broadcast the outcome centrally — covers both an explicit resolve and a
    // server-side timeout, so every UI drops the flow from its queue.
    broadcastFn({ type: 'intercept-resolved', flowId, action: resolution.action });
    res.json(resolution);
  }, { requires: ['core.traffic:manage'] });

  // POST /v1/intercept/resolve — a UI delivers the verdict for a held flow.
  registerEndpoint('POST', '/v1/intercept/resolve', (req, res) => {
    const { flowId, action, modified } = req.body || {};
    if (!flowId) {
      res.status(400).json({ success: false, error: 'flowId is required' });
      return;
    }
    if (action !== 'forward' && action !== 'drop') {
      res.status(400).json({ success: false, error: "action must be 'forward' or 'drop'" });
      return;
    }

    const resolution: HoldResolution = { action };
    if (action === 'forward' && modified && typeof modified === 'object') {
      resolution.modified = modified;
    }

    // resolveHold returns false when the flow is unknown or already resolved —
    // this is how a second UI racing the same flow learns it lost.
    const ok = resolveHold(flowId, resolution);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Flow is not held (already resolved or unknown)' });
      return;
    }
    res.json({ success: true });
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/intercept/armed — read the armed config.
  registerEndpoint('GET', '/v1/intercept/armed', (_req, res) => {
    res.json({ success: true, data: getArmed() });
  }, { requires: ['core.traffic:read'] });

  // POST /v1/intercept/armed — set the armed config.
  registerEndpoint('POST', '/v1/intercept/armed', (req, res) => {
    const { enabled, matchHostname, matchPath, matchMethod, phases } = req.body || {};
    const config = setArmed({ enabled, matchHostname, matchPath, matchMethod, phases });

    // Persist to the addon-visible file so the mitmproxy bridge picks it up.
    try {
      syncHoldConfig(config);
    } catch (err: any) {
      logError(`syncHoldConfig failed: ${err.message}`);
    }

    broadcastFn({ type: 'intercept-armed-changed', config });
    res.json({ success: true, data: config });
  }, { requires: ['core.traffic:manage'] });

  // GET /v1/intercept/held — snapshot of held flows for a freshly-connected UI.
  registerEndpoint('GET', '/v1/intercept/held', (_req, res) => {
    res.json({ success: true, data: listHeld() });
  }, { requires: ['core.traffic:read'] });
}
