import AdmZip from 'adm-zip';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { automationSessions, capturedTraffic, websocketMessages, screenshots, devices } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';

interface ImportResult {
  sessionId: number;
  trafficCount: number;
  screenshotCount: number;
  wsMessageCount: number;
}

interface HarEntry {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { text?: string };
    bodySize?: number;
  };
  response?: {
    status?: number;
    headers?: Array<{ name: string; value: string }>;
    content?: { text?: string };
  };
  _webSocketMessages?: Array<{
    type: 'send' | 'receive';
    time: number;
    opcode: number;
    data: string;
  }>;
}

function harHeadersToJson(headers?: Array<{ name: string; value: string }>): string | null {
  if (!headers || headers.length === 0) return null;
  const obj: Record<string, string> = {};
  for (const h of headers) {
    obj[h.name] = h.value;
  }
  return JSON.stringify(obj);
}

function importHarEntries(
  db: AppDatabase,
  sessionId: number,
  entries: HarEntry[],
): { trafficCount: number; wsMessageCount: number } {
  let trafficCount = 0;
  let wsMessageCount = 0;

  for (const entry of entries) {
    const req = entry.request;
    const resp = entry.response;
    if (!req?.url || !req?.method) continue;

    const hasWsMessages = entry._webSocketMessages && entry._webSocketMessages.length > 0;
    const type = hasWsMessages ? 'websocket' : 'http';
    const capturedAt = entry.startedDateTime ? new Date(entry.startedDateTime) : new Date();

    let hostname: string | null = null;
    try { hostname = new URL(req.url).hostname; } catch {}

    const result = db.insert(capturedTraffic).values({
      sessionId,
      deviceId: null,
      requestMethod: req.method,
      requestUrl: req.url,
      hostname,
      requestHeaders: harHeadersToJson(req.headers),
      requestBody: req.postData?.text || null,
      responseStatus: resp?.status ?? null,
      responseHeaders: harHeadersToJson(resp?.headers),
      responseBody: resp?.content?.text || null,
      type,
      wsCloseCode: null,
      wsCloseReason: null,
      wsMessageCount: hasWsMessages ? entry._webSocketMessages!.length : 0,
      capturedAt,
      matchedRules: null,
    }).run();

    const trafficId = Number(result.lastInsertRowid);
    trafficCount++;

    if (hasWsMessages) {
      for (const msg of entry._webSocketMessages!) {
        db.insert(websocketMessages).values({
          trafficId,
          sessionId,
          deviceId: null,
          direction: msg.type === 'send' ? 'send' : 'receive',
          opcode: msg.opcode === 1 ? 'text' : 'binary',
          payload: msg.data || null,
          isBinary: msg.opcode !== 1,
          payloadSize: msg.data ? msg.data.length : 0,
          timestamp: new Date(msg.time * 1000),
        }).run();
        wsMessageCount++;
      }
    }
  }

  return { trafficCount, wsMessageCount };
}

export function importSessionHar(
  db: AppDatabase,
  harJson: any,
  name?: string,
): ImportResult {
  const entries: HarEntry[] = harJson?.log?.entries || [];

  // Determine session time range from HAR entries
  let startedAt = new Date();
  if (entries.length > 0 && entries[0].startedDateTime) {
    startedAt = new Date(entries[0].startedDateTime);
  }

  const sessionResult = db.insert(automationSessions).values({
    automationId: null,
    deviceId: null,
    name: name || 'Imported HAR',
    status: 'success',
    triggerType: 'capture',
    logs: null,
    isPinned: false,
    startedAt,
    completedAt: new Date(),
  }).run();

  const sessionId = Number(sessionResult.lastInsertRowid);
  const { trafficCount, wsMessageCount } = importHarEntries(db, sessionId, entries);

  return { sessionId, trafficCount, screenshotCount: 0, wsMessageCount };
}

export async function importSessionZip(
  db: AppDatabase,
  zipBuffer: Buffer,
  screenshotPath: string,
  name?: string,
): Promise<ImportResult> {
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();

  // Read session.json if present
  let sessionMeta: any = null;
  const sessionEntry = zip.getEntry('session.json');
  if (sessionEntry) {
    try {
      sessionMeta = JSON.parse(sessionEntry.getData().toString('utf8'));
    } catch {
      // ignore malformed session.json
    }
  }

  // Read HAR if present
  let harJson: any = null;
  const harEntry = zip.getEntry('traffic.har');
  if (harEntry) {
    try {
      harJson = JSON.parse(harEntry.getData().toString('utf8'));
    } catch {
      // ignore malformed HAR
    }
  }

  // Read logs
  let logs: string | null = null;
  const logsJsonEntry = zip.getEntry('logs.json');
  const logsTxtEntry = zip.getEntry('logs.txt');
  if (logsJsonEntry) {
    logs = logsJsonEntry.getData().toString('utf8');
  } else if (logsTxtEntry) {
    logs = logsTxtEntry.getData().toString('utf8');
  }

  // Determine timestamps
  const startedAt = sessionMeta?.startedAt ? new Date(sessionMeta.startedAt) : new Date();
  const completedAt = sessionMeta?.completedAt ? new Date(sessionMeta.completedAt) : new Date();

  // Validate deviceId exists locally (FK constraint) — null out if device not found
  let deviceId: string | null = sessionMeta?.deviceId || null;
  if (deviceId) {
    const exists = db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).all();
    if (exists.length === 0) {
      deviceId = null;
    }
  }

  // Create the session
  const sessionResult = db.insert(automationSessions).values({
    automationId: null,
    deviceId,
    name: name || sessionMeta?.name || 'Imported Session',
    notes: sessionMeta?.notes || null,
    status: sessionMeta?.status || 'success',
    triggerType: sessionMeta?.triggerType || 'capture',
    logs,
    isPinned: false,
    startedAt,
    completedAt,
  }).run();

  const sessionId = Number(sessionResult.lastInsertRowid);

  // Import traffic from HAR
  let trafficCount = 0;
  let wsMessageCount = 0;
  if (harJson) {
    const result = importHarEntries(db, sessionId, harJson?.log?.entries || []);
    trafficCount = result.trafficCount;
    wsMessageCount = result.wsMessageCount;
  }

  // Import screenshots
  let screenshotCount = 0;
  await mkdir(screenshotPath, { recursive: true });

  for (const entry of zipEntries) {
    if (!entry.entryName.startsWith('screenshots/') || entry.isDirectory) continue;

    const filename = entry.entryName.replace('screenshots/', '');
    if (!filename) continue;

    // Write screenshot file to disk
    const filePath = join(screenshotPath, filename);
    await writeFile(filePath, entry.getData());

    // Insert screenshot record
    db.insert(screenshots).values({
      sessionId,
      filename,
      name: null,
      domSnapshot: null,
      capturedAt: new Date(),
    }).run();

    screenshotCount++;
  }

  return { sessionId, trafficCount, screenshotCount, wsMessageCount };
}
