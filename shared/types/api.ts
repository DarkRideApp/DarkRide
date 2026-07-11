// ---- Proxy types ----

export interface Proxy {
  id: number;
  url: string;
  username: string | null;
  password: string | null;
  failureCount: number;
  enabled: boolean;
  createdAt: string;
}

export interface CreateProxyRequest {
  url: string;
  username?: string;
  password?: string;
}

export interface UpdateProxyRequest {
  url?: string;
  username?: string;
  password?: string;
  enabled?: boolean;
}

// ---- Device constants ----

export const CURRENT_SETUP_VERSION = 4;

// ---- Device types ----

export type DevicePlatform = 'android' | 'ios';

export interface Device {
  id: string;
  name: string | null;
  platform: DevicePlatform;
  isRooted: boolean;
  setupVersion: number;
  bridgePort: number | null;
  lastSeen: string | null;
  isOnline: boolean;
  isBusy: boolean;
  batteryLevel: number | null;
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  iosVersion: string | null;
  apiLevel: number | null;
  cpuAbi: string | null;
  serialNumber: string | null;
  bootloaderLocked: boolean | null;
  // Extended iOS device info (Phase 1.5)
  wifiAddress?: string | null;
  wifiSsid?: string | null;
  bluetoothAddress?: string | null;
  phoneNumber?: string | null;
}

export interface UpdateDeviceRequest {
  name?: string;
  isRooted?: boolean;
  setupVersion?: number;
}

// ---- Schedule types ----

export interface CronSchedule { type: 'cron'; expressions: string[] }
export interface IntervalSchedule { type: 'interval'; intervalMs: number }
export interface WindowedIntervalSchedule {
  type: 'windowed_interval';
  intervalMinutes: number;
  windowStart: string; // "HH:MM"
  windowEnd: string;   // "HH:MM" — if earlier than windowStart, window wraps midnight
}
export type ScheduleConfig = CronSchedule | IntervalSchedule | WindowedIntervalSchedule;

// ---- Device filter types ----

export interface DeviceFilterRule {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: any;
}

export interface DeviceFilter {
  rules: DeviceFilterRule[];
  deviceIds?: string[];
}

export interface FilterableField {
  field: string;
  label: string;
  type: 'boolean' | 'number' | 'string';
  operators: DeviceFilterRule['operator'][];
}

export const DEVICE_FILTERABLE_FIELDS: FilterableField[] = [
  { field: 'isRooted',          label: 'Rooted',            type: 'boolean', operators: ['eq'] },
  { field: 'bootloaderLocked',  label: 'Bootloader locked', type: 'boolean', operators: ['eq'] },
  { field: 'platform',          label: 'Platform',          type: 'string',  operators: ['eq', 'neq'] },
  { field: 'manufacturer',      label: 'Manufacturer',      type: 'string',  operators: ['eq', 'neq', 'contains'] },
  { field: 'model',             label: 'Model',             type: 'string',  operators: ['eq', 'neq', 'contains'] },
  { field: 'androidVersion',    label: 'Android version',   type: 'string',  operators: ['eq', 'neq'] },
  { field: 'apiLevel',          label: 'API level',         type: 'number',  operators: ['eq', 'gte', 'lte', 'gt', 'lt'] },
  { field: 'cpuAbi',            label: 'CPU ABI',           type: 'string',  operators: ['eq'] },
  { field: 'batteryLevel',      label: 'Battery level',     type: 'number',  operators: ['gte', 'lte', 'gt', 'lt'] },
];

// ---- Automation types ----

