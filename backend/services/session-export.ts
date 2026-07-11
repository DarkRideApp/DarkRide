import { eq } from 'drizzle-orm';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import archiver from 'archiver';
import type { Response } from 'express';
import { automationSessions, screenshots, capturedTraffic, websocketMessages } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { FileStorageService } from './file-storage';

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: any[];
    cookies: any[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: any[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: {};
  timings: {
    blocked: number;
    dns: number;
    connect: number;
    ssl: number;
    send: number;
    wait: number;
    receive: number;
  };
  _webSocketMessages?: Array<{
    type: 'send' | 'receive';
    time: number;
    opcode: number;
    data: string;
  }>;
}

/**
 * Map a stored timing breakdown ({dns,connect,tls,ttfb,download} in ms, each
 * nullable) onto HAR 1.2 `timings`. HAR uses -1 to mean "does not apply /
 * unknown"; segments we never measure (blocked, send) and any null segment
 * become -1. `ssl` in HAR is the TLS-handshake portion (our `tls`).
 */
function buildHarTimings(timingsJson: string | null): HarEntry['timings'] {
  let t: Record<string, number | null> | null = null;
  if (timingsJson) {
    try {
      const parsed = JSON.parse(timingsJson);
      if (parsed && typeof parsed === 'object') t = parsed;
    } catch {
      // ignore malformed timing JSON — fall back to all -1
    }
  }
  const ms = (v: number | null | undefined): number => (typeof v === 'number' ? v : -1);
  return {
    blocked: -1,
    dns: t ? ms(t.dns) : -1,
    connect: t ? ms(t.connect) : -1,
    ssl: t ? ms(t.tls) : -1,
    send: -1,
    wait: t ? ms(t.ttfb) : -1,
    receive: t ? ms(t.download) : -1,
  };
}

function parseHeadersToHar(headersJson: string | null): HarHeader[] {
  if (!headersJson) return [];
  try {
    const parsed = JSON.parse(headersJson);
    if (Array.isArray(parsed)) {
      // Already [{name, value}] format
      return parsed;
    }
    if (typeof parsed === 'object') {
      // {key: value} format
      return Object.entries(parsed).map(([name, value]) => ({
        name,
        value: String(value),
      }));
    }
  } catch {
    // ignore
  }
  return [];
}

export function buildHarJson(
  db: AppDatabase,
  sessionId: number,
): { session: any; har: any } | null {
  const session = db
    .select()
    .from(automationSessions)
    .where(eq(automationSessions.id, sessionId))
    .all()[0];

  if (!session) return null;

  const trafficRows = db
    .select()
    .from(capturedTraffic)
    .where(eq(capturedTraffic.sessionId, sessionId))
    .all();

  const entries: HarEntry[] = trafficRows.map((t) => {
    const requestHeaders = parseHeadersToHar(t.requestHeaders);
    const bodyText = t.responseBody || '';
    const entry: HarEntry = {
      startedDateTime: new Date(t.capturedAt).toISOString(),
      time: t.durationMs ?? 0,
      request: {
        method: t.requestMethod,
        url: t.requestUrl,
        httpVersion: 'HTTP/1.1',
        headers: requestHeaders,
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: t.requestBody ? t.requestBody.length : 0,
        ...(t.requestBody
          ? { postData: { mimeType: 'application/octet-stream', text: t.requestBody } }
          : {}),
      },
      response: {
        status: t.responseStatus ?? 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: [],
        cookies: [],
        content: {
          size: bodyText.length,
          mimeType: 'application/octet-stream',
          ...(bodyText ? { text: bodyText } : {}),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: bodyText.length,
      },
      cache: {},
      timings: buildHarTimings(t.timings),
    };

    if (t.type === 'websocket') {
      const frames = db
        .select()
        .from(websocketMessages)
        .where(eq(websocketMessages.trafficId, t.id))
        .all();
      entry._webSocketMessages = frames.map(f => ({
        type: f.direction === 'send' ? 'send' as const : 'receive' as const,
        time: f.timestamp ? new Date(f.timestamp).getTime() / 1000 : 0,
        opcode: f.opcode === 'text' ? 1 : 2,
        data: f.payload || '',
      }));
    }

    return entry;
  });

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'DarkRide', version: '1.0' },
      entries,
    },
  };

  return { session, har };
}

export function exportSessionHar(
  db: AppDatabase,
  sessionId: number,
  res: Response,
): boolean {
  const result = buildHarJson(db, sessionId);
  if (!result) return false;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=session-${sessionId}.har`);
  res.send(JSON.stringify(result.har, null, 2));
  return true;
}

export async function exportSessionZip(
  db: AppDatabase,
  sessionId: number,
  screenshotPath: string,
  res: Response,
  fileSync?: FileStorageService,
): Promise<boolean> {
  const result = buildHarJson(db, sessionId);
  if (!result) return false;

  const { session, har } = result;

  const sessionScreenshots = db
    .select()
    .from(screenshots)
    .where(eq(screenshots.sessionId, sessionId))
    .all();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename=session-${sessionId}.zip`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  // session.json
  const sessionMeta = {
    id: session.id,
    automationId: session.automationId,
    deviceId: session.deviceId,
    name: session.name,
    notes: session.notes,
    status: session.status,
    triggerType: session.triggerType,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  };
  archive.append(JSON.stringify(sessionMeta, null, 2), { name: 'session.json' });

  // traffic.har
  archive.append(JSON.stringify(har, null, 2), { name: 'traffic.har' });

  // logs.json (if session has logs)
  if (session.logs) {
    try {
      const parsed = JSON.parse(session.logs);
      archive.append(JSON.stringify(parsed, null, 2), { name: 'logs.json' });
    } catch {
      archive.append(session.logs, { name: 'logs.txt' });
    }
  }

  // screenshots/
  for (const ss of sessionScreenshots) {
    const filePath = join(screenshotPath, ss.filename);
    let resolved = false;
    try {
      await stat(filePath);
      archive.append(createReadStream(filePath), { name: `screenshots/${ss.filename}` });
      resolved = true;
    } catch {
      // File missing on disk, try cloud
    }

    if (!resolved && fileSync) {
      const cloudKey = `sessions/${sessionId}/${ss.filename}`;
      const result = await fileSync.acquireLocal(cloudKey, 'session-export', filePath);
      if (!result.error && result.path) {
        archive.append(createReadStream(result.path), { name: `screenshots/${ss.filename}` });
      }
    }
  }

  await archive.finalize();

  return true;
}
