import type { SchemaField } from '@darkrideapp/plugin-sdk';

/**
 * Schemas for the core backend lifecycle events, so every real HookBus event is
 * define()'d (and therefore visible in the AI Pipelines event picker) regardless of
 * which service happens to emit it. Shared rather than duplicated per-emitter so two
 * services emitting the same event name (e.g. session:created) can't drift apart.
 */

export const SESSION_CREATED_SCHEMA: SchemaField[] = [
  { field: 'sessionId', type: 'number', description: 'The new session row id.' },
  { field: 'deviceId', type: 'string', description: 'Device serial/id the session runs against.' },
  { field: 'triggerType', type: 'string', description: "How the session started: 'capture' | 'manual' | 'schedule' | 'api'." },
];

export const AUTOMATION_STARTED_SCHEMA: SchemaField[] = [
  { field: 'sessionId', type: 'number', description: "The session row id backing this automation run." },
  { field: 'automationId', type: 'number', description: 'Which automation is running.' },
  { field: 'deviceId', type: 'string', description: 'Device the automation targets, if any.' },
  { field: 'triggerType', type: 'string', description: "'manual' | 'schedule' | 'api' | 'capture'." },
];

export const AUTOMATION_COMPLETED_SCHEMA: SchemaField[] = [
  { field: 'sessionId', type: 'number', description: "The session row id backing this automation run." },
  { field: 'automationId', type: 'number', description: 'Which automation ran.' },
  { field: 'deviceId', type: 'string', description: 'Device the automation targeted, if any.' },
  { field: 'success', type: 'boolean', description: 'Whether the run completed without error.' },
  { field: 'error', type: 'string', description: 'Present only when success is false.' },
];

export const DEVICE_CONNECTED_SCHEMA: SchemaField[] = [
  { field: 'id', type: 'string', description: 'Device serial/id.' },
  { field: 'platform', type: 'string', description: "The device's platform — 'android' today." },
];

export const DEVICE_DISCONNECTED_SCHEMA: SchemaField[] = DEVICE_CONNECTED_SCHEMA;

export const APP_STARTUP_SCHEMA: SchemaField[] = [];

export const APP_SHUTDOWN_SCHEMA: SchemaField[] = [];