export interface Automation {
  id: number;
  name: string;
  code: string;
  passcode: string;
  requiresDevice: boolean;
  requiresHttpsCapture: boolean;
  timeoutMs: number;
  isRule: boolean;
  isCaptureRule: boolean;
  priority: number;
  enabled: boolean;
  schedule: string | null;
  deviceFilter: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutomationRequest {
  name: string;
  code: string;
  requiresHttpsCapture?: boolean;
  timeoutMs?: number;
  isRule?: boolean;
  isCaptureRule?: boolean;
  priority?: number;
  enabled?: boolean;
  schedule?: ScheduleConfig;
  deviceFilter?: DeviceFilter;
}

export interface UpdateAutomationRequest {
  name?: string;
  code?: string;
  requiresHttpsCapture?: boolean;
  timeoutMs?: number;
  isRule?: boolean;
  isCaptureRule?: boolean;
  priority?: number;
  enabled?: boolean;
  schedule?: ScheduleConfig | null;
  deviceFilter?: DeviceFilter | null;
}

export interface RunAutomationRequest {
  deviceId?: string;
  triggerType?: 'manual' | 'schedule' | 'api';
}

// ---- Automation Session types ----

export type SessionStatus = 'running' | 'success' | 'failed' | 'cancelled';
export type TriggerType = 'manual' | 'schedule' | 'api' | 'capture';

export interface AutomationSession {
  id: number;
  automationId: number | null;
  deviceId: string | null;
  name: string | null;
  isPinned: boolean;
  notes: string | null;
  status: SessionStatus;
  triggerType: TriggerType;
  logs: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface SessionListQuery {
  automationId?: number;
  deviceId?: string;
  status?: SessionStatus;
  triggerType?: TriggerType;
  limit?: number;
  offset?: number;
}

// ---- Traffic types ----

/**
 * Per-request timing breakdown (all values in milliseconds, best-effort).
 * Each segment is null when it can't be derived from the mitmproxy flow
 * (e.g. reused keep-alive connections have no TCP/TLS setup timing; DNS
 * resolution timing is never exposed by mitmproxy).
 */
export interface TrafficTimings {
  dns: number | null;
  connect: number | null;
  tls: number | null;
  ttfb: number | null;
  download: number | null;
}

export interface CapturedTrafficEntry {
  id: number;
  sessionId: number | null;
  deviceId: string | null;
  requestMethod: string;
  requestUrl: string;
  requestHeaders: string | null;
  requestBody: string | null;
  responseStatus: number | null;
  responseHeaders: string | null;
  responseBody: string | null;
  type?: string;
  wsCloseCode?: number | null;
  wsCloseReason?: string | null;
  wsMessageCount?: number | null;
  capturedAt: string;
  matchedRules?: Array<{ id: number; name: string; phase: string; actionsApplied: string[] }> | null;
  responseContentType?: string | null;
  hasImage?: boolean;
  /** End-to-end latency in ms (request start → response end). Null for synthetic/DNS/TLS-fail entries. */
  durationMs?: number | null;
  /** Timing breakdown JSON. Stored as text in the DB; parsed to TrafficTimings on read. */
  timings?: TrafficTimings | string | null;
}

export interface WebSocketMessageEntry {
  id: number;
  trafficId: number | null;
  sessionId: number | null;
  deviceId: string | null;
  direction: 'send' | 'receive';
  opcode: 'text' | 'binary' | 'close';
  payload: string | null;
  isBinary: boolean;
  payloadSize: number;
  timestamp: string;
}

export interface TrafficListQuery {
  deviceId?: string;
  sessionId?: number;
  hostname?: string;
  method?: string;
  statusCode?: number;
  type?: string;
  limit?: number;
  offset?: number;
}

// ---- Capture types ----

export interface StartCaptureRequest {
  deviceId: string;
  tlsProfile?: 'chrome' | 'okhttp' | 'default';
}

export interface StartCaptureResponse {
  sessionId: number;
}

export interface StopCaptureRequest {
  deviceId: string;
}

export interface CaptureStatus {
  capturing: boolean;
  sessionId?: number;
}

// ---- Blocked domain types ----

export interface BlockedDomain {
  id: number;
  domain: string;
  createdAt: string;
}

// ---- Hidden domain types ----

export interface HiddenDomain {
  id: number;
  domain: string;
  createdAt: string;
}

// ---- Credential types ----

export interface Credential {
  id: number;
  appId: string;
  username: string;
  password: string;
  customFields: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface CreateCredentialRequest {
  appId: string;
  username: string;
  password: string;
  customFields?: Record<string, string>;
}

export interface UpdateCredentialRequest {
  appId?: string;
  username?: string;
  password?: string;
  customFields?: Record<string, string> | null;
}

// ---- Setting types ----

export interface Setting {
  key: string;
  value: string;
}

// ---- Screenshot types ----

export interface Screenshot {
  id: number;
  sessionId: number | null;
  filename: string;
  name: string | null;
  domSnapshot: string | null;
  capturedAt: string;
}

// ---- Analysis Job types ----

export type AnalysisJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AnalysisJob {
  id: number;
  apkVersionId: number;
  status: AnalysisJobStatus;
  stage: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AnalysisMetadata {
  appName: string | null;
  packageName: string | null;
  icon: boolean;
  minSdk: number | null;
  targetSdk: number | null;
  permissions: string[];
}

// ---- Proxied request types ----

export type ProxySource =
  | { type: 'proxyId'; proxyId: number }
  | { type: 'nordvpn'; country: string }
  | { type: 'inline'; url: string }
  | { type: 'direct' };

export interface ProxiedHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  proxy: ProxySource;
}

export interface ProxiedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  bodyBase64?: string | null;
  url: string;
  timingMs: number;
  proxyUsed: string;
}

export type ProxiedJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ProxiedJob {
  id: string;
  status: ProxiedJobStatus;
  createdAt: string;
  completedAt: string | null;
  result: ProxiedHttpResponse | null;
  error: string | null;
}

// ---- Generic API response types ----

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
