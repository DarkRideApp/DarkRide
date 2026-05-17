import { eq, like, desc, sql } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import type { AppDatabase } from '../db/index';
import * as schema from '../db/schema';
import type { AiToolRegistry } from './ai-tools';
import type { PythonBridgeManager } from './python-bridge';
import type { DeviceManager } from './device-manager';
import type { AutomationRunner } from './automation-runner';
import type { TriggerType } from '../../shared/types/api';
import type { AutomationScheduler } from './automation-scheduler';
import type { AutomationCompiler } from './automation-compiler';
import type { CaptureSessionManager } from './capture-session-manager';
import type { PluginStateManager } from './plugin-state-manager';
import type { SystemStateService } from './system-state-service';
import { callFridaBridge } from './frida-bridge';
import { broadcastToAll } from '../websocket/index';
import { lookupVersionMeta, analysisDir as getAnalysisDir, analysisDbPath, resolveApkLocal, apkFilePath, getApkDir } from '../utils/apk-paths';
import { getNote, setNote, patchNoteSection } from './apk-notes';

/**
 * Services available to AI tool implementations. Tools that need to mutate
 * shared state or trigger long-running work receive their dependencies
 * through this bag instead of looping back through the host's HTTP routes
 * (which would strip the authenticated user and 401 — see 7958812).
 */
export interface AiToolServices {
  bridgeManager?: PythonBridgeManager;
  deviceManager?: DeviceManager;
  runner?: AutomationRunner;
  scheduler?: AutomationScheduler;
  compiler?: AutomationCompiler;
  captureManager?: CaptureSessionManager;
  pluginStateManager?: PluginStateManager;
  systemStateService?: SystemStateService;
}

/**
 * Escape a string for safe embedding inside a JS string literal within a
 * template literal.  Prevents:
 *   - backslash interpretation  (\\ → \\\\)
 *   - single-quote breakout      (' → \')
 *   - backtick breakout           (` → \`)
 *   - template interpolation      (${ → \${)
 */
function escapeForFridaString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/** Truncate a string to maxLen, appending '...' if truncated. */
function truncate(value: string | null | undefined, maxLen: number): string | null {
  if (value == null) return null;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...';
}

/** Mask a password string as '********'. */
function maskPassword(_password: string | null | undefined): string {
  return '********';
}

/** Mask credential fields in a proxy URL (replace user:pass@ with user:****@). */
function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Spawn a Frida session, wait, collect messages, then stop. Shared by the
 * three "run a script and report back" tools (run_frida_and_collect,
 * inspect_runtime_classes, inspect_class_methods). Talks to the Python
 * bridge directly — no HTTP loopback.
 */
async function spawnWaitCollectStop(
  bridgeManager: PythonBridgeManager,
  deviceManager: DeviceManager | undefined,
  deviceId: string,
  spawnParams: Record<string, any>,
  durationMs: number,
): Promise<{ messages: any[] }> {
  deviceManager?.markBusy?.(deviceId);
  try {
    await callFridaBridge(bridgeManager, deviceId, 'frida_run', spawnParams);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    const data = await callFridaBridge(bridgeManager, deviceId, 'frida_get_messages', {});
    const messages = Array.isArray(data) ? data : [];
    try { await callFridaBridge(bridgeManager, deviceId, 'frida_stop_server', {}); } catch { /* best-effort */ }
    return { messages };
  } finally {
    deviceManager?.markIdle?.(deviceId);
  }
}

/**
 * Register all page-specific AI tools into the provided registry.
 *
 * Services are optional only because legacy unit tests construct the
 * registry without them; individual tools throw a clear "not wired"
 * error at execute() time if their required service handle is missing
 * rather than silently failing.
 */
