import type { Request, Response } from 'express';
import { registerEndpoint } from './api-service';
import { isFilteredChannel, registerFilteredChannel } from '../websocket/channel-registry';
import { SettingsError, type AdbProxySettings } from '../services/adb-proxy/settings';
import type { AdbProxyService } from '../services/adb-proxy/adb-proxy-service';

export const ADB_PROXY_CHANNEL = 'adb-proxy';

const READ = ['core.adb-proxy:read'];
const MANAGE = ['core.adb-proxy:manage'];
// An approved key gets a shell on every proxied phone.
const APPROVE = ['core.adb-proxy:manage', 'core.devices:shell'];

const MAX_PARAM_LENGTH = 128;
const MAX_KEY_DEVICES = 1000;

const STATUS_FOR: Record<string, number> = {
  'not-found': 404,
  'unknown-device': 404,
  'not-approved': 409,
  'in-use': 409,
  'range-full': 409,
  'out-of-range': 400,
  invalid: 400,
};

function fail(res: Response, error: string): void {
  res.status(STATUS_FOR[error] ?? 400).json({ success: false, error });
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const SETTING_RULES: Record<keyof AdbProxySettings, (value: unknown) => boolean> = {
  enabled: (v) => typeof v === 'boolean',
  bindHost: (v) => typeof v === 'string',
  portStart: isCount,
  portEnd: isCount,
};

function settingsPatch(body: any): Partial<AdbProxySettings> | null {
  const patch: Record<string, unknown> = {};
  for (const [name, valid] of Object.entries(SETTING_RULES)) {
    const value = body?.[name];
    if (value === undefined) continue;
    if (!valid(value)) return null;
    patch[name] = value;
  }
  return Object.keys(patch).length > 0 ? (patch as Partial<AdbProxySettings>) : null;
}

function textParam(req: Request, res: Response, name: string): string | null {
  const value = req.params[name];
  if (value.length > MAX_PARAM_LENGTH) {
    fail(res, 'invalid');
    return null;
  }
  return value;
}

function keyId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    fail(res, 'invalid');
    return null;
  }
  return id;
}

type Handler = (req: Request, res: Response, userId: number) => void | Promise<void>;

/** The broadcast handed to the service: a message whose channel is not registered would go to every client, so it is dropped. */
export function adbProxyBroadcast(send: (message: Record<string, unknown>) => void): (message: Record<string, unknown>) => void {
  return (message) => {
    if (isFilteredChannel(ADB_PROXY_CHANNEL)) send(message);
  };
}

export function registerAdbProxyEndpoints(service: AdbProxyService): void {
  registerFilteredChannel(ADB_PROXY_CHANNEL, { requires: READ });

  // registerEndpoint checks scopes only when a user is present, so a missing user is refused here.
  const route = (method: Parameters<typeof registerEndpoint>[0], path: string, requires: string[], handler: Handler) =>
    registerEndpoint(method, path, async (req, res) => {
      if (!req.authUser) {
        res.status(401).json({ success: false, error: 'Auth required' });
        return;
      }
      await handler(req, res, req.authUser.userId);
    }, { requires });

  route('GET', '/v1/adb-proxy/status', READ, (_req, res) => {
    res.json({ success: true, data: service.snapshot() });
  });

  route('GET', '/v1/adb-proxy/keys', READ, (_req, res) => {
    res.json({ success: true, data: service.listKeys() });
  });

  route('PUT', '/v1/adb-proxy/settings', MANAGE, async (req, res) => {
    const patch = settingsPatch(req.body);
    if (!patch) return fail(res, 'invalid');
    try {
      res.json({ success: true, data: await service.updateSettings(patch) });
    } catch (e) {
      if (e instanceof SettingsError) {
        res.status(400).json({ success: false, error: e.message });
        return;
      }
      throw e;
    }
  });

  route('PATCH', '/v1/adb-proxy/devices/:id', MANAGE, async (req, res) => {
    const deviceId = textParam(req, res, 'id');
    if (deviceId === null) return;
    const { enabled, port } = req.body ?? {};
    const badEnabled = enabled !== undefined && typeof enabled !== 'boolean';
    const badPort = port !== undefined && !isCount(port);
    if (badEnabled || badPort || (enabled === undefined && port === undefined)) return fail(res, 'invalid');
    const result = await service.setDevice(deviceId, { enabled, port });
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  });

  route('POST', '/v1/adb-proxy/requests/:requestId/approve', APPROVE,(req, res, userId) => {
    const requestId = textParam(req, res, 'requestId');
    if (requestId === null) return;
    const result = service.approveRequest(requestId, userId);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  });

  route('POST', '/v1/adb-proxy/requests/:requestId/deny', MANAGE, (req, res, userId) => {
    const requestId = textParam(req, res, 'requestId');
    if (requestId === null) return;
    const result = service.denyRequest(requestId, userId);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  });

  route('POST', '/v1/adb-proxy/keys/:id/revoke', MANAGE, (req, res, userId) => {
    const id = keyId(req, res);
    if (id === null) return;
    const result = service.revokeKey(id, userId);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  });

  route('PATCH', '/v1/adb-proxy/keys/:id', MANAGE, (req, res) => {
    const id = keyId(req, res);
    if (id === null) return;
    const deviceIds = req.body?.deviceIds;
    if (deviceIds === undefined || (deviceIds !== null && (!Array.isArray(deviceIds) || deviceIds.length > MAX_KEY_DEVICES))) {
      return fail(res, 'invalid');
    }
    const result = service.setKeyDevices(id, deviceIds);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  });

  route('DELETE', '/v1/adb-proxy/keys/:id', MANAGE, (req, res) => {
    const id = keyId(req, res);
    if (id === null) return;
    const result = service.forgetKey(id);
    if (!result.ok) return fail(res, result.error);
    res.json({ success: true, data: service.snapshot() });
  });
}