export function registerAllTools(
  registry: AiToolRegistry,
  db: AppDatabase,
  services: AiToolServices = {},
): void {
  const {
    bridgeManager,
    deviceManager,
    runner,
    scheduler,
    compiler,
    captureManager,
    pluginStateManager,
    systemStateService,
  } = services;
  // ── Session Timeline tools ──────────────────────────────────────

  registry.register({
    name: 'get_session_metadata',
    description: 'Get metadata for an automation session by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'number', description: 'The session ID' },
      },
      required: ['sessionId'],
    },
    context: ['session-timeline'],
    requiredScope: 'core.automations:read',
    async execute(params: { sessionId: number }) {
      const rows = db
        .select()
        .from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, params.sessionId))
        .all();
      if (rows.length === 0) return { error: 'Session not found' };
      return rows[0];
    },
  });

  registry.register({
    name: 'query_session_traffic',
    description:
      'Query captured HTTP traffic for a specific session. Supports filtering by URL pattern, method, and status code. Returns traffic entries with request/response bodies truncated to 2000 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'number', description: 'The session ID' },
        urlPattern: {
          type: 'string',
          description: 'URL pattern (LIKE match against the full request URL, e.g. %example.com% or %/api/v1%)',
        },
        method: { type: 'string', description: 'HTTP method filter (e.g. GET, POST)' },
        statusCode: { type: 'number', description: 'Response status code filter' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
      required: ['sessionId'],
    },
    context: ['session-timeline'],
    requiredScope: 'core.traffic:read',
    async execute(params: {
      sessionId: number;
      urlPattern?: string;
      method?: string;
      statusCode?: number;
      limit?: number;
    }) {
      const limit = params.limit ?? 15;
      const { and } = await import('drizzle-orm');
      const conditions = [eq(schema.capturedTraffic.sessionId, params.sessionId)];
      if (params.urlPattern) {
        conditions.push(like(schema.capturedTraffic.requestUrl, params.urlPattern));
      }
      if (params.method) {
        conditions.push(eq(schema.capturedTraffic.requestMethod, params.method));
      }
      if (params.statusCode != null) {
        conditions.push(eq(schema.capturedTraffic.responseStatus, params.statusCode));
      }
      const rows = db
        .select()
        .from(schema.capturedTraffic)
        .where(and(...conditions))
        .orderBy(desc(schema.capturedTraffic.id))
        .limit(limit)
        .all();
      return rows.map((r) => ({
        ...r,
        requestBody: truncate(r.requestBody, 2000),
        responseBody: truncate(r.responseBody, 2000),
      }));
    },
  });

  registry.register({
    name: 'list_session_screenshots',
    description:
      'List screenshots for a session (no image blobs). Returns id, filename, name, and capturedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'number', description: 'The session ID' },
      },
      required: ['sessionId'],
    },
    context: ['session-timeline'],
    requiredScope: 'core.automations:read',
    async execute(params: { sessionId: number }) {
      return db
        .select({
          id: schema.screenshots.id,
          filename: schema.screenshots.filename,
          name: schema.screenshots.name,
          capturedAt: schema.screenshots.capturedAt,
        })
        .from(schema.screenshots)
        .where(eq(schema.screenshots.sessionId, params.sessionId))
        .all();
    },
  });

  registry.register({
    name: 'get_execution_log',
    description: "Get a session's execution log, parsed as JSON.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'number', description: 'The session ID' },
      },
      required: ['sessionId'],
    },
    context: ['session-timeline'],
    requiredScope: 'core.automations:read',
    async execute(params: { sessionId: number }) {
      const rows = db
        .select({ logs: schema.automationSessions.logs })
        .from(schema.automationSessions)
        .where(eq(schema.automationSessions.id, params.sessionId))
        .all();
      if (rows.length === 0) return { error: 'Session not found' };
      const raw = rows[0].logs;
      if (!raw) return [];
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  });

  // ── Traffic tools ───────────────────────────────────────────────

  registry.register({
    name: 'search_traffic',
    description:
      'Search captured HTTP traffic with optional filters. Supports filtering by session ID, hostname, path, method, and status code. Returns summary fields only (no full bodies).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'number',
          description: 'Filter to a specific capture session ID',
        },
        hostname: {
          type: 'string',
          description: 'Filter by hostname using SQL LIKE pattern (e.g. %example.com%)',
        },
        path: {
          type: 'string',
          description: 'Filter by URL path using SQL LIKE pattern (e.g. %/api/v1%)',
        },
        urlPattern: {
          type: 'string',
          description: 'SQL LIKE pattern for full request URL (e.g. %api%)',
        },
        method: { type: 'string', description: 'HTTP method filter (e.g. GET, POST)' },
        statusCode: { type: 'number', description: 'Response status code filter' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    context: ['traffic', 'session-timeline'],
    requiredScope: 'core.traffic:read',
    async execute(params: {
      sessionId?: number;
      hostname?: string;
      path?: string;
      urlPattern?: string;
      method?: string;
      statusCode?: number;
      limit?: number;
    }) {
      const limit = params.limit ?? 20;
      const { and } = await import('drizzle-orm');
      const conditions = [];
      if (params.sessionId != null) {
        conditions.push(eq(schema.capturedTraffic.sessionId, params.sessionId));
      }
      if (params.hostname) {
        conditions.push(like(schema.capturedTraffic.requestUrl, params.hostname));
      }
      if (params.path) {
        conditions.push(like(schema.capturedTraffic.requestUrl, params.path));
      }
      if (params.urlPattern) {
        conditions.push(like(schema.capturedTraffic.requestUrl, params.urlPattern));
      }
      if (params.method) {
        conditions.push(eq(schema.capturedTraffic.requestMethod, params.method));
      }
      if (params.statusCode != null) {
        conditions.push(eq(schema.capturedTraffic.responseStatus, params.statusCode));
      }

      let query = db
        .select({
          id: schema.capturedTraffic.id,
          sessionId: schema.capturedTraffic.sessionId,
          deviceId: schema.capturedTraffic.deviceId,
          requestMethod: schema.capturedTraffic.requestMethod,
          requestUrl: schema.capturedTraffic.requestUrl,
          responseStatus: schema.capturedTraffic.responseStatus,
          capturedAt: schema.capturedTraffic.capturedAt,
        })
        .from(schema.capturedTraffic)
        .orderBy(desc(schema.capturedTraffic.id))
        .limit(limit);

      if (conditions.length === 1) {
        query = query.where(conditions[0]) as typeof query;
      } else if (conditions.length > 1) {
        query = query.where(and(...conditions)) as typeof query;
      }

      return query.all();
    },
  });

  registry.register({
    name: 'get_request_detail',
    description:
      'Get full details of a captured traffic entry by ID, with bodies truncated to 2500 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The traffic entry ID' },
      },
      required: ['id'],
    },
    context: ['traffic', 'session-timeline'],
    requiredScope: 'core.traffic:read',
    async execute(params: { id: number }) {
      const rows = db
        .select()
        .from(schema.capturedTraffic)
        .where(eq(schema.capturedTraffic.id, params.id))
        .all();
      if (rows.length === 0) return { error: 'Traffic entry not found' };
      const r = rows[0];
      return {
        ...r,
        requestBody: truncate(r.requestBody, 2500),
        responseBody: truncate(r.responseBody, 2500),
      };
    },
  });

  // ── Automations tools ───────────────────────────────────────────

  registry.register({
    name: 'list_automations',
    description: 'List all automations with summary fields.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['automations', 'dashboard'],
    requiredScope: 'core.automations:read',
    async execute() {
      return db
        .select({
          id: schema.automations.id,
          name: schema.automations.name,
          enabled: schema.automations.enabled,
          isRule: schema.automations.isRule,
          schedule: schema.automations.schedule,
          createdAt: schema.automations.createdAt,
        })
        .from(schema.automations)
        .all();
    },
  });

  registry.register({
    name: 'get_automation_code',
    description: 'Get the source code for an automation by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The automation ID' },
      },
      required: ['id'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:read',
    async execute(params: { id: number }) {
      const rows = db
        .select({ id: schema.automations.id, name: schema.automations.name, code: schema.automations.code })
        .from(schema.automations)
        .where(eq(schema.automations.id, params.id))
        .all();
      if (rows.length === 0) return { error: 'Automation not found' };
      return rows[0];
    },
  });

  // ── Automation authoring tools ──────────────────────────────────

  registry.register({
    name: 'create_automation',
    description: 'Create a new automation. Pass TypeScript code that calls into the automation API (e.g. `await device.tap(...)`). Returns the created automation with its assigned `id`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the automation' },
        code: { type: 'string', description: 'TypeScript source code' },
        timeoutMs: { type: 'number', description: 'Hard timeout in ms (default 300000)' },
        requiresDevice: { type: 'boolean', description: 'Whether the automation needs a device attached (default true)' },
        requiresHttpsCapture: { type: 'boolean', description: 'Whether to start HTTPS capture before running (default false)' },
        isRule: { type: 'boolean', description: 'Treat as a traffic rule rather than a one-off automation (default false)' },
        isCaptureRule: { type: 'boolean', description: 'Treat as a capture-session rule (default false). Mutually exclusive with isRule.' },
        priority: { type: 'number', description: 'Rule priority (lower = higher priority, default 0)' },
        enabled: { type: 'boolean', description: 'Whether the automation is enabled (default true)' },
      },
      required: ['name', 'code'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:edit',
    requiresConfirmation: true,
    async execute(params: {
      name: string;
      code: string;
      timeoutMs?: number;
      requiresDevice?: boolean;
      requiresHttpsCapture?: boolean;
      isRule?: boolean;
      isCaptureRule?: boolean;
      priority?: number;
      enabled?: boolean;
    }) {
      if (params.isRule && params.isCaptureRule) {
        throw new Error('isRule and isCaptureRule are mutually exclusive');
      }
      const passcode = (await import('crypto')).randomUUID();
      const now = new Date();
      db.insert(schema.automations).values({
        name: params.name,
        code: params.code,
        passcode,
        timeoutMs: params.timeoutMs ?? 300000,
        requiresDevice: params.requiresDevice ?? true,
        requiresHttpsCapture: params.requiresHttpsCapture ?? false,
        isRule: params.isRule ?? false,
        isCaptureRule: params.isCaptureRule ?? false,
        priority: params.priority ?? 0,
        enabled: params.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      }).run();
      const created = db
        .select({ id: schema.automations.id, name: schema.automations.name, code: schema.automations.code, enabled: schema.automations.enabled })
        .from(schema.automations)
        .orderBy(desc(schema.automations.id))
        .limit(1)
        .all()[0];
      return created;
    },
  });

  registry.register({
    name: 'update_automation_code',
    description: "Replace an automation's source code. Other fields (name, schedule, flags) are left untouched. For find-and-replace edits within a script, prefer `patch_automation_code` to avoid sending the whole body.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The automation ID' },
        code: { type: 'string', description: 'New TypeScript source code (replaces the whole field)' },
      },
      required: ['id', 'code'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:edit',
    requiresConfirmation: true,
    async execute(params: { id: number; code: string }) {
      const existing = db.select().from(schema.automations).where(eq(schema.automations.id, params.id)).all()[0];
      if (!existing) return { error: 'Automation not found' };
      db.update(schema.automations)
        .set({ code: params.code, updatedAt: new Date() })
        .where(eq(schema.automations.id, params.id))
        .run();
      return { id: params.id, codeLength: params.code.length };
    },
  });

  registry.register({
    name: 'patch_automation_code',
    description: 'Find-and-replace within an automation\'s source code. `oldText` must match exactly once. Use this for surgical edits — replacing a single line or block — to keep token usage down.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The automation ID' },
        oldText: { type: 'string', description: 'Exact substring to find. Must occur exactly once in the current code.' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['id', 'oldText', 'newText'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:edit',
    requiresConfirmation: true,
    async execute(params: { id: number; oldText: string; newText: string }) {
      const existing = db.select().from(schema.automations).where(eq(schema.automations.id, params.id)).all()[0];
      if (!existing) return { error: 'Automation not found' };
      const code = existing.code;
      const idx = code.indexOf(params.oldText);
      if (idx === -1) {
        return { error: 'oldText not found in automation code' };
      }
      if (code.indexOf(params.oldText, idx + 1) !== -1) {
        return { error: 'oldText matches multiple locations — provide more surrounding context to disambiguate' };
      }
      const patched = code.slice(0, idx) + params.newText + code.slice(idx + params.oldText.length);
      db.update(schema.automations)
        .set({ code: patched, updatedAt: new Date() })
        .where(eq(schema.automations.id, params.id))
        .run();
      return { id: params.id, replacedAt: idx, newLength: patched.length };
    },
  });

  registry.register({
    name: 'validate_automation',
    description: 'Type-check TypeScript automation code without persisting it. Returns diagnostics (errors and warnings from the TypeScript compiler) or an empty list if the code is valid.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'TypeScript source code to validate' },
      },
      required: ['code'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:read',
    async execute(params: { code: string }) {
      if (!compiler) throw new Error('AutomationCompiler not wired into AI tools');
      // Use a synthetic cache key — compileWithCache caches by id, so a
      // distinct key per validation call means we never poison the cache
      // a real automation depends on.
      const result = compiler.compileWithCache(params.code, '__validate__');
      return {
        valid: result.diagnostics.length === 0,
        diagnostics: result.diagnostics,
      };
    },
  });

  registry.register({
    name: 'update_automation_config',
    description: 'Update automation metadata — name, flags (enabled / requiresDevice / requiresHttpsCapture / isRule / isCaptureRule), priority, timeout, device filter, or schedule. Pass only the fields you want to change. Does NOT touch the source code; use update_automation_code / patch_automation_code for that.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The automation ID' },
        name: { type: 'string', description: 'Display name' },
        enabled: { type: 'boolean', description: 'Enable/disable. Disabled automations are skipped by the scheduler.' },
        timeoutMs: { type: 'number', description: 'Hard execution timeout in ms' },
        requiresDevice: { type: 'boolean', description: 'Whether the automation needs a device attached' },
        requiresHttpsCapture: { type: 'boolean', description: 'Whether to start HTTPS capture before running' },
        isRule: { type: 'boolean', description: 'Treat as a traffic rule rather than a one-off automation' },
        isCaptureRule: { type: 'boolean', description: 'Treat as a capture-session rule. Mutually exclusive with isRule.' },
        priority: { type: 'number', description: 'Rule priority (lower runs first)' },
        deviceFilter: { type: 'object', description: 'Optional device filter object — see Automations docs for shape. Pass null to clear.' },
        schedule: {
          type: 'object',
          description: "Schedule config. Shape: { type: 'cron', expressions: ['0 9 * * *'] } or { type: 'interval', intervalMs: 60000 } or { type: 'windowed_interval', ... }. Pass null to remove the schedule.",
        },
      },
      required: ['id'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:edit',
    requiresConfirmation: true,
    async execute(params: any) {
      const existing = db.select().from(schema.automations).where(eq(schema.automations.id, params.id)).all()[0];
      if (!existing) return { error: 'Automation not found' };

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (params.name !== undefined) updates.name = params.name;
      if (params.enabled !== undefined) updates.enabled = params.enabled;
      if (params.timeoutMs !== undefined) updates.timeoutMs = params.timeoutMs;
      if (params.requiresDevice !== undefined) updates.requiresDevice = params.requiresDevice;
      if (params.requiresHttpsCapture !== undefined) updates.requiresHttpsCapture = params.requiresHttpsCapture;
      if (params.isRule !== undefined) updates.isRule = params.isRule;
      if (params.isCaptureRule !== undefined) updates.isCaptureRule = params.isCaptureRule;
      if (params.priority !== undefined) updates.priority = params.priority;
      if (params.deviceFilter !== undefined) {
        updates.deviceFilter = params.deviceFilter ? JSON.stringify(params.deviceFilter) : null;
      }

      const finalIsRule = updates.isRule ?? existing.isRule;
      const finalIsCaptureRule = updates.isCaptureRule ?? existing.isCaptureRule;
      if (finalIsRule && finalIsCaptureRule) {
        return { error: 'isRule and isCaptureRule are mutually exclusive' };
      }

      db.update(schema.automations).set(updates).where(eq(schema.automations.id, params.id)).run();

      // Schedule changes go through the scheduler. null clears, anything
      // else gets installed. Invalid schedule config is reported back
      // rather than silently dropped.
      let scheduleResult: 'unchanged' | 'cleared' | 'installed' | 'invalid' = 'unchanged';
      if (params.schedule !== undefined) {
        if (!scheduler) {
          return { error: 'AutomationScheduler not wired into AI tools' };
        }
        if (params.schedule === null) {
          scheduler.removeSchedule(params.id);
          scheduleResult = 'cleared';
        } else {
          // Minimal inline validation — mirrors validateScheduleConfig in
          // api/automations.ts. Kept here so the tool doesn't depend on
          // an internal API helper.
          const s = params.schedule;
          let valid = false;
          if (s && typeof s === 'object') {
            if (s.type === 'cron' && Array.isArray(s.expressions) && s.expressions.length > 0) {
              valid = s.expressions.every((e: any) => typeof e === 'string' && e.trim().split(/\s+/).length === 5);
            } else if (s.type === 'interval' && typeof s.intervalMs === 'number' && s.intervalMs > 0) {
              valid = true;
            } else if (s.type === 'windowed_interval') {
              valid = true; // deeper validation lives in the route; accept here
            }
          }
          if (!valid) {
            scheduleResult = 'invalid';
          } else {
            scheduler.setSchedule(params.id, params.schedule);
            scheduleResult = 'installed';
          }
        }
      }

      const after = db
        .select({
          id: schema.automations.id,
          name: schema.automations.name,
          enabled: schema.automations.enabled,
          requiresDevice: schema.automations.requiresDevice,
          isRule: schema.automations.isRule,
          isCaptureRule: schema.automations.isCaptureRule,
          priority: schema.automations.priority,
          timeoutMs: schema.automations.timeoutMs,
        })
        .from(schema.automations)
        .where(eq(schema.automations.id, params.id))
        .all()[0];

      return { ...after, scheduleResult };
    },
  });

  registry.register({
    name: 'run_automation',
    description: 'Trigger immediate execution of an automation by ID. If the automation requires a device and no `deviceId` is given, the run is queued for the next idle matching device.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The automation ID' },
        deviceId: { type: 'string', description: 'Optional device ID. Omit for deviceless automations or to queue.' },
      },
      required: ['id'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:execute',
    requiresConfirmation: true,
    allowUnattended: false,
    async execute(params: { id: number; deviceId?: string }) {
      if (!runner || !scheduler) throw new Error('AutomationRunner/Scheduler not wired into AI tools');
      const automation = db.select().from(schema.automations).where(eq(schema.automations.id, params.id)).all()[0];
      if (!automation) return { error: 'Automation not found' };
      const triggerType: TriggerType = 'manual';
      if (!params.deviceId) {
        if (!automation.requiresDevice) {
          const result = await runner.runAutomation(params.id, undefined, triggerType);
          return result;
        }
        const queued = scheduler.enqueue(params.id, triggerType);
        return { queued };
      }
      const result = await runner.runAutomation(params.id, params.deviceId, triggerType);
      return result;
    },
  });

  registry.register({
    name: 'cancel_automation_run',
    description: 'Abort an in-flight automation run by its sessionId. The V8 isolate executing the script is killed and the session row is updated to status="cancelled". Returns 404 if no active run matches the sessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'number', description: 'The session ID of the running automation' },
      },
      required: ['sessionId'],
    },
    context: ['automations'],
    requiredScope: 'core.automations:execute',
    requiresConfirmation: true,
    async execute(params: { sessionId: number }) {
      if (!runner) throw new Error('AutomationRunner not wired into AI tools');
      const cancelled = runner.cancelRun(params.sessionId);
      if (!cancelled) return { error: 'No active run for that session' };
      return { sessionId: params.sessionId, cancelled: true };
    },
  });

  registry.register({
    name: 'list_active_automation_runs',
    description: 'List the sessionIds of all automations currently running on this host. Useful for finding what to cancel.',
    inputSchema: { type: 'object', properties: {} },
    context: ['automations'],
    requiredScope: 'core.automations:read',
    async execute() {
      if (!runner) throw new Error('AutomationRunner not wired into AI tools');
      return { sessionIds: runner.getActiveRunSessionIds() };
    },
  });

  registry.register({
    name: 'list_sessions',
    description: 'List recent automation sessions with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        automationId: { type: 'number', description: 'Filter by automation ID' },
        status: {
          type: 'string',
          description: 'Filter by status (running, success, failed, cancelled)',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    context: ['automations', 'dashboard'],
    requiredScope: 'core.automations:read',
    async execute(params: { automationId?: number; status?: string; limit?: number }) {
      const limit = params.limit ?? 20;
      const conditions = [];
      if (params.automationId != null) {
        conditions.push(eq(schema.automationSessions.automationId, params.automationId));
      }
      if (params.status) {
        conditions.push(
          eq(
            schema.automationSessions.status,
            params.status as 'running' | 'success' | 'failed' | 'cancelled',
          ),
        );
      }

      let query = db
        .select()
        .from(schema.automationSessions)
        .orderBy(desc(schema.automationSessions.id))
        .limit(limit);

      if (conditions.length === 1) {
        query = query.where(conditions[0]) as typeof query;
      } else if (conditions.length > 1) {
        const { and } = await import('drizzle-orm');
        query = query.where(and(...conditions)) as typeof query;
      }

      return query.all();
    },
  });

  // ── Credentials tools ──────────────────────────────────────────

  registry.register({
    name: 'search_credentials',
    description:
      'Search credentials by app ID or username substring. Passwords are always masked.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to match against app ID or username (SQL LIKE pattern)',
        },
      },
      required: ['query'],
    },
    context: ['credentials'],
    requiredScope: 'core.credentials:read',
    async execute(params: { query: string }) {
      const { or } = await import('drizzle-orm');
      const pattern = `%${params.query}%`;
      const rows = db
        .select()
        .from(schema.credentials)
        .where(
          or(
            like(schema.credentials.appId, pattern),
            like(schema.credentials.username, pattern),
          ),
        )
        .all();
      return rows.map((r) => ({
        ...r,
        password: maskPassword(r.password),
      }));
    },
  });

  registry.register({
    name: 'list_credentials',
    description: 'List all stored credentials. Passwords are always masked.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['credentials'],
    requiredScope: 'core.credentials:read',
    async execute() {
      const rows = db.select().from(schema.credentials).all();
      return rows.map((r) => ({
        ...r,
        password: maskPassword(r.password),
      }));
    },
  });

  // ── Intercept rules tools ──────────────────────────────────────

  registry.register({
    name: 'list_intercept_rules',
    description: 'List all traffic intercept rules ordered by priority. Each rule pairs a host/path/method match with a phase (request/response) and a list of actions (modify body, inject header, etc.). The `actions` field is JSON-encoded.',
    inputSchema: { type: 'object', properties: {} },
    context: ['traffic'],
    requiredScope: 'core.traffic:read',
    async execute() {
      return db.select().from(schema.interceptRules).orderBy(schema.interceptRules.priority).all();
    },
  });

  registry.register({
    name: 'create_intercept_rule',
    description: 'Create a new traffic intercept rule. `matchHostname` is required; other matchers are AND-combined when present. `actions` is the action list (pass as an array — it will be JSON-encoded).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        matchHostname: { type: 'string', description: 'Hostname pattern to match (required)' },
        matchPath: { type: 'string', description: 'Path pattern (optional)' },
        matchMethod: { type: 'string', description: 'HTTP method filter (optional)' },
        matchStatusCode: { type: 'number', description: 'Status code filter, only meaningful in response phase' },
        matchHeader: { type: 'string', description: 'Header name to require (optional)' },
        matchBody: { type: 'string', description: 'Body substring to match (optional)' },
        phase: { type: 'string', enum: ['request', 'response'], description: "When the rule fires" },
        actions: { type: 'array', description: 'Action list — each item describes a mutation to perform' },
        deviceFilter: { type: 'string', description: 'Only fire for matching device ID (optional)' },
        priority: { type: 'number', description: 'Lower runs first (default 0)' },
        enabled: { type: 'boolean', description: 'Whether enabled (default true)' },
      },
      required: ['name', 'matchHostname', 'phase'],
    },
    context: ['traffic'],
    requiredScope: 'core.traffic:manage',
    requiresConfirmation: true,
    async execute(params: any) {
      const { syncInterceptConfig } = await import('./intercept-config-writer');
      const now = new Date();
      const actionsStr = Array.isArray(params.actions) ? JSON.stringify(params.actions) : '[]';
      const result = db.insert(schema.interceptRules).values({
        name: String(params.name).trim(),
        matchHostname: String(params.matchHostname).trim(),
        matchPath: params.matchPath ?? null,
        matchMethod: params.matchMethod ?? null,
        matchStatusCode: params.matchStatusCode ?? null,
        matchHeader: params.matchHeader ?? null,
        matchBody: params.matchBody ?? null,
        phase: params.phase,
        actions: actionsStr,
        deviceFilter: params.deviceFilter ?? null,
        priority: params.priority ?? 0,
        enabled: params.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      }).run();
      const insertedId = Number(result.lastInsertRowid);
      syncInterceptConfig(db);
      broadcastToAll({ type: 'intercept-rules-changed' });
      return db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, insertedId)).all()[0];
    },
  });

  registry.register({
    name: 'update_intercept_rule',
    description: 'Update an existing intercept rule. Pass only the fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Rule ID' },
        name: { type: 'string' },
        matchHostname: { type: 'string' },
        matchPath: { type: 'string' },
        matchMethod: { type: 'string' },
        matchStatusCode: { type: 'number' },
        matchHeader: { type: 'string' },
        matchBody: { type: 'string' },
        phase: { type: 'string', enum: ['request', 'response'] },
        actions: { type: 'array' },
        deviceFilter: { type: 'string' },
        priority: { type: 'number' },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
    context: ['traffic'],
    requiredScope: 'core.traffic:manage',
    requiresConfirmation: true,
    async execute(params: any) {
      const existing = db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, params.id)).all()[0];
      if (!existing) return { error: 'Rule not found' };
      const { syncInterceptConfig } = await import('./intercept-config-writer');
      const updateSet: Record<string, any> = { updatedAt: new Date() };
      if (params.name !== undefined) updateSet.name = String(params.name).trim();
      if (params.matchHostname !== undefined) updateSet.matchHostname = String(params.matchHostname).trim();
      if (params.matchPath !== undefined) updateSet.matchPath = params.matchPath ?? null;
      if (params.matchMethod !== undefined) updateSet.matchMethod = params.matchMethod ?? null;
      if (params.matchStatusCode !== undefined) updateSet.matchStatusCode = params.matchStatusCode ?? null;
      if (params.matchHeader !== undefined) updateSet.matchHeader = params.matchHeader ?? null;
      if (params.matchBody !== undefined) updateSet.matchBody = params.matchBody ?? null;
      if (params.phase !== undefined) updateSet.phase = params.phase;
      if (params.deviceFilter !== undefined) updateSet.deviceFilter = params.deviceFilter ?? null;
      if (params.priority !== undefined) updateSet.priority = params.priority;
      if (params.enabled !== undefined) updateSet.enabled = params.enabled;
      if (params.actions !== undefined) {
        updateSet.actions = Array.isArray(params.actions) ? JSON.stringify(params.actions) : '[]';
      }
      db.update(schema.interceptRules).set(updateSet).where(eq(schema.interceptRules.id, params.id)).run();
      syncInterceptConfig(db);
      broadcastToAll({ type: 'intercept-rules-changed' });
      return db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, params.id)).all()[0];
    },
  });

  registry.register({
    name: 'toggle_intercept_rule',
    description: 'Flip an intercept rule between enabled and disabled.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Rule ID' } },
      required: ['id'],
    },
    context: ['traffic'],
    requiredScope: 'core.traffic:manage',
    async execute(params: { id: number }) {
      const existing = db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, params.id)).all()[0];
      if (!existing) return { error: 'Rule not found' };
      const { syncInterceptConfig } = await import('./intercept-config-writer');
      db.update(schema.interceptRules)
        .set({ enabled: !existing.enabled, updatedAt: new Date() })
        .where(eq(schema.interceptRules.id, params.id))
        .run();
      syncInterceptConfig(db);
      broadcastToAll({ type: 'intercept-rules-changed' });
      return db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, params.id)).all()[0];
    },
  });

  registry.register({
    name: 'delete_intercept_rule',
    description: 'Delete an intercept rule permanently.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Rule ID' } },
      required: ['id'],
    },
    context: ['traffic'],
    requiredScope: 'core.traffic:manage',
    requiresConfirmation: true,
    async execute(params: { id: number }) {
      const existing = db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, params.id)).all()[0];
      if (!existing) return { error: 'Rule not found' };
      const { syncInterceptConfig } = await import('./intercept-config-writer');
      db.delete(schema.interceptRules).where(eq(schema.interceptRules.id, params.id)).run();
      syncInterceptConfig(db);
      broadcastToAll({ type: 'intercept-rules-changed' });
      return { id: params.id, deleted: true };
    },
  });

  // ── Proxies tools ──────────────────────────────────────────────

  registry.register({
    name: 'list_proxies',
    description: 'List all proxies with credentials masked.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['proxies'],
    requiredScope: 'core.proxies:read',
    async execute() {
      const rows = db.select().from(schema.proxies).all();
      return rows.map((r) => ({
        id: r.id,
        url: maskProxyUrl(r.url),
        username: r.username,
        password: r.password ? maskPassword(r.password) : null,
        failureCount: r.failureCount,
        enabled: r.enabled,
        createdAt: r.createdAt,
      }));
    },
  });

  // ── APK Analysis tools ─────────────────────────────────────────

  /**
   * Replace or append a single ## section in a markdown notes document.
   * Sections are delimited by ## or # headings.
   */
  function patchNotesSection(notes: string, section: string, content: string): string {
    const heading = `## ${section}`;
    const trimmedContent = content.trim();

    if (!notes.trim()) {
      return `${heading}\n\n${trimmedContent}\n`;
    }

    const lines = notes.split('\n');
    const start = lines.findIndex(l => l.trimEnd() === heading);

    if (start === -1) {
      // Section not found — append it
      return `${notes.trimEnd()}\n\n${heading}\n\n${trimmedContent}\n`;
    }

    // Find end of section: next H1 or H2 heading
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,2} /.test(lines[i])) {
        end = i;
        break;
      }
    }

    const before = lines.slice(0, start);
    const after = lines.slice(end);
    const sectionLines = [heading, '', trimmedContent];
    // Ensure a blank line before the next section if one exists
    const needsBlank = after.length > 0 && after[0] !== '';
    const combined = [...before, ...sectionLines, ...(needsBlank ? [''] : []), ...after];
    return combined.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function resolveAnalysisDir(versionId: number): string | null {
    const meta = lookupVersionMeta(db, versionId);
    if (!meta) return null;
    return getAnalysisDir(meta.packageName, meta.versionCode);
  }

  function openAnalysisDb(versionId: number): Database.Database | null {
    const meta = lookupVersionMeta(db, versionId);
    if (!meta) return null;
    const dbPath = analysisDbPath(meta.packageName, meta.versionCode);
    if (!fs.existsSync(dbPath)) return null;
    try { return new Database(dbPath, { readonly: true }); } catch { return null; }
  }

  function resolveApkPath(versionId: number): string | null {
    const meta = lookupVersionMeta(db, versionId);
    if (!meta) return null;
    const local = resolveApkLocal(meta.packageName, meta.filename);
    if (!local) return null;
    return local.baseApkPath;
  }

  function decompressContent(buf: Buffer): Buffer {
    if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xB5 && buf[2] === 0x2F && buf[3] === 0xFD) {
      return zlib.zstdDecompressSync(buf);
    }
    return zlib.inflateSync(buf);
  }

  registry.register({
    name: 'get_apk_overview',
    description:
      'Get an overview of an analyzed APK version: manifest, finding counts by severity/category, file stats. The versionId is provided in the system prompt as Context ID.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const manifest: Record<string, any> = {};
        for (const row of analysisDb.prepare('SELECT key, value FROM manifest').all() as any[]) {
          try { manifest[row.key] = JSON.parse(row.value); } catch { manifest[row.key] = row.value; }
        }
        const findingCounts = analysisDb.prepare('SELECT severity, COUNT(*) as count FROM findings GROUP BY severity').all() as any[];
        const findingsByCategory = analysisDb.prepare('SELECT category, COUNT(*) as count FROM findings GROUP BY category').all() as any[];
        const fileStats = analysisDb.prepare('SELECT COUNT(*) as fileCount, COALESCE(SUM(size), 0) as totalSize FROM files').get() as any;
        return { manifest, findingCounts: Object.fromEntries(findingCounts.map((r: any) => [r.severity, r.count])), findingsByCategory: Object.fromEntries(findingsByCategory.map((r: any) => [r.category, r.count])), fileCount: fileStats.fileCount, totalSize: fileStats.totalSize };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'get_apk_findings_summary',
    description:
      'Get a lightweight summary of all security findings in an analyzed APK — counts grouped by severity and by category. Use this first to understand what findings exist before drilling into individual ones with search_apk_findings.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const bySeverity = analysisDb.prepare('SELECT severity, COUNT(*) as count FROM findings GROUP BY severity ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 ELSE 4 END').all() as any[];
        const byCategory = analysisDb.prepare('SELECT category, COUNT(*) as count FROM findings GROUP BY category ORDER BY count DESC').all() as any[];
        const total = analysisDb.prepare('SELECT COUNT(*) as count FROM findings').get() as any;
        // Top 5 critical/high findings titles (compact view)
        const topFindings = analysisDb.prepare(`SELECT severity, title, category FROM findings WHERE severity IN ('critical', 'high') ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END LIMIT 10`).all() as any[];
        return {
          total: total?.count ?? 0,
          bySeverity: Object.fromEntries(bySeverity.map((r: any) => [r.severity, r.count])),
          byCategory: Object.fromEntries(byCategory.map((r: any) => [r.category, r.count])),
          topFindings: topFindings.map((r: any) => ({ severity: r.severity, title: r.title, category: r.category })),
        };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'search_apk_findings',
    description:
      'Search security findings in an analyzed APK. Filter by severity (critical/high/medium/low/info) and/or category. Use offset for pagination. Prefer small limits (10-20) and paginate if needed. Use get_apk_findings_summary first for a quick overview.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        severity: { type: 'string', description: 'Filter by severity: critical, high, medium, low, info' },
        category: { type: 'string', description: 'Filter by category (e.g. network, secret, certificate, url)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Number of results to skip (default 0)' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; severity?: string; category?: string; limit?: number; offset?: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const conditions: string[] = [];
        const sqlParams: any[] = [];
        if (params.severity) { conditions.push('f.severity = ?'); sqlParams.push(params.severity); }
        if (params.category) { conditions.push('f.category = ?'); sqlParams.push(params.category); }
        const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        const limit = params.limit ?? 20;
        const offset = params.offset ?? 0;
        // Get total count
        const countRow = analysisDb.prepare(`SELECT COUNT(*) as cnt FROM findings f LEFT JOIN files fi ON f.file_id = fi.id ${where}`).get(...sqlParams) as any;
        const total = countRow?.cnt ?? 0;
        const rows = analysisDb.prepare(`
          SELECT f.id, f.rule_id, f.severity, f.title, f.description, f.line_number, f.matched_text, f.category, fi.path as file_path, fi.source as file_source
          FROM findings f LEFT JOIN files fi ON f.file_id = fi.id ${where}
          ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.id
          LIMIT ? OFFSET ?
        `).all(...sqlParams, limit, offset) as any[];
        let mapped = rows.map((r: any) => ({ id: r.id, ruleId: r.rule_id, severity: r.severity, title: r.title, description: r.description, lineNumber: r.line_number, matchedText: truncate(r.matched_text, 200), category: r.category, filePath: r.file_path ?? '', fileSource: r.file_source ?? '' }));
        // Load excluded paths from settings and filter out library paths
        const excludedRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'analysis_excluded_paths')).all()[0];
        let excludedPaths: string[] = [];
        if (excludedRow?.value) {
          try { excludedPaths = JSON.parse(excludedRow.value); } catch {}
        }
        if (excludedPaths.length > 0) {
          mapped = mapped.filter((r) => {
            const slashPath = '/' + (r.filePath || '');
            return !excludedPaths.some((p) => slashPath.includes('/' + p.replace(/\./g, '/') + '/'));
          });
        }
        return { results: mapped, total, offset, limited: offset + limit < total };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'search_apk_code',
    description:
      'Full-text search across decompiled APK source files. Returns matching lines with file path and context. IMPORTANT: Use excludePaths to skip library code (androidx, com/google, kotlin, okhttp3, retrofit2, io/reactivex) and includePaths to focus on app-specific packages.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        query: { type: 'string', description: 'Search term (plain text or regex)' },
        useRegex: { type: 'boolean', description: 'Treat query as regex (default false)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        includePaths: { type: 'array', items: { type: 'string' }, description: 'Only search files whose path contains at least one of these substrings (e.g. ["com/disney", "fr/disneylandparis"])' },
        excludePaths: { type: 'array', items: { type: 'string' }, description: 'Skip files whose path contains any of these substrings (e.g. ["androidx", "com/google", "kotlin", "okhttp3"])' },
      },
      required: ['versionId', 'query'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; query: string; useRegex?: boolean; limit?: number; includePaths?: string[]; excludePaths?: string[] }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const files = analysisDb.prepare('SELECT path, source, content FROM files').all() as any[];
        const maxResults = params.limit ?? 10;
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let regex: RegExp;
        try { regex = new RegExp(params.useRegex ? params.query : escapeRegex(params.query), 'ig'); } catch { regex = new RegExp(escapeRegex(params.query), 'ig'); }
        const results: any[] = [];
        for (const file of files) {
          if (results.length >= maxResults) break;
          // Path filters — check BEFORE decompression
          if (params.includePaths && params.includePaths.length > 0) {
            if (!params.includePaths.some(p => file.path.includes(p))) continue;
          }
          if (params.excludePaths && params.excludePaths.length > 0) {
            if (params.excludePaths.some(p => file.path.includes(p))) continue;
          }
          let text: string;
          try { text = decompressContent(file.content).toString('utf-8'); } catch { continue; }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push({ file: file.path, source: file.source, line: i + 1, content: lines[i].slice(0, 300) });
            }
          }
        }
        return { results, total: results.length, limited: results.length >= maxResults };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'get_apk_file',
    description:
      'Read a specific decompiled source file from an analyzed APK. Prefer startLine/maxLines for paginated reading to avoid truncation. Without them, content is truncated to 2800 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        filePath: { type: 'string', description: 'Path to the file (from search results or findings)' },
        source: { type: 'string', description: 'Source type (e.g. jadx, apktool). If unknown, omit and first match is returned.' },
        startLine: { type: 'number', description: '1-indexed line to start from (enables paginated mode)' },
        maxLines: { type: 'number', description: 'Max lines to return when using paginated mode' },
      },
      required: ['versionId', 'filePath'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; filePath: string; source?: string; startLine?: number; maxLines?: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const fwd = params.filePath.replaceAll('\\', '/');
        const bwd = params.filePath.replaceAll('/', '\\');
        let row: any;
        if (params.source) {
          row = analysisDb.prepare('SELECT content, language, source FROM files WHERE (path = ? OR path = ?) AND source = ?').get(fwd, bwd, params.source);
        }
        if (!row) {
          row = analysisDb.prepare('SELECT content, language, source FROM files WHERE (path = ? OR path = ?) LIMIT 1').get(fwd, bwd);
        }
        if (!row) return { error: 'File not found' };
        const text = decompressContent(row.content).toString('utf-8');

        // Paginated mode
        if (params.startLine != null || params.maxLines != null) {
          const lines = text.split('\n');
          const totalLines = lines.length;
          const start = Math.max(1, params.startLine ?? 1);
          const max = params.maxLines ?? 100;
          const sliced = lines.slice(start - 1, start - 1 + max);
          const endLine = Math.min(start + sliced.length - 1, totalLines);
          return { content: sliced.join('\n'), language: row.language, source: row.source, totalLines, startLine: start, endLine };
        }

        return { content: truncate(text, 2800), language: row.language, source: row.source };
      } finally { analysisDb.close(); }
    },
  });

  const NOISE_URL_PATTERNS = [
    'publicsuffix.org', 'mozilla.org/MPL', 'slf4j.org', 'logback.qos.ch',
    'apache.org', 'w3.org', 'xml.org', 'schemas.android.com', 'xmlpull.org',
    'json.org', 'junit.org', 'gradle.org', 'jetbrains.com', 'kotlin-lang.org',
    'opensource.org/licenses', 'creativecommons.org', 'gnu.org/licenses',
    'xmlns.com', 'purl.org', 'ns.adobe.com',
  ];

  registry.register({
    name: 'get_apk_strings',
    description:
      'Get URLs and interesting strings (secrets, certificates) found in an analyzed APK. Use domainFilter to narrow to specific domains. Use source to filter to a specific file source (e.g. "hermes-dec" for React Native bundle only). Noise URLs (mozilla, apache, w3.org, etc.) are excluded by default.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        domainFilter: { type: 'string', description: 'Only return URLs containing this substring (e.g. "disney")' },
        excludeNoise: { type: 'boolean', description: 'Filter out common noise URLs (mozilla, apache, w3.org, etc.). Default: true' },
        source: { type: 'string', description: 'Filter to files from a specific source (e.g. "hermes-dec", "jadx", "apktool")' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; domainFilter?: string; excludeNoise?: boolean; source?: string }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const sourceFilter = params.source ? ' AND fi.source = ?' : '';
        const sourceParams = params.source ? [params.source] : [];
        let urls = (analysisDb.prepare(`
          SELECT f.matched_text, fi.path as file_path FROM findings f
          LEFT JOIN files fi ON f.file_id = fi.id WHERE f.category IN ('network', 'url', 'endpoint')${sourceFilter} LIMIT 50
        `).all(...sourceParams) as any[]).filter((r: any) => r.matched_text).map((r: any) => ({ url: r.matched_text, filePath: r.file_path ?? '' }));
        let secrets = (analysisDb.prepare(`
          SELECT f.matched_text, f.rule_id, f.category, fi.path as file_path FROM findings f
          LEFT JOIN files fi ON f.file_id = fi.id WHERE f.category IN ('secret', 'certificate')${sourceFilter} LIMIT 50
        `).all(...sourceParams) as any[]).filter((r: any) => r.matched_text).map((r: any) => ({ value: truncate(r.matched_text, 100), type: r.rule_id ?? r.category, filePath: r.file_path ?? '' }));
        // Load excluded paths from settings and filter out library paths
        const excludedRow = db.select().from(schema.settings).where(eq(schema.settings.key, 'analysis_excluded_paths')).all()[0];
        let excludedPaths: string[] = [];
        if (excludedRow?.value) {
          try { excludedPaths = JSON.parse(excludedRow.value); } catch {}
        }
        if (excludedPaths.length > 0) {
          const isExcluded = (filePath: string) => {
            const slashPath = '/' + filePath;
            return excludedPaths.some((p) => slashPath.includes('/' + p.replace(/\./g, '/') + '/'));
          };
          urls = urls.filter((r) => !isExcluded(r.filePath));
          secrets = secrets.filter((r) => !isExcluded(r.filePath));
        }
        // Apply domain filter
        if (params.domainFilter) {
          const df = params.domainFilter.toLowerCase();
          urls = urls.filter((r) => r.url.toLowerCase().includes(df));
        }
        // Apply noise filter (default: true)
        if (params.excludeNoise !== false) {
          urls = urls.filter((r) => !NOISE_URL_PATTERNS.some(p => r.url.includes(p)));
        }
        return { urls, secrets };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'get_rn_bundle_summary',
    description:
      'Get a summary of the React Native / Hermes bundle in an analyzed APK: engine type, bundle path, decompile status, file count, and notable findings from the JS layer. Use this for a quick overview of RN-specific intelligence.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        // Get manifest for framework info
        const manifest: Record<string, any> = {};
        for (const row of analysisDb.prepare('SELECT key, value FROM manifest').all() as any[]) {
          try { manifest[row.key] = JSON.parse(row.value); } catch { manifest[row.key] = row.value; }
        }
        const frameworks = manifest.frameworks || {};
        const rnDetails = frameworks.detected?.find((fw: any) => fw.name === 'React Native')?.details || {};
        if (!frameworks.reactNative) return { error: 'This APK does not contain React Native' };

        // Hermes-dec file stats
        const fileStats = analysisDb.prepare(
          "SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize FROM files WHERE source = 'hermes-dec'",
        ).get() as any;

        // Findings from hermes-dec source grouped by category
        const findingsByCategory = analysisDb.prepare(`
          SELECT f.category, COUNT(*) as count FROM findings f
          JOIN files fi ON f.file_id = fi.id
          WHERE fi.source = 'hermes-dec'
          GROUP BY f.category ORDER BY count DESC
        `).all() as any[];

        // Top findings from JS layer
        const topFindings = analysisDb.prepare(`
          SELECT f.rule_id, f.title, f.matched_text, f.category FROM findings f
          JOIN files fi ON f.file_id = fi.id
          WHERE fi.source = 'hermes-dec' AND f.category IN ('endpoint', 'config', 'secret')
          ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
          LIMIT 20
        `).all() as any[];

        return {
          engine: rnDetails.hermesEngine || frameworks.hermesEngine ? 'Hermes' : 'JavaScriptCore',
          bundlePath: rnDetails.hermesBundlePath || rnDetails.jsBundlePath || null,
          decompileErrors: manifest.hermesDecErrors || null,
          fileCount: fileStats?.count ?? 0,
          totalSize: fileStats?.totalSize ?? 0,
          findingsByCategory: Object.fromEntries(findingsByCategory.map((r: any) => [r.category, r.count])),
          topFindings: topFindings.map((r: any) => ({
            ruleId: r.rule_id,
            title: r.title,
            value: truncate(r.matched_text || '', 120),
            category: r.category,
          })),
        };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'list_apk_assets',
    description:
      'List file entries inside an APK zip archive. Useful for browsing raw APK contents (assets, res, lib, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        path: { type: 'string', description: 'Path prefix filter (e.g. "assets/" or "assets/tiles/"). Default: ""' },
        recursive: { type: 'boolean', description: 'If false, only immediate children of path. Default: false' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; path?: string; recursive?: boolean }) {
      const apkPath = resolveApkPath(params.versionId);
      if (!apkPath) return { error: 'APK file not found for this version' };
      try {
        const zip = new AdmZip(apkPath);
        const allEntries = zip.getEntries();
        const prefix = params.path ?? '';
        const recursive = params.recursive ?? false;
        // Normalize prefix: ensure trailing slash for non-empty prefix if not already
        const normalizedPrefix = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;

        const filtered: { name: string; size: number; isDirectory: boolean }[] = [];
        const seenDirs = new Set<string>();

        for (const entry of allEntries) {
          const entryName = entry.entryName;
          // Must start with prefix
          if (normalizedPrefix && !entryName.startsWith(normalizedPrefix)) continue;

          if (!recursive) {
            // Non-recursive: only immediate children of the prefix
            const remainder = entryName.slice(normalizedPrefix.length);
            if (!remainder) continue; // the prefix dir itself

            const slashIdx = remainder.indexOf('/');
            if (slashIdx === -1) {
              // It's a file at this level
              filtered.push({ name: entryName, size: entry.header.size, isDirectory: false });
            } else if (slashIdx === remainder.length - 1) {
              // It's a direct subdirectory
              if (!seenDirs.has(entryName)) {
                seenDirs.add(entryName);
                filtered.push({ name: entryName, size: 0, isDirectory: true });
              }
            } else {
              // It's a deeper file — we show its parent dir as an entry
              const dirName = normalizedPrefix + remainder.slice(0, slashIdx + 1);
              if (!seenDirs.has(dirName)) {
                seenDirs.add(dirName);
                filtered.push({ name: dirName, size: 0, isDirectory: true });
              }
            }
          } else {
            filtered.push({ name: entryName, size: entry.header.size, isDirectory: entry.isDirectory });
          }

          if (filtered.length >= 500) break;
        }

        return { entries: filtered, totalEntries: allEntries.length };
      } catch (err: any) {
        return { error: `Failed to read APK: ${err.message}` };
      }
    },
  });

  registry.register({
    name: 'get_mbtiles_info',
    description:
      'Extract an mbtiles file from inside an APK and read its metadata, tile count, and zoom level distribution.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        path: { type: 'string', description: 'Path within APK, e.g. "assets/10255_default.mbtiles"' },
      },
      required: ['versionId', 'path'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; path: string }) {
      const apkPath = resolveApkPath(params.versionId);
      if (!apkPath) return { error: 'APK file not found for this version' };

      const tmpFile = path.join(os.tmpdir(), `darkride-mbtiles-${Date.now()}-${Math.random().toString(36).slice(2)}.mbtiles`);
      let mbtilesDb: Database.Database | null = null;
      try {
        const zip = new AdmZip(apkPath);
        const entry = zip.getEntry(params.path);
        if (!entry) return { error: `Entry not found in APK: ${params.path}` };

        // Extract to temp file
        const data = entry.getData();
        fs.writeFileSync(tmpFile, data);

        // Open as SQLite
        mbtilesDb = new Database(tmpFile, { readonly: true });

        // Read metadata
        const metadata: Record<string, string> = {};
        try {
          const rows = mbtilesDb.prepare('SELECT name, value FROM metadata').all() as any[];
          for (const row of rows) {
            metadata[row.name] = row.value;
          }
        } catch {
          // metadata table may not exist
        }

        // Tile count and zoom distribution
        let tileCount = 0;
        const zoomDistribution: Record<number, number> = {};
        try {
          const countRow = mbtilesDb.prepare('SELECT COUNT(*) as cnt FROM tiles').get() as any;
          tileCount = countRow?.cnt ?? 0;

          const zoomRows = mbtilesDb.prepare('SELECT zoom_level, COUNT(*) as cnt FROM tiles GROUP BY zoom_level ORDER BY zoom_level').all() as any[];
          for (const row of zoomRows) {
            zoomDistribution[row.zoom_level] = row.cnt;
          }
        } catch {
          // tiles table may not exist
        }

        return { metadata, tileCount, zoomDistribution };
      } catch (err: any) {
        return { error: `Failed to read mbtiles: ${err.message}` };
      } finally {
        if (mbtilesDb) try { mbtilesDb.close(); } catch {}
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    },
  });

  registry.register({
    name: 'list_flutter_classes',
    description:
      'List classes found in the Flutter/blutter analysis dump stored in source.db. Returns up to 100 classes by default.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        limit: { type: 'number', description: 'Max classes to return (default 100)' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; limit?: number }) {
      const limit = params.limit ?? 100;
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const files = analysisDb.prepare("SELECT path, content FROM files WHERE source = 'flutter-dump'").all() as any[];
        if (files.length === 0) return { error: 'No Flutter dump data found for this version' };

        const classes: { name: string; filePath: string }[] = [];
        const classRegex = /^(?:abstract )?class (\S+)/gm;
        for (const file of files) {
          let text: string;
          try { text = decompressContent(file.content).toString('utf-8'); } catch { continue; }
          let match;
          while ((match = classRegex.exec(text)) !== null) {
            classes.push({ name: match[1], filePath: file.path });
            if (classes.length >= limit) break;
          }
          if (classes.length >= limit) break;
        }
        return { classes };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'search_flutter_methods',
    description:
      'Find methods in Flutter dump files, optionally filtered by class name or method name substring.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        className: { type: 'string', description: 'Filter to methods within this class' },
        query: { type: 'string', description: 'Substring filter on method name' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; className?: string; query?: string }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const files = analysisDb.prepare("SELECT path, content FROM files WHERE source = 'flutter-dump'").all() as any[];
        if (files.length === 0) return { error: 'No Flutter dump data found for this version' };

        const methods: { name: string; className: string; filePath: string; line: number }[] = [];
        const classRegex = /^(?:abstract )?class (\S+)/;
        const methodRegex = /^\s+(?:static\s+)?(\S+)\s+(\S+)\(/;

        for (const file of files) {
          let text: string;
          try { text = decompressContent(file.content).toString('utf-8'); } catch { continue; }
          const lines = text.split('\n');
          let currentClass = '';
          for (let i = 0; i < lines.length; i++) {
            const classMatch = classRegex.exec(lines[i]);
            if (classMatch) {
              currentClass = classMatch[1];
              continue;
            }
            if (params.className && currentClass !== params.className) continue;

            const methodMatch = methodRegex.exec(lines[i]);
            if (methodMatch) {
              const methodName = methodMatch[2];
              if (params.query && !methodName.toLowerCase().includes(params.query.toLowerCase())) continue;
              methods.push({ name: methodName, className: currentClass, filePath: file.path, line: i + 1 });
              if (methods.length >= 200) break;
            }
          }
          if (methods.length >= 200) break;
        }
        return { methods };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'read_analysis_notes',
    description:
      'Read the markdown analysis notes document for an APK version. Returns the current notes content (empty string if no notes exist yet).',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
      },
      required: ['versionId'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number }) {
      const meta = lookupVersionMeta(db, params.versionId);
      if (!meta) return { error: 'APK version not found' };
      return { notes: getNote(db, params.versionId) };
    },
  });

  registry.register({
    name: 'write_analysis_notes',
    description:
      'Write the full markdown analysis notes document for an APK version. Prefer patch_analysis_section for incremental section-by-section writing. Use this only for short notes or a final consolidation pass.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        notes: { type: 'string', description: 'The complete markdown notes content to write' },
      },
      required: ['versionId', 'notes'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:manage',
    async execute(params: { versionId: number; notes: string }) {
      const meta = lookupVersionMeta(db, params.versionId);
      if (!meta) return { error: 'APK version not found' };
      try {
        setNote(db, params.versionId, params.notes);
        broadcastToAll({ type: 'apk:notes-updated', versionId: params.versionId, notes: params.notes });
        return { ok: true };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  });

  registry.register({
    name: 'patch_analysis_section',
    description:
      'Write or replace a single ## section in the analysis notes. Use this to build the notes incrementally — call it once per section as you finish researching each topic. Much safer than write_analysis_notes for large analyses because each call only generates a small amount of output.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID (from Context ID)' },
        section: {
          type: 'string',
          description: 'The section heading text (without ##), e.g. "Overview" or "API Endpoints"',
        },
        content: {
          type: 'string',
          description: 'The markdown content for this section (without the ## heading line)',
        },
      },
      required: ['versionId', 'section', 'content'],
    },
    context: ['apk-analysis'],
    requiredScope: 'core.apk:manage',
    async execute(params: { versionId: number; section: string; content: string }) {
      const meta = lookupVersionMeta(db, params.versionId);
      if (!meta) return { error: 'APK version not found' };
      try {
        const updated = patchNoteSection(db, params.versionId, params.section, params.content);
        broadcastToAll({ type: 'apk:notes-updated', versionId: params.versionId, notes: updated });
        const sectionCount = (updated.match(/^## /gm) || []).length;
        return { ok: true, sectionCount };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  });

  // ── Dashboard tools ────────────────────────────────────────────

  registry.register({
    name: 'get_system_status',
    description:
      'Get system status with counts of automations, sessions, traffic entries, and proxies.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['dashboard'],
    requiredScope: 'core.devices:read',
    async execute() {
      const [automations] = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.automations)
        .all();
      const [sessions] = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.automationSessions)
        .all();
      const [traffic] = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.capturedTraffic)
        .all();
      const [proxies] = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.proxies)
        .all();
      return {
        automations: automations.count,
        sessions: sessions.count,
        trafficEntries: traffic.count,
        proxies: proxies.count,
      };
    },
  });

  // ── APK Diff tools ─────────────────────────────────────────────

  /** Helpers shared by diff tools */
  function getDiffVersionIds(reportId: number): { newVersionId: number; oldVersionId: number } | null {
    const report = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, reportId)).all()[0];
    if (!report) return null;
    return { newVersionId: report.apkVersionId, oldVersionId: report.compareVersionId };
  }

  function openDiffDb(versionId: number): Database.Database | null {
    const meta = lookupVersionMeta(db, versionId);
    if (!meta) return null;
    const dbPath = analysisDbPath(meta.packageName, meta.versionCode);
    if (!fs.existsSync(dbPath)) return null;
    try { return new Database(dbPath, { readonly: true }); } catch { return null; }
  }

  function getDiffFileListPath(reportId: number): string | null {
    const report = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, reportId)).all()[0];
    if (!report?.diffJson) return null;
    try {
      const diff = JSON.parse(report.diffJson);
      if (!diff.fileListPath) return null;
      const meta = lookupVersionMeta(db, report.apkVersionId);
      if (!meta) return null;
      return path.join(getApkDir(), meta.packageName, diff.fileListPath);
    } catch { return null; }
  }

  registry.register({
    name: 'get_diff_overview',
    description:
      'Get the pre-computed structural diff between two APK versions: permissions, manifest changes, library/framework changes, finding counts, and file statistics. Call this first.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID (from Context ID)' },
      },
      required: ['reportId'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:read',
    async execute(params: { reportId: number }) {
      const report = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, params.reportId)).all()[0];
      if (!report) return { error: 'Diff report not found' };
      if (!report.diffJson) return { error: 'Diff not yet computed' };
      const versions = getDiffVersionIds(params.reportId);
      return {
        reportId: params.reportId,
        newVersionId: versions?.newVersionId,
        oldVersionId: versions?.oldVersionId,
        diff: JSON.parse(report.diffJson),
      };
    },
  });

  registry.register({
    name: 'get_diff_new_findings',
    description:
      'Get security findings that are present in the new APK version but were not in the previous version. Paginate with limit/offset.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID (from Context ID)' },
        severity: { type: 'string', description: 'Filter by severity: critical, high, medium, low, info' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Skip N results (default 0)' },
      },
      required: ['reportId'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:read',
    async execute(params: { reportId: number; severity?: string; limit?: number; offset?: number }) {
      const versions = getDiffVersionIds(params.reportId);
      if (!versions) return { error: 'Diff report not found' };

      const newDb = openDiffDb(versions.newVersionId);
      const oldDb = openDiffDb(versions.oldVersionId);
      if (!newDb || !oldDb) {
        newDb?.close(); oldDb?.close();
        return { error: 'Analysis database(s) not available' };
      }

      try {
        type Row = { rule_id: string; severity: string; title: string; description: string; line_number: number | null; matched_text: string | null; category: string; file_path: string | null };
        const newFindings = newDb.prepare(
          `SELECT f.rule_id, f.severity, f.title, f.description, f.line_number, f.matched_text, f.category, fi.path as file_path
           FROM findings f LEFT JOIN files fi ON f.file_id = fi.id`,
        ).all() as Row[];
        const oldFindings = oldDb.prepare(
          `SELECT f.rule_id, fi.path as file_path FROM findings f LEFT JOIN files fi ON f.file_id = fi.id`,
        ).all() as { rule_id: string; file_path: string | null }[];

        const oldKeys = new Set(oldFindings.map(f => `${f.rule_id}:${f.file_path ?? ''}`));
        let newOnly = newFindings.filter(f => !oldKeys.has(`${f.rule_id}:${f.file_path ?? ''}`));
        if (params.severity) newOnly = newOnly.filter(f => f.severity === params.severity);

        const total = newOnly.length;
        const limit = params.limit ?? 20;
        const offset = params.offset ?? 0;
        const page = newOnly.slice(offset, offset + limit).map(f => ({
          ruleId: f.rule_id, severity: f.severity, title: f.title,
          description: truncate(f.description, 200),
          lineNumber: f.line_number, matchedText: truncate(f.matched_text, 200),
          category: f.category, filePath: f.file_path ?? '',
        }));
        return { results: page, total, offset, limited: offset + limit < total };
      } finally {
        newDb.close(); oldDb.close();
      }
    },
  });

  registry.register({
    name: 'get_diff_resolved_findings',
    description:
      'Get security findings that were present in the previous APK version but are no longer present in the new version.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID (from Context ID)' },
        severity: { type: 'string', description: 'Filter by severity: critical, high, medium, low, info' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Skip N results (default 0)' },
      },
      required: ['reportId'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:read',
    async execute(params: { reportId: number; severity?: string; limit?: number; offset?: number }) {
      const versions = getDiffVersionIds(params.reportId);
      if (!versions) return { error: 'Diff report not found' };

      const newDb = openDiffDb(versions.newVersionId);
      const oldDb = openDiffDb(versions.oldVersionId);
      if (!newDb || !oldDb) {
        newDb?.close(); oldDb?.close();
        return { error: 'Analysis database(s) not available' };
      }

      try {
        type Row = { rule_id: string; severity: string; title: string; description: string; line_number: number | null; matched_text: string | null; category: string; file_path: string | null };
        const oldFindings = oldDb.prepare(
          `SELECT f.rule_id, f.severity, f.title, f.description, f.line_number, f.matched_text, f.category, fi.path as file_path
           FROM findings f LEFT JOIN files fi ON f.file_id = fi.id`,
        ).all() as Row[];
        const newFindings = newDb.prepare(
          `SELECT f.rule_id, fi.path as file_path FROM findings f LEFT JOIN files fi ON f.file_id = fi.id`,
        ).all() as { rule_id: string; file_path: string | null }[];

        const newKeys = new Set(newFindings.map(f => `${f.rule_id}:${f.file_path ?? ''}`));
        let resolved = oldFindings.filter(f => !newKeys.has(`${f.rule_id}:${f.file_path ?? ''}`));
        if (params.severity) resolved = resolved.filter(f => f.severity === params.severity);

        const total = resolved.length;
        const limit = params.limit ?? 20;
        const offset = params.offset ?? 0;
        const page = resolved.slice(offset, offset + limit).map(f => ({
          ruleId: f.rule_id, severity: f.severity, title: f.title,
          description: truncate(f.description, 200),
          lineNumber: f.line_number, matchedText: truncate(f.matched_text, 200),
          category: f.category, filePath: f.file_path ?? '',
        }));
        return { results: page, total, offset, limited: offset + limit < total };
      } finally {
        newDb.close(); oldDb.close();
      }
    },
  });

  registry.register({
    name: 'get_diff_changed_files',
    description:
      'Browse the list of files that were added, removed, or modified between the two APK versions. Use pathFilter to narrow to a specific package/directory.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID (from Context ID)' },
        changeType: { type: 'string', description: 'Type of change: added, removed, or modified' },
        pathFilter: { type: 'string', description: 'Only return paths containing this substring (e.g. "com/example")' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Skip N results (default 0)' },
      },
      required: ['reportId', 'changeType'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:read',
    async execute(params: { reportId: number; changeType: string; pathFilter?: string; limit?: number; offset?: number }) {
      const listPath = getDiffFileListPath(params.reportId);
      if (!listPath || !fs.existsSync(listPath)) return { error: 'File change list not available' };

      try {
        const data = JSON.parse(fs.readFileSync(listPath, 'utf-8'));
        const type = params.changeType as 'added' | 'removed' | 'modified';
        let entries: Array<{ source: string; path: string }> = data[type] ?? [];
        if (params.pathFilter) {
          entries = entries.filter((e: { path: string }) => e.path.includes(params.pathFilter!));
        }
        const total = entries.length;
        const limit = params.limit ?? 50;
        const offset = params.offset ?? 0;
        return { results: entries.slice(offset, offset + limit), total, offset, limited: offset + limit < total };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  });

  registry.register({
    name: 'get_diff_file_comparison',
    description:
      'Compare a specific file between the two APK versions. Returns the content of the file from both versions for manual comparison. Useful for spot-checking specific changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID (from Context ID)' },
        filePath: { type: 'string', description: 'Path to the file (from get_diff_changed_files)' },
        source: { type: 'string', description: 'Source type (jadx, apktool, etc.)' },
        maxLines: { type: 'number', description: 'Max lines to return from each version (default 100)' },
      },
      required: ['reportId', 'filePath', 'source'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:read',
    async execute(params: { reportId: number; filePath: string; source: string; maxLines?: number }) {
      const versions = getDiffVersionIds(params.reportId);
      if (!versions) return { error: 'Diff report not found' };

      const maxLines = params.maxLines ?? 100;
      const getContent = (db: Database.Database | null): string | null => {
        if (!db) return null;
        try {
          const row = db.prepare(`SELECT content FROM files WHERE path = ? AND source = ? LIMIT 1`)
            .get(params.filePath, params.source) as any;
          if (!row) return null;
          const buf = Buffer.from(row.content);
          let text: string;
          if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xB5 && buf[2] === 0x2F && buf[3] === 0xFD) {
            text = zlib.zstdDecompressSync(buf).toString('utf-8');
          } else {
            text = zlib.inflateSync(buf).toString('utf-8');
          }
          const lines = text.split('\n');
          return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : '');
        } catch { return null; } finally { db.close(); }
      };

      const newContent = getContent(openDiffDb(versions.newVersionId));
      const oldContent = getContent(openDiffDb(versions.oldVersionId));

      if (newContent === null && oldContent === null) {
        return { error: `File "${params.filePath}" not found in either version` };
      }
      return {
        filePath: params.filePath, source: params.source,
        newVersion: newContent ?? '(file not present)',
        oldVersion: oldContent ?? '(file not present)',
      };
    },
  });

  registry.register({
    name: 'write_diff_summary',
    description:
      'Save the AI-generated diff analysis summary. Call this when you have finished your analysis. The summary will be displayed in the Diff tab of the analysis page.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID (from Context ID)' },
        summary: { type: 'string', description: 'The markdown summary of the diff analysis' },
      },
      required: ['reportId', 'summary'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:manage',
    async execute(params: { reportId: number; summary: string }) {
      const report = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, params.reportId)).all()[0];
      if (!report) return { error: 'Diff report not found' };

      db.update(schema.apkDiffReports)
        .set({ aiSummary: params.summary, status: 'completed', completedAt: new Date() })
        .where(eq(schema.apkDiffReports.id, params.reportId))
        .run();

      broadcastToAll({
        type: 'apk:diff-update',
        versionId: report.apkVersionId,
        reportId: params.reportId,
        status: 'completed',
      });
      return { ok: true };
    },
  });

  registry.register({
    name: 'patch_diff_summary_section',
    description: 'Replace or append a single `## <section>` block in a diff report\'s AI summary. Mirrors patch_analysis_section. Use this for incremental section-by-section writing — much cheaper than rewriting the whole summary via write_diff_summary.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'number', description: 'The diff report ID' },
        section: { type: 'string', description: 'Section heading (without the leading `## `)' },
        content: { type: 'string', description: 'Markdown content for this section' },
      },
      required: ['reportId', 'section', 'content'],
    },
    context: ['apk-diff'],
    requiredScope: 'core.apk:manage',
    async execute(params: { reportId: number; section: string; content: string }) {
      const report = db.select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, params.reportId)).all()[0];
      if (!report) return { error: 'Diff report not found' };
      const existing = report.aiSummary ?? '';
      const header = `## ${params.section}`;
      const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sectionRegex = new RegExp(`(^|\\n)${escaped}\\n[\\s\\S]*?(?=\\n## |$)`);
      let updated: string;
      if (sectionRegex.test(existing)) {
        updated = existing.replace(sectionRegex, `$1${header}\n${params.content.trimEnd()}\n`);
      } else {
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        updated = `${existing}${sep}${header}\n${params.content.trimEnd()}\n`;
      }
      db.update(schema.apkDiffReports)
        .set({ aiSummary: updated, completedAt: new Date() })
        .where(eq(schema.apkDiffReports.id, params.reportId))
        .run();
      broadcastToAll({
        type: 'apk:diff-update',
        versionId: report.apkVersionId,
        reportId: params.reportId,
        status: report.status ?? 'completed',
      });
      return { reportId: params.reportId, section: params.section, newLength: updated.length };
    },
  });

  // ── Frida tools ───────────────────────────────────────────────

  registry.register({
    name: 'list_frida_scripts',
    description: 'List all saved Frida scripts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:read',
    async execute() {
      return db
        .select({
          id: schema.fridaScripts.id,
          name: schema.fridaScripts.name,
          description: schema.fridaScripts.description,
          category: schema.fridaScripts.category,
          targetApp: schema.fridaScripts.targetApp,
        })
        .from(schema.fridaScripts)
        .all();
    },
  });

  registry.register({
    name: 'get_frida_script',
    description: "Get a Frida script's full code by ID.",
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'number', description: 'The Frida script ID' },
      },
      required: ['scriptId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:read',
    async execute(params: { scriptId: number }) {
      const rows = db
        .select({
          id: schema.fridaScripts.id,
          name: schema.fridaScripts.name,
          code: schema.fridaScripts.code,
          description: schema.fridaScripts.description,
          category: schema.fridaScripts.category,
          targetApp: schema.fridaScripts.targetApp,
        })
        .from(schema.fridaScripts)
        .where(eq(schema.fridaScripts.id, params.scriptId))
        .all();
      if (rows.length === 0) return { error: 'Frida script not found' };
      return rows[0];
    },
  });

  registry.register({
    name: 'create_frida_script',
    description: 'Create a new Frida script.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Script name' },
        code: { type: 'string', description: 'JavaScript code for the Frida script' },
        description: { type: 'string', description: 'Short description of what the script does' },
        category: { type: 'string', description: 'Category (e.g. hooking, tracing, bypass)' },
        targetApp: { type: 'string', description: 'Target app bundle/package ID' },
      },
      required: ['name', 'code'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { name: string; code: string; description?: string; category?: string; targetApp?: string }) {
      const now = new Date();
      db.insert(schema.fridaScripts)
        .values({
          name: params.name,
          code: params.code,
          description: params.description ?? null,
          category: params.category ?? null,
          targetApp: params.targetApp ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const row = db
        .select()
        .from(schema.fridaScripts)
        .where(eq(schema.fridaScripts.name, params.name))
        .orderBy(desc(schema.fridaScripts.id))
        .limit(1)
        .all();
      return row[0] ?? { ok: true };
    },
  });

  registry.register({
    name: 'update_frida_script',
    description: "Update an existing Frida script's code, name, or description.",
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'number', description: 'The Frida script ID' },
        name: { type: 'string', description: 'New script name' },
        code: { type: 'string', description: 'Updated JavaScript code' },
        description: { type: 'string', description: 'Updated description' },
        category: { type: 'string', description: 'Updated category' },
        targetApp: { type: 'string', description: 'Updated target app bundle/package ID' },
      },
      required: ['scriptId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { scriptId: number; name?: string; code?: string; description?: string; category?: string; targetApp?: string }) {
      const existing = db.select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, params.scriptId)).all();
      if (existing.length === 0) return { error: 'Frida script not found' };
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (params.name !== undefined) updates.name = params.name;
      if (params.code !== undefined) updates.code = params.code;
      if (params.description !== undefined) updates.description = params.description;
      if (params.category !== undefined) updates.category = params.category;
      if (params.targetApp !== undefined) updates.targetApp = params.targetApp;
      db.update(schema.fridaScripts)
        .set(updates)
        .where(eq(schema.fridaScripts.id, params.scriptId))
        .run();
      const updated = db.select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, params.scriptId)).all();
      return updated[0];
    },
  });

  registry.register({
    name: 'patch_frida_script',
    description: "Find-and-replace within a Frida script's body. `oldText` must match exactly once. Use this instead of `update_frida_script` when only a single block is changing — cuts token usage 70-90% on iterative script tightening.",
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'number', description: 'The Frida script ID' },
        oldText: { type: 'string', description: 'Exact substring to find. Must occur exactly once in the current code.' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['scriptId', 'oldText', 'newText'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { scriptId: number; oldText: string; newText: string }) {
      const existing = db.select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, params.scriptId)).all()[0];
      if (!existing) return { error: 'Frida script not found' };
      const code = existing.code;
      const idx = code.indexOf(params.oldText);
      if (idx === -1) return { error: 'oldText not found in script' };
      if (code.indexOf(params.oldText, idx + 1) !== -1) {
        return { error: 'oldText matches multiple locations — provide more surrounding context to disambiguate' };
      }
      const patched = code.slice(0, idx) + params.newText + code.slice(idx + params.oldText.length);
      db.update(schema.fridaScripts)
        .set({ code: patched, updatedAt: new Date() })
        .where(eq(schema.fridaScripts.id, params.scriptId))
        .run();
      return { scriptId: params.scriptId, replacedAt: idx, newLength: patched.length };
    },
  });

  registry.register({
    name: 'append_frida_hook',
    description: 'Append a new hook (e.g. a `Java.perform(() => { ... })` block) to the end of an existing Frida script. Avoids sending the whole existing body when you just want to add another hook.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'number', description: 'The Frida script ID' },
        hookCode: { type: 'string', description: 'New hook code to append. A blank line is inserted before it.' },
      },
      required: ['scriptId', 'hookCode'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { scriptId: number; hookCode: string }) {
      const existing = db.select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, params.scriptId)).all()[0];
      if (!existing) return { error: 'Frida script not found' };
      const separator = existing.code.endsWith('\n') ? '\n' : '\n\n';
      const patched = existing.code + separator + params.hookCode;
      db.update(schema.fridaScripts)
        .set({ code: patched, updatedAt: new Date() })
        .where(eq(schema.fridaScripts.id, params.scriptId))
        .run();
      return { scriptId: params.scriptId, newLength: patched.length };
    },
  });

  registry.register({
    name: 'list_devices',
    description: 'List all connected Android/iOS devices.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['frida', 'apk-analysis', 'devices'],
    requiredScope: 'core.devices:read',
    async execute() {
      return db
        .select({
          id: schema.devices.id,
          name: schema.devices.name,
          platform: schema.devices.platform,
          model: schema.devices.model,
          manufacturer: schema.devices.manufacturer,
          isRooted: schema.devices.isRooted,
          androidVersion: schema.devices.androidVersion,
          iosVersion: schema.devices.iosVersion,
        })
        .from(schema.devices)
        .all();
    },
  });

  // ── Capture session tools ──────────────────────────────────────

  registry.register({
    name: 'start_capture',
    description: 'Start traffic capture for a device. Returns the new sessionId. Optionally route through a proxy (none/normal/nordvpn) and select a TLS fingerprint profile.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        proxyMode: { type: 'string', enum: ['none', 'normal', 'nordvpn'], description: 'Proxy routing mode (optional)' },
        proxyCountry: { type: 'string', description: 'Two-letter country code, required when proxyMode=nordvpn' },
        tlsProfile: { type: 'string', description: 'TLS fingerprint profile name (optional)' },
      },
      required: ['deviceId'],
    },
    context: ['devices', 'traffic'],
    requiredScope: 'core.traffic:manage',
    requiresConfirmation: true,
    async execute(params: { deviceId: string; proxyMode?: 'none' | 'normal' | 'nordvpn'; proxyCountry?: string; tlsProfile?: string }) {
      if (!captureManager) throw new Error('CaptureSessionManager not wired into AI tools');
      const proxyOptions = params.proxyMode ? { mode: params.proxyMode, country: params.proxyCountry } : undefined;
      const result = await captureManager.startCapture(params.deviceId, proxyOptions, params.tlsProfile);
      return { sessionId: result.sessionId };
    },
  });

  registry.register({
    name: 'stop_capture',
    description: 'Stop traffic capture for a device. Idempotent — quietly succeeds if no capture is active.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
      },
      required: ['deviceId'],
    },
    context: ['devices', 'traffic'],
    requiredScope: 'core.traffic:manage',
    async execute(params: { deviceId: string }) {
      if (!captureManager) throw new Error('CaptureSessionManager not wired into AI tools');
      await captureManager.stopCapture(params.deviceId);
      return { deviceId: params.deviceId, stopped: true };
    },
  });

  // ── Plugin management tools ────────────────────────────────────

  registry.register({
    name: 'enable_plugin',
    description: 'Enable an installed plugin. Triggers the restart-required flag — the host must be restarted for the plugin to actually load.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin name (the plugin\'s package identifier)' },
      },
      required: ['name'],
    },
    context: ['plugins'],
    requiredScope: 'core.plugins:manage',
    requiresConfirmation: true,
    async execute(params: { name: string }) {
      if (!pluginStateManager) throw new Error('PluginStateManager not wired into AI tools');
      const existing = pluginStateManager.get(params.name);
      if (!existing) return { error: `Plugin "${params.name}" not found` };
      pluginStateManager.setEnabled(params.name, true);
      systemStateService?.setRestartRequired(`plugin ${params.name} enabled`);
      return { name: params.name, enabled: true, restartRequired: true };
    },
  });

  registry.register({
    name: 'disable_plugin',
    description: 'Disable an installed plugin without uninstalling it. Plugin data is preserved. Triggers the restart-required flag — the host must be restarted for the plugin to actually unload.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plugin name' },
      },
      required: ['name'],
    },
    context: ['plugins'],
    requiredScope: 'core.plugins:manage',
    requiresConfirmation: true,
    async execute(params: { name: string }) {
      if (!pluginStateManager) throw new Error('PluginStateManager not wired into AI tools');
      const existing = pluginStateManager.get(params.name);
      if (!existing) return { error: `Plugin "${params.name}" not found` };
      pluginStateManager.setEnabled(params.name, false);
      systemStateService?.setRestartRequired(`plugin ${params.name} disabled`);
      return { name: params.name, enabled: false, restartRequired: true };
    },
  });

  // ── Settings tools ─────────────────────────────────────────────

  registry.register({
    name: 'get_setting',
    description: 'Read the current value of a host setting by key. Returns null if the key has never been set. Sensitive keys (passwords, API keys) are returned masked.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The setting key (e.g. "mcp_enabled", "oauth_public_base_url")' },
      },
      required: ['key'],
    },
    context: ['settings'],
    requiredScope: 'core.settings:read',
    async execute(params: { key: string }) {
      const row = db.select().from(schema.settings).where(eq(schema.settings.key, params.key)).all()[0];
      if (!row) return { key: params.key, value: null };
      // Mask values that look like secrets — heuristic: keys containing
      // 'password', 'token', 'api_key', or 'secret' are masked.
      const isSecret = /password|token|api_key|secret/i.test(params.key);
      return { key: row.key, value: isSecret ? maskPassword(row.value) : row.value };
    },
  });

  registry.register({
    name: 'update_setting',
    description: 'Upsert a host setting. The value is stored as a string — pass JSON-stringified data for structured values. May trigger restart-required for settings that affect server boot.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The setting key' },
        value: { type: 'string', description: 'New value (stored as string)' },
      },
      required: ['key', 'value'],
    },
    context: ['settings'],
    requiredScope: 'core.settings:write',
    requiresConfirmation: true,
    async execute(params: { key: string; value: string }) {
      const existing = db.select().from(schema.settings).where(eq(schema.settings.key, params.key)).all()[0];
      if (existing) {
        db.update(schema.settings)
          .set({ value: params.value })
          .where(eq(schema.settings.key, params.key))
          .run();
      } else {
        db.insert(schema.settings).values({ key: params.key, value: params.value }).run();
      }
      return { key: params.key, updated: true };
    },
  });

  registry.register({
    name: 'list_device_apps',
    description: 'List apps installed on a device (via Frida).',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
      },
      required: ['deviceId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.devices:read',
    async execute(params: { deviceId: string }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      return callFridaBridge(bridgeManager, params.deviceId, 'frida_list_apps', {});
    },
  });

  registry.register({
    name: 'run_frida_script',
    description: 'Run a Frida script on a device by spawning/attaching to an app.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        bundleId: { type: 'string', description: 'App bundle/package ID to attach to' },
        scriptId: { type: 'number', description: 'ID of a saved Frida script to run' },
        code: { type: 'string', description: 'Inline Frida script code (used if scriptId is not provided)' },
        mode: { type: 'string', description: 'Spawn mode: "spawn" or "attach" (default: spawn)' },
      },
      required: ['deviceId', 'bundleId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    requiresConfirmation: true,
    allowUnattended: false,
    async execute(params: { deviceId: string; bundleId: string; scriptId?: number; code?: string; mode?: string }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      // scriptId is part of the input schema but historically silently
      // ignored (the route reads `scripts` as an array of names, never
      // `scriptId`). Preserved as-is to avoid changing tool behaviour.
      deviceManager?.markBusy?.(params.deviceId);
      try {
        const bridgeMethod = params.mode === 'controlled' ? 'frida_spawn_controlled' : 'frida_run';
        return await callFridaBridge(bridgeManager, params.deviceId, bridgeMethod, {
          bundle_id: params.bundleId,
          code: params.code ?? '',
          mode: params.mode === 'controlled' ? undefined : (params.mode || 'spawn'),
        });
      } catch (err) {
        deviceManager?.markIdle?.(params.deviceId);
        throw err;
      }
    },
  });

  registry.register({
    name: 'get_frida_messages',
    description: 'Get Frida script output/messages from a device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        since: { type: 'number', description: 'Unix timestamp (ms) — only return messages after this time' },
      },
      required: ['deviceId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:read',
    async execute(params: { deviceId: string; since?: number }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      const bridgeParams: Record<string, any> = {};
      if (params.since != null) bridgeParams.since = params.since;
      return callFridaBridge(bridgeManager, params.deviceId, 'frida_get_messages', bridgeParams);
    },
  });

  registry.register({
    name: 'stop_frida',
    description: 'Stop Frida on a device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
      },
      required: ['deviceId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { deviceId: string }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      const result = await callFridaBridge(bridgeManager, params.deviceId, 'frida_stop_server', {});
      deviceManager?.markIdle?.(params.deviceId);
      return result;
    },
  });

  // ── API Catalogue tools ─────────────────────────────────────────

  registry.register({
    name: 'list_api_groups',
    description: 'List API endpoint groups.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    context: ['api-catalogue'],
    requiredScope: 'core.traffic:read',
    async execute() {
      const groups = db
        .select()
        .from(schema.apiEndpointGroups)
        .all();
      const counts = db
        .select({
          groupId: schema.apiEndpoints.groupId,
          count: sql<number>`COUNT(*)`,
        })
        .from(schema.apiEndpoints)
        .groupBy(schema.apiEndpoints.groupId)
        .all();
      const countMap = new Map(counts.map((c) => [c.groupId, c.count]));
      return groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        notes: g.notes,
        endpointCount: countMap.get(g.id) ?? 0,
      }));
    },
  });

  registry.register({
    name: 'get_api_group',
    description: 'Get an API group with its URL patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: 'The group ID' },
      },
      required: ['groupId'],
    },
    context: ['api-catalogue'],
    requiredScope: 'core.traffic:read',
    async execute(params: { groupId: number }) {
      const rows = db
        .select()
        .from(schema.apiEndpointGroups)
        .where(eq(schema.apiEndpointGroups.id, params.groupId))
        .all();
      if (rows.length === 0) return { error: 'Group not found' };
      const patterns = db
        .select()
        .from(schema.apiEndpointGroupPatterns)
        .where(eq(schema.apiEndpointGroupPatterns.groupId, params.groupId))
        .all();
      return { ...rows[0], patterns };
    },
  });

  registry.register({
    name: 'list_api_endpoints',
    description: 'List captured API endpoints, optionally filtered by group or search.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: 'Filter by API group ID' },
        search: { type: 'string', description: 'Search URL pattern using SQL LIKE (e.g. %api%)' },
        method: { type: 'string', description: 'HTTP method filter (e.g. GET, POST)' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
    context: ['api-catalogue'],
    requiredScope: 'core.traffic:read',
    async execute(params: { groupId?: number; search?: string; method?: string; limit?: number }) {
      const { and } = await import('drizzle-orm');
      const limit = params.limit ?? 50;
      const conditions = [];
      if (params.groupId != null) {
        conditions.push(eq(schema.apiEndpoints.groupId, params.groupId));
      }
      if (params.search) {
        conditions.push(like(schema.apiEndpoints.pathPattern, `%${params.search}%`));
      }
      if (params.method) {
        conditions.push(eq(schema.apiEndpoints.method, params.method));
      }
      let query = db
        .select({
          id: schema.apiEndpoints.id,
          method: schema.apiEndpoints.method,
          hostname: schema.apiEndpoints.hostname,
          pathPattern: schema.apiEndpoints.pathPattern,
          requestCount: schema.apiEndpoints.requestCount,
          groupId: schema.apiEndpoints.groupId,
          firstSeen: schema.apiEndpoints.firstSeen,
          lastSeen: schema.apiEndpoints.lastSeen,
        })
        .from(schema.apiEndpoints)
        .orderBy(desc(schema.apiEndpoints.lastSeen))
        .limit(limit);
      if (conditions.length === 1) {
        query = query.where(conditions[0]) as typeof query;
      } else if (conditions.length > 1) {
        query = query.where(and(...conditions)) as typeof query;
      }
      return query.all();
    },
  });

  registry.register({
    name: 'get_api_endpoint',
    description: 'Get detailed info about a captured API endpoint including query params and response spec.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: { type: 'number', description: 'The endpoint ID' },
      },
      required: ['endpointId'],
    },
    context: ['api-catalogue'],
    requiredScope: 'core.traffic:read',
    async execute(params: { endpointId: number }) {
      const rows = db
        .select()
        .from(schema.apiEndpoints)
        .where(eq(schema.apiEndpoints.id, params.endpointId))
        .all();
      if (rows.length === 0) return { error: 'Endpoint not found' };
      const queryParams = db
        .select()
        .from(schema.apiEndpointQueryParams)
        .where(eq(schema.apiEndpointQueryParams.endpointId, params.endpointId))
        .all();
      return { ...rows[0], queryParams };
    },
  });

  registry.register({
    name: 'search_api_traffic',
    description: 'Search captured HTTP traffic for specific URLs or patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'URL search term (SQL LIKE pattern)' },
        method: { type: 'string', description: 'HTTP method filter (e.g. GET, POST)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['search'],
    },
    context: ['api-catalogue'],
    requiredScope: 'core.traffic:read',
    async execute(params: { search: string; method?: string; limit?: number }) {
      const { and } = await import('drizzle-orm');
      const limit = params.limit ?? 20;
      const conditions = [like(schema.capturedTraffic.requestUrl, `%${params.search}%`)];
      if (params.method) {
        conditions.push(eq(schema.capturedTraffic.requestMethod, params.method));
      }
      let query = db
        .select({
          id: schema.capturedTraffic.id,
          requestMethod: schema.capturedTraffic.requestMethod,
          requestUrl: schema.capturedTraffic.requestUrl,
          responseStatus: schema.capturedTraffic.responseStatus,
          capturedAt: schema.capturedTraffic.capturedAt,
        })
        .from(schema.capturedTraffic)
        .orderBy(desc(schema.capturedTraffic.id))
        .limit(limit);
      if (conditions.length === 1) {
        query = query.where(conditions[0]) as typeof query;
      } else if (conditions.length > 1) {
        query = query.where(and(...conditions)) as typeof query;
      }
      return query.all();
    },
  });

  // ── Devices tools ───────────────────────────────────────────────

  registry.register({
    name: 'get_device',
    description: 'Get detailed info about a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
      },
      required: ['deviceId'],
    },
    context: ['devices'],
    requiredScope: 'core.devices:read',
    async execute(params: { deviceId: string }) {
      const rows = db
        .select()
        .from(schema.devices)
        .where(eq(schema.devices.id, params.deviceId))
        .all();
      if (rows.length === 0) return { error: 'Device not found' };
      return rows[0];
    },
  });

  registry.register({
    name: 'get_device_sessions',
    description: 'Get recent automation sessions for a device.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['deviceId'],
    },
    context: ['devices'],
    requiredScope: 'core.devices:read',
    async execute(params: { deviceId: string; limit?: number }) {
      const limit = params.limit ?? 10;
      return db
        .select()
        .from(schema.automationSessions)
        .where(eq(schema.automationSessions.deviceId, params.deviceId))
        .orderBy(desc(schema.automationSessions.startedAt))
        .limit(limit)
        .all();
    },
  });

  registry.register({
    name: 'run_adb_command',
    description: 'Run an ADB shell command on a device. WARNING: This executes commands directly on the device — use with caution.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        command: { type: 'string', description: 'The ADB shell command to run' },
      },
      required: ['deviceId', 'command'],
    },
    context: ['devices'],
    requiredScope: 'core.devices:shell',
    requiresConfirmation: true,
    allowUnattended: false,
    async execute(params: { deviceId: string; command: string }) {
      if (!deviceManager) throw new Error('DeviceManager not wired into AI tools');
      const status = await deviceManager.getDeviceStatus(params.deviceId);
      if (!status) throw new Error('Device not found');
      if (!status.isOnline) throw new Error('Device is offline');
      const output = await deviceManager.executeShellCommand(params.deviceId, params.command);
      return { deviceId: params.deviceId, command: params.command, output };
    },
  });

  // ── Frida & APK Analysis tools ──────────────────────────────────

  // ── Priority 1: Frida Output ──

  registry.register({
    name: 'get_frida_output',
    description: 'Get recent Frida script output/messages from a device with timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        since: { type: 'number', description: 'Only return messages after this timestamp (epoch ms)' },
        limit: { type: 'number', description: 'Max messages to return (default 50)' },
      },
      required: ['deviceId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:read',
    async execute(params: { deviceId: string; since?: number; limit?: number }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      const bridgeParams: Record<string, any> = {};
      if (params.since != null) bridgeParams.since = params.since;
      const data = await callFridaBridge(bridgeManager, params.deviceId, 'frida_get_messages', bridgeParams);
      const messages = Array.isArray(data) ? data : [];
      const limit = params.limit ?? 50;
      return messages.slice(0, limit);
    },
  });

  registry.register({
    name: 'run_frida_and_collect',
    description: 'Run a Frida script on a device and collect output for a specified duration. Spawns the app, waits for messages, then stops Frida and returns all collected output.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        bundleId: { type: 'string', description: 'App bundle/package ID to attach to' },
        code: { type: 'string', description: 'Frida script code to execute' },
        durationMs: { type: 'number', description: 'How long to collect output in ms (default 5000)' },
      },
      required: ['deviceId', 'bundleId', 'code'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    requiresConfirmation: true,
    allowUnattended: false,
    async execute(params: { deviceId: string; bundleId: string; code: string; durationMs?: number }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      const duration = params.durationMs ?? 5000;
      const result = await spawnWaitCollectStop(
        bridgeManager,
        deviceManager,
        params.deviceId,
        { bundle_id: params.bundleId, code: params.code, mode: 'spawn' },
        duration,
      );
      return { messages: result.messages, durationMs: duration, messageCount: result.messages.length };
    },
  });

  // ── Priority 2: Runtime Inspection ──

  registry.register({
    name: 'inspect_runtime_classes',
    description: 'Enumerate loaded Java classes matching a pattern on a running app. Spawns Frida, runs enumeration, and returns matching class names.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        bundleId: { type: 'string', description: 'App bundle/package ID' },
        pattern: { type: 'string', description: 'Substring to match against class names (e.g. "com.example")' },
      },
      required: ['deviceId', 'bundleId', 'pattern'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    requiresConfirmation: true,
    allowUnattended: false,
    async execute(params: { deviceId: string; bundleId: string; pattern: string }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      const escapedPattern = escapeForFridaString(params.pattern);
      const code = `Java.perform(() => { Java.enumerateLoadedClasses({ onMatch(name) { if (name.includes('${escapedPattern}')) send({type:'class', name}); }, onComplete() { send({type:'done'}); }}); });`;
      const result = await spawnWaitCollectStop(
        bridgeManager,
        deviceManager,
        params.deviceId,
        { bundle_id: params.bundleId, code, mode: 'spawn' },
        5000,
      );
      const classes = result.messages
        .filter((m: any) => m?.payload?.type === 'class')
        .map((m: any) => m.payload.name);
      return { classes, total: classes.length };
    },
  });

  registry.register({
    name: 'inspect_class_methods',
    description: 'Get method signatures for a Java class using Frida runtime reflection. Spawns Frida to introspect the class and returns all declared methods.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The device ID' },
        bundleId: { type: 'string', description: 'App bundle/package ID' },
        className: { type: 'string', description: 'Fully-qualified Java class name (e.g. "com.example.MyClass")' },
      },
      required: ['deviceId', 'bundleId', 'className'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    requiresConfirmation: true,
    allowUnattended: false,
    async execute(params: { deviceId: string; bundleId: string; className: string }) {
      if (!bridgeManager) throw new Error('PythonBridgeManager not wired into AI tools');
      const escapedClass = escapeForFridaString(params.className);
      const code = `Java.perform(() => { const cls = Java.use('${escapedClass}'); const methods = cls.class.getDeclaredMethods(); send({methods: methods.map(m => m.toString())}); });`;
      const result = await spawnWaitCollectStop(
        bridgeManager,
        deviceManager,
        params.deviceId,
        { bundle_id: params.bundleId, code, mode: 'spawn' },
        3000,
      );
      const methodMsg = result.messages.find((m: any) => m?.payload?.methods);
      const methods: string[] = methodMsg?.payload?.methods ?? [];
      return { className: params.className, methods, total: methods.length };
    },
  });

  // ── Priority 3: APK Security Analysis ──

  registry.register({
    name: 'detect_ssl_pinning',
    description: 'Analyze an APK for SSL pinning implementations. Checks for OkHttp CertificatePinner, X509TrustManager implementations, network_security_config, and native SSL libraries.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID' },
      },
      required: ['versionId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const detections: { method: string; confidence: string; location: string }[] = [];

        // Check for CertificatePinner (OkHttp)
        const certPinnerFiles = analysisDb.prepare(
          "SELECT path, source FROM files WHERE path LIKE '%CertificatePinner%' OR path LIKE '%certificatePinner%'"
        ).all() as any[];
        for (const f of certPinnerFiles) {
          detections.push({ method: 'OkHttp CertificatePinner', confidence: 'high', location: `${f.path} (${f.source})` });
        }

        // Search file contents for CertificatePinner usage
        const allFiles = analysisDb.prepare('SELECT path, source, content FROM files').all() as any[];
        for (const file of allFiles) {
          let text: string;
          try { text = decompressContent(file.content).toString('utf-8'); } catch { continue; }

          if (text.includes('CertificatePinner') && !certPinnerFiles.some((f: any) => f.path === file.path)) {
            detections.push({ method: 'OkHttp CertificatePinner', confidence: 'high', location: `${file.path} (${file.source})` });
          }
          if (text.includes('X509TrustManager') && text.includes('checkServerTrusted')) {
            detections.push({ method: 'X509TrustManager implementation', confidence: 'high', location: `${file.path} (${file.source})` });
          }
          if (text.includes('network_security_config')) {
            detections.push({ method: 'network_security_config reference', confidence: 'medium', location: `${file.path} (${file.source})` });
          }

          if (detections.length >= 50) break;
        }

        // Check for native SSL libraries
        const nativeLibs = analysisDb.prepare(
          "SELECT path FROM files WHERE (path LIKE '%libsscronet%' OR path LIKE '%libssl%' OR path LIKE '%libcronet%') AND source = 'apktool'"
        ).all() as any[];
        for (const lib of nativeLibs) {
          detections.push({ method: 'Native SSL library', confidence: 'medium', location: lib.path });
        }

        // Check network_security_config.xml directly
        const nscRow = analysisDb.prepare(
          "SELECT content, source FROM files WHERE path LIKE '%network_security_config%' LIMIT 1"
        ).get() as any;
        if (nscRow) {
          let nscText: string;
          try { nscText = decompressContent(nscRow.content).toString('utf-8'); } catch { nscText = ''; }
          const hasPinSet = nscText.includes('<pin-set') || nscText.includes('pin-set');
          detections.push({
            method: 'network_security_config.xml',
            confidence: hasPinSet ? 'high' : 'low',
            location: `network_security_config.xml (${nscRow.source})`,
          });
        }

        return { detections, total: detections.length };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'analyze_network_config',
    description: 'Extract and parse network_security_config.xml from an APK. Returns the raw XML content and structured domain/pinning configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID' },
      },
      required: ['versionId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const row = analysisDb.prepare(
          "SELECT content, path, source FROM files WHERE path LIKE '%network_security_config%' LIMIT 1"
        ).get() as any;
        if (!row) return { error: 'network_security_config.xml not found in APK' };
        let xml: string;
        try { xml = decompressContent(row.content).toString('utf-8'); } catch { return { error: 'Failed to decompress file content' }; }

        // Parse basic structure from XML
        const domains: string[] = [];
        const domainMatches = xml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g);
        for (const m of domainMatches) domains.push(m[1]);

        const hasCleartextPermit = xml.includes('cleartextTrafficPermitted="true"');
        const hasPinSet = xml.includes('<pin-set') || xml.includes('pin-set');
        const hasTrustAnchors = xml.includes('<trust-anchors');
        const hasUserCerts = xml.includes('user') && xml.includes('<certificates');
        const hasSystemCerts = xml.includes('system') && xml.includes('<certificates');

        return {
          xml,
          path: row.path,
          source: row.source,
          analysis: {
            domains,
            cleartextPermitted: hasCleartextPermit,
            hasPinSet,
            hasTrustAnchors,
            hasUserCerts,
            hasSystemCerts,
          },
        };
      } finally { analysisDb.close(); }
    },
  });

  registry.register({
    name: 'find_api_endpoints',
    description: 'Search APK code for API endpoint URLs, Retrofit interfaces, and base URLs. Scans decompiled source for URL patterns and REST annotations.',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'number', description: 'The APK version ID' },
        pattern: { type: 'string', description: 'Additional filter pattern (substring match against found URLs/annotations)' },
      },
      required: ['versionId'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.apk:read',
    async execute(params: { versionId: number; pattern?: string }) {
      const analysisDb = openAnalysisDb(params.versionId);
      if (!analysisDb) return { error: 'Analysis not found for this version' };
      try {
        const files = analysisDb.prepare('SELECT path, source, content FROM files').all() as any[];
        const results: { filePath: string; source: string; line: number; content: string; type: string }[] = [];
        const urlRegex = /https?:\/\/[^\s"'<>)}\]]+/g;
        const retrofitRegex = /@(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(\s*"([^"]+)"/g;
        const baseUrlRegex = /(?:BASE_URL|baseUrl|base_url|API_URL|apiUrl|api_url)\s*[=:]\s*["']([^"']+)["']/g;

        for (const file of files) {
          if (results.length >= 100) break;
          let text: string;
          try { text = decompressContent(file.content).toString('utf-8'); } catch { continue; }
          const lines = text.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= 100) break;
            const line = lines[i];

            // Skip noise URLs
            if (NOISE_URL_PATTERNS.some(p => line.includes(p))) continue;

            // URL matches
            urlRegex.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = urlRegex.exec(line)) !== null) {
              const url = match[0];
              if (params.pattern && !url.includes(params.pattern)) continue;
              if (NOISE_URL_PATTERNS.some(p => url.includes(p))) continue;
              results.push({ filePath: file.path, source: file.source, line: i + 1, content: url, type: 'url' });
            }

            // Retrofit annotations
            retrofitRegex.lastIndex = 0;
            while ((match = retrofitRegex.exec(line)) !== null) {
              const endpoint = `${match[1]} ${match[2]}`;
              if (params.pattern && !endpoint.includes(params.pattern)) continue;
              results.push({ filePath: file.path, source: file.source, line: i + 1, content: endpoint, type: 'retrofit' });
            }

            // Base URL definitions
            baseUrlRegex.lastIndex = 0;
            while ((match = baseUrlRegex.exec(line)) !== null) {
              const baseUrl = match[1];
              if (params.pattern && !baseUrl.includes(params.pattern)) continue;
              results.push({ filePath: file.path, source: file.source, line: i + 1, content: baseUrl, type: 'base_url' });
            }
          }
        }

        // Deduplicate by content
        const seen = new Set<string>();
        const unique = results.filter(r => {
          const key = `${r.type}:${r.content}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        return { endpoints: unique, total: unique.length };
      } finally { analysisDb.close(); }
    },
  });

  // ── Priority 4: Hook Generation ──

  registry.register({
    name: 'generate_frida_hook',
    description: 'Generate a Frida hook script for a specific Java class and method. Supports logging arguments, return values, modifying return values, or bypassing methods.',
    inputSchema: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Fully-qualified Java class name' },
        methodName: { type: 'string', description: 'Method name to hook' },
        action: {
          type: 'string',
          description: 'Hook action: log_args (log all arguments), log_return (log return value), modify_return (replace return value), bypass (return default value)',
          enum: ['log_args', 'log_return', 'modify_return', 'bypass'],
        },
        returnValue: { type: 'string', description: 'Return value for modify_return action (JavaScript expression as string)' },
      },
      required: ['className', 'methodName', 'action'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { className: string; methodName: string; action: 'log_args' | 'log_return' | 'modify_return' | 'bypass'; returnValue?: string }) {
      const cls = escapeForFridaString(params.className);
      const method = escapeForFridaString(params.methodName);
      let hookBody: string;

      switch (params.action) {
        case 'log_args':
          hookBody = [
            `    const args = [];`,
            `    for (let i = 0; i < arguments.length; i++) args.push(arguments[i] ? arguments[i].toString() : null);`,
            `    send({type: 'hook', class: '${cls}', method: '${method}', action: 'log_args', args: args});`,
            `    return this.${method}.apply(this, arguments);`,
          ].join('\n');
          break;
        case 'log_return':
          hookBody = [
            `    const ret = this.${method}.apply(this, arguments);`,
            `    send({type: 'hook', class: '${cls}', method: '${method}', action: 'log_return', returnValue: ret ? ret.toString() : null});`,
            `    return ret;`,
          ].join('\n');
          break;
        case 'modify_return':
          hookBody = [
            `    // Original call (commented out): this.${method}.apply(this, arguments);`,
            `    const modifiedReturn = ${params.returnValue ?? 'null'};`,
            `    send({type: 'hook', class: '${cls}', method: '${method}', action: 'modify_return', returnValue: String(modifiedReturn)});`,
            `    return modifiedReturn;`,
          ].join('\n');
          break;
        case 'bypass':
          hookBody = [
            `    send({type: 'hook', class: '${cls}', method: '${method}', action: 'bypass'});`,
            `    return;`,
          ].join('\n');
          break;
      }

      const script = [
        `Java.perform(() => {`,
        `  const cls = Java.use('${cls}');`,
        `  cls.${method}.implementation = function() {`,
        hookBody,
        `  };`,
        `});`,
      ].join('\n');

      return { script, className: cls, methodName: method, action: params.action };
    },
  });

  registry.register({
    name: 'generate_ssl_bypass',
    description: 'Generate a comprehensive SSL pinning bypass Frida script. Hooks OkHttp3 CertificatePinner, X509TrustManager, HostnameVerifier, and WebViewClient SSL error handler.',
    inputSchema: {
      type: 'object',
      properties: {
        targetMethods: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific methods to target (optional, bypasses all by default). Options: okhttp, trustmanager, hostnameverifier, webview',
        },
      },
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { targetMethods?: string[] }) {
      const targets = params.targetMethods ?? ['okhttp', 'trustmanager', 'hostnameverifier', 'webview'];
      const blocks: string[] = [];

      if (targets.includes('okhttp')) {
        blocks.push([
          `  // OkHttp3 CertificatePinner bypass`,
          `  try {`,
          `    const CertificatePinner = Java.use('okhttp3.CertificatePinner');`,
          `    CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function(hostname, peerCertificates) {`,
          `      send({type: 'ssl_bypass', method: 'OkHttp3.CertificatePinner.check', hostname: hostname});`,
          `      return;`,
          `    };`,
          `    send({type: 'ssl_bypass', status: 'hooked', target: 'OkHttp3 CertificatePinner'});`,
          `  } catch(e) { send({type: 'ssl_bypass', status: 'not_found', target: 'OkHttp3 CertificatePinner', error: e.message}); }`,
        ].join('\n'));
      }

      if (targets.includes('trustmanager')) {
        blocks.push([
          `  // X509TrustManager bypass`,
          `  try {`,
          `    const X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');`,
          `    const SSLContext = Java.use('javax.net.ssl.SSLContext');`,
          `    const TrustManager = Java.registerClass({`,
          `      name: 'com.darkride.BypassTrustManager',`,
          `      implements: [X509TrustManager],`,
          `      methods: {`,
          `        checkClientTrusted(chain, authType) {},`,
          `        checkServerTrusted(chain, authType) {},`,
          `        getAcceptedIssuers() { return []; },`,
          `      },`,
          `    });`,
          `    const ctx = SSLContext.getInstance('TLS');`,
          `    ctx.init(null, [TrustManager.$new()], null);`,
          `    send({type: 'ssl_bypass', status: 'hooked', target: 'X509TrustManager'});`,
          `  } catch(e) { send({type: 'ssl_bypass', status: 'not_found', target: 'X509TrustManager', error: e.message}); }`,
        ].join('\n'));
      }

      if (targets.includes('hostnameverifier')) {
        blocks.push([
          `  // HostnameVerifier bypass`,
          `  try {`,
          `    const HostnameVerifier = Java.use('javax.net.ssl.HostnameVerifier');`,
          `    const HttpsURLConnection = Java.use('javax.net.ssl.HttpsURLConnection');`,
          `    const Verifier = Java.registerClass({`,
          `      name: 'com.darkride.BypassHostnameVerifier',`,
          `      implements: [HostnameVerifier],`,
          `      methods: {`,
          `        verify(hostname, session) { return true; },`,
          `      },`,
          `    });`,
          `    HttpsURLConnection.setDefaultHostnameVerifier(Verifier.$new());`,
          `    send({type: 'ssl_bypass', status: 'hooked', target: 'HostnameVerifier'});`,
          `  } catch(e) { send({type: 'ssl_bypass', status: 'not_found', target: 'HostnameVerifier', error: e.message}); }`,
        ].join('\n'));
      }

      if (targets.includes('webview')) {
        blocks.push([
          `  // WebViewClient SSL error bypass`,
          `  try {`,
          `    const WebViewClient = Java.use('android.webkit.WebViewClient');`,
          `    WebViewClient.onReceivedSslError.implementation = function(view, handler, error) {`,
          `      send({type: 'ssl_bypass', method: 'WebViewClient.onReceivedSslError', url: view.getUrl() ? view.getUrl().toString() : 'unknown'});`,
          `      handler.proceed();`,
          `    };`,
          `    send({type: 'ssl_bypass', status: 'hooked', target: 'WebViewClient'});`,
          `  } catch(e) { send({type: 'ssl_bypass', status: 'not_found', target: 'WebViewClient', error: e.message}); }`,
        ].join('\n'));
      }

      const script = [
        `Java.perform(() => {`,
        blocks.join('\n\n'),
        `});`,
      ].join('\n');

      return { script, targets };
    },
  });

  // ── Priority 5: Network Capture ──

  registry.register({
    name: 'generate_network_capture_script',
    description: 'Generate a Frida script that captures HTTP/HTTPS network requests by hooking OkHttp3 interceptor chain and java.net.URL. Does not require a proxy setup.',
    inputSchema: {
      type: 'object',
      properties: {
        filterDomain: { type: 'string', description: 'Only capture requests to this domain (substring match)' },
        filterMethod: { type: 'string', description: 'Only capture this HTTP method (e.g. GET, POST)' },
        captureBody: { type: 'boolean', description: 'Capture request/response body content (default false)' },
      },
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { filterDomain?: string; filterMethod?: string; captureBody?: boolean }) {
      const domainCheck = params.filterDomain
        ? `\n      if (!url.includes('${escapeForFridaString(params.filterDomain)}')) return chain.proceed(request);`
        : '';
      const methodCheck = params.filterMethod
        ? `\n      if (method !== '${escapeForFridaString(params.filterMethod.toUpperCase())}') return chain.proceed(request);`
        : '';

      const bodyCapture = params.captureBody
        ? [
            ``,
            `      // Capture request body`,
            `      let reqBody = null;`,
            `      try {`,
            `        const requestBody = request.body();`,
            `        if (requestBody) {`,
            `          const buffer = Java.use('okio.Buffer').$new();`,
            `          requestBody.writeTo(buffer);`,
            `          reqBody = buffer.readUtf8();`,
            `        }`,
            `      } catch(e) {}`,
            ``,
            `      // Capture response body`,
            `      let resBody = null;`,
            `      try {`,
            `        const responseBody = response.peekBody(Java.use('java.lang.Long').parseLong('32768'));`,
            `        resBody = responseBody.string();`,
            `      } catch(e) {}`,
          ].join('\n')
        : '';

      const bodyFields = params.captureBody
        ? `, requestBody: reqBody, responseBody: resBody`
        : '';

      const script = [
        `Java.perform(() => {`,
        `  // Hook OkHttp3 Interceptor`,
        `  try {`,
        `    const Interceptor = Java.use('okhttp3.Interceptor');`,
        `    const Builder = Java.use('okhttp3.OkHttpClient$Builder');`,
        `    const DarkRideInterceptor = Java.registerClass({`,
        `      name: 'com.darkride.NetworkInterceptor',`,
        `      implements: [Interceptor],`,
        `      methods: {`,
        `        intercept(chain) {`,
        `          const request = chain.request();`,
        `          const url = request.url().toString();`,
        `          const method = request.method();${domainCheck}${methodCheck}`,
        `          const response = chain.proceed(request);`,
        `          const statusCode = response.code();${bodyCapture}`,
        `          send({type: 'network', url, method, statusCode${bodyFields}});`,
        `          return response;`,
        `        },`,
        `      },`,
        `    });`,
        ``,
        `    // Patch OkHttpClient.Builder to add our interceptor`,
        `    Builder.build.implementation = function() {`,
        `      this.addNetworkInterceptor(DarkRideInterceptor.$new());`,
        `      return this.build.call(this);`,
        `    };`,
        `    send({type: 'network_capture', status: 'hooked', target: 'OkHttp3'});`,
        `  } catch(e) { send({type: 'network_capture', status: 'error', target: 'OkHttp3', error: e.message}); }`,
        ``,
        `  // Hook java.net.URL.openConnection`,
        `  try {`,
        `    const URL = Java.use('java.net.URL');`,
        `    URL.openConnection.overload().implementation = function() {`,
        `      const url = this.toString();`,
        `      send({type: 'network', url, method: 'openConnection', source: 'java.net.URL'});`,
        `      return this.openConnection.call(this);`,
        `    };`,
        `    send({type: 'network_capture', status: 'hooked', target: 'java.net.URL'});`,
        `  } catch(e) { send({type: 'network_capture', status: 'error', target: 'java.net.URL', error: e.message}); }`,
        `});`,
      ].join('\n');

      return { script, filters: { domain: params.filterDomain ?? null, method: params.filterMethod ?? null, captureBody: params.captureBody ?? false } };
    },
  });

  // ── Priority 6: Lifecycle & Templates ──

  registry.register({
    name: 'get_frida_templates',
    description: 'Get template Frida scripts for common use cases: app launch monitoring, network monitoring, crypto operations, storage access, class dumping, or method tracing.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: 'Template name',
          enum: ['app_launch', 'network_monitor', 'crypto_monitor', 'storage_monitor', 'class_dump', 'method_trace'],
        },
      },
      required: ['template'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:read',
    async execute(params: { template: 'app_launch' | 'network_monitor' | 'crypto_monitor' | 'storage_monitor' | 'class_dump' | 'method_trace' }) {
      const templates: Record<string, { description: string; code: string }> = {
        app_launch: {
          description: 'Monitor app launch sequence — tracks Activity lifecycle, ContentProvider init, and Application.onCreate',
          code: [
            `Java.perform(() => {`,
            `  // Track Application.onCreate`,
            `  const Application = Java.use('android.app.Application');`,
            `  Application.onCreate.implementation = function() {`,
            `    send({type: 'lifecycle', event: 'Application.onCreate', class: this.getClass().getName()});`,
            `    this.onCreate();`,
            `  };`,
            ``,
            `  // Track Activity lifecycle`,
            `  const Activity = Java.use('android.app.Activity');`,
            `  Activity.onCreate.overload('android.os.Bundle').implementation = function(bundle) {`,
            `    send({type: 'lifecycle', event: 'Activity.onCreate', activity: this.getClass().getName()});`,
            `    this.onCreate(bundle);`,
            `  };`,
            `  Activity.onResume.implementation = function() {`,
            `    send({type: 'lifecycle', event: 'Activity.onResume', activity: this.getClass().getName()});`,
            `    this.onResume();`,
            `  };`,
            ``,
            `  // Track ContentProvider init`,
            `  const ContentProvider = Java.use('android.content.ContentProvider');`,
            `  ContentProvider.onCreate.implementation = function() {`,
            `    send({type: 'lifecycle', event: 'ContentProvider.onCreate', provider: this.getClass().getName()});`,
            `    return this.onCreate();`,
            `  };`,
            `});`,
          ].join('\n'),
        },
        network_monitor: {
          description: 'Monitor all HTTP/HTTPS network requests via OkHttp3 and java.net.URL',
          code: [
            `Java.perform(() => {`,
            `  try {`,
            `    const Builder = Java.use('okhttp3.OkHttpClient$Builder');`,
            `    const Interceptor = Java.use('okhttp3.Interceptor');`,
            `    const MonitorInterceptor = Java.registerClass({`,
            `      name: 'com.darkride.MonitorInterceptor',`,
            `      implements: [Interceptor],`,
            `      methods: {`,
            `        intercept(chain) {`,
            `          const request = chain.request();`,
            `          const t0 = Date.now();`,
            `          const response = chain.proceed(request);`,
            `          const t1 = Date.now();`,
            `          send({type: 'http', url: request.url().toString(), method: request.method(), status: response.code(), durationMs: t1 - t0});`,
            `          return response;`,
            `        },`,
            `      },`,
            `    });`,
            `    Builder.build.implementation = function() {`,
            `      this.addNetworkInterceptor(MonitorInterceptor.$new());`,
            `      return this.build.call(this);`,
            `    };`,
            `    send({type: 'monitor', status: 'active', target: 'OkHttp3'});`,
            `  } catch(e) { send({type: 'monitor', status: 'error', error: e.message}); }`,
            `});`,
          ].join('\n'),
        },
        crypto_monitor: {
          description: 'Monitor cryptographic operations — Cipher, MessageDigest, Mac, Signature',
          code: [
            `Java.perform(() => {`,
            `  const Cipher = Java.use('javax.crypto.Cipher');`,
            `  Cipher.doFinal.overload('[B').implementation = function(input) {`,
            `    const mode = this.getOpmode ? this.getOpmode() : -1;`,
            `    const algo = this.getAlgorithm();`,
            `    send({type: 'crypto', op: 'Cipher.doFinal', algorithm: algo, mode: mode === 1 ? 'ENCRYPT' : 'DECRYPT', inputLen: input.length});`,
            `    return this.doFinal(input);`,
            `  };`,
            ``,
            `  const MessageDigest = Java.use('java.security.MessageDigest');`,
            `  MessageDigest.digest.overload('[B').implementation = function(input) {`,
            `    send({type: 'crypto', op: 'MessageDigest.digest', algorithm: this.getAlgorithm(), inputLen: input.length});`,
            `    return this.digest(input);`,
            `  };`,
            ``,
            `  const Mac = Java.use('javax.crypto.Mac');`,
            `  Mac.doFinal.overload('[B').implementation = function(input) {`,
            `    send({type: 'crypto', op: 'Mac.doFinal', algorithm: this.getAlgorithm(), inputLen: input.length});`,
            `    return this.doFinal(input);`,
            `  };`,
            ``,
            `  const Signature = Java.use('java.security.Signature');`,
            `  Signature.sign.overload().implementation = function() {`,
            `    send({type: 'crypto', op: 'Signature.sign', algorithm: this.getAlgorithm()});`,
            `    return this.sign();`,
            `  };`,
            ``,
            `  send({type: 'monitor', status: 'active', target: 'crypto'});`,
            `});`,
          ].join('\n'),
        },
        storage_monitor: {
          description: 'Monitor SharedPreferences and SQLite database access',
          code: [
            `Java.perform(() => {`,
            `  // SharedPreferences monitoring`,
            `  const SharedPrefsEditor = Java.use('android.app.SharedPreferencesImpl$EditorImpl');`,
            `  SharedPrefsEditor.putString.implementation = function(key, value) {`,
            `    send({type: 'storage', op: 'SharedPrefs.putString', key: key, value: value ? value.substring(0, 200) : null});`,
            `    return this.putString(key, value);`,
            `  };`,
            `  SharedPrefsEditor.commit.implementation = function() {`,
            `    send({type: 'storage', op: 'SharedPrefs.commit'});`,
            `    return this.commit();`,
            `  };`,
            ``,
            `  // SQLite monitoring`,
            `  const SQLiteDatabase = Java.use('android.database.sqlite.SQLiteDatabase');`,
            `  SQLiteDatabase.execSQL.overload('java.lang.String').implementation = function(sql) {`,
            `    send({type: 'storage', op: 'SQLite.execSQL', sql: sql.substring(0, 500)});`,
            `    return this.execSQL(sql);`,
            `  };`,
            `  SQLiteDatabase.rawQuery.overload('java.lang.String', '[Ljava.lang.String;').implementation = function(sql, args) {`,
            `    send({type: 'storage', op: 'SQLite.rawQuery', sql: sql.substring(0, 500)});`,
            `    return this.rawQuery(sql, args);`,
            `  };`,
            ``,
            `  send({type: 'monitor', status: 'active', target: 'storage'});`,
            `});`,
          ].join('\n'),
        },
        class_dump: {
          description: 'Dump all loaded classes grouped by package prefix',
          code: [
            `Java.perform(() => {`,
            `  const classes = {};`,
            `  Java.enumerateLoadedClasses({`,
            `    onMatch(name) {`,
            `      const parts = name.split('.');`,
            `      const pkg = parts.length > 2 ? parts.slice(0, 3).join('.') : name;`,
            `      if (!classes[pkg]) classes[pkg] = 0;`,
            `      classes[pkg]++;`,
            `    },`,
            `    onComplete() {`,
            `      // Sort by count descending`,
            `      const sorted = Object.entries(classes).sort((a, b) => b[1] - a[1]);`,
            `      send({type: 'class_dump', packages: sorted.slice(0, 100).map(([pkg, count]) => ({pkg, count})), totalPackages: sorted.length});`,
            `    },`,
            `  });`,
            `});`,
          ].join('\n'),
        },
        method_trace: {
          description: 'Trace method calls on a target class — replace TARGET_CLASS with the fully-qualified class name',
          code: [
            `Java.perform(() => {`,
            `  const TARGET_CLASS = 'com.example.TargetClass'; // Replace with actual class`,
            `  const cls = Java.use(TARGET_CLASS);`,
            `  const methods = cls.class.getDeclaredMethods();`,
            `  methods.forEach(m => {`,
            `    const methodName = m.getName();`,
            `    const overloads = cls[methodName].overloads;`,
            `    overloads.forEach(overload => {`,
            `      overload.implementation = function() {`,
            `        const args = [];`,
            `        for (let i = 0; i < arguments.length; i++) {`,
            `          try { args.push(arguments[i] ? arguments[i].toString() : null); }`,
            `          catch(e) { args.push('<error>'); }`,
            `        }`,
            `        send({type: 'trace', class: TARGET_CLASS, method: methodName, args: args});`,
            `        return this[methodName].apply(this, arguments);`,
            `      };`,
            `    });`,
            `  });`,
            `  send({type: 'trace', status: 'active', class: TARGET_CLASS, methodCount: methods.length});`,
            `});`,
          ].join('\n'),
        },
      };

      const tmpl = templates[params.template];
      if (!tmpl) return { error: `Unknown template: ${params.template}. Available: ${Object.keys(templates).join(', ')}` };
      return { template: params.template, description: tmpl.description, script: tmpl.code };
    },
  });

  registry.register({
    name: 'generate_method_trace',
    description: 'Generate a Frida script to trace all method calls on a Java class. Optionally include argument values and Java stack backtraces.',
    inputSchema: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Fully-qualified Java class name to trace' },
        includeArgs: { type: 'boolean', description: 'Include argument values in trace output (default true)' },
        includeBacktrace: { type: 'boolean', description: 'Include Java stack backtrace for each call (default false)' },
      },
      required: ['className'],
    },
    context: ['frida', 'apk-analysis'],
    requiredScope: 'core.frida:manage',
    async execute(params: { className: string; includeArgs?: boolean; includeBacktrace?: boolean }) {
      const cls = escapeForFridaString(params.className);
      const includeArgs = params.includeArgs !== false;
      const includeBacktrace = params.includeBacktrace === true;

      const argCapture = includeArgs
        ? [
            `        const args = [];`,
            `        for (let i = 0; i < arguments.length; i++) {`,
            `          try { args.push(arguments[i] ? arguments[i].toString().substring(0, 200) : null); }`,
            `          catch(e) { args.push('<non-printable>'); }`,
            `        }`,
          ].join('\n')
        : `        const args = '<not captured>';`;

      const backtraceCapture = includeBacktrace
        ? [
            `        let backtrace = null;`,
            `        try {`,
            `          backtrace = Java.use('android.util.Log').getStackTraceString(Java.use('java.lang.Exception').$new());`,
            `          backtrace = backtrace.split('\\n').slice(1, 8).map(l => l.trim()).join(' <- ');`,
            `        } catch(e) {}`,
          ].join('\n')
        : '';

      const backtraceField = includeBacktrace ? `, backtrace` : '';

      const script = [
        `Java.perform(() => {`,
        `  const cls = Java.use('${cls}');`,
        `  const methods = cls.class.getDeclaredMethods();`,
        `  let hookedCount = 0;`,
        `  methods.forEach(m => {`,
        `    const methodName = m.getName();`,
        `    try {`,
        `      const overloads = cls[methodName].overloads;`,
        `      overloads.forEach(overload => {`,
        `        overload.implementation = function() {`,
        argCapture,
        backtraceCapture,
        `          send({type: 'trace', class: '${cls}', method: methodName, args${backtraceField}});`,
        `          return this[methodName].apply(this, arguments);`,
        `        };`,
        `      });`,
        `      hookedCount++;`,
        `    } catch(e) {`,
        `      send({type: 'trace_error', class: '${cls}', method: methodName, error: e.message});`,
        `    }`,
        `  });`,
        `  send({type: 'trace_init', class: '${cls}', hookedMethods: hookedCount, totalMethods: methods.length});`,
        `});`,
      ].join('\n');

      return { script, className: cls, includeArgs, includeBacktrace };
    },
  });

}
