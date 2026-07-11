import type {
  AiChatSendMessage,
  AiChatCancelMessage,
  AiServerEvent,
} from './ai-chat';

/** Generic WebSocket request from client */
export interface WebSocketRequest {
  action: string;
  [key: string]: any;
}

/** REST API request tunneled over WebSocket */
export interface RestApiRequest {
  action: 'restapi';
  method: string;
  path: string;
  body?: any;
  id: string;
}

/** REST API response sent back over WebSocket */
export interface RestApiResponse {
  type: 'restapi';
  id: string;
  status: number;
  body: any;
}

/** Live log message streamed to client */
export interface LiveLogMessage {
  type: 'livelog';
  system: string;
  datetime: string;
  severity: 'log' | 'error' | 'warn' | 'debug';
  message: string;
  file: string;
  line: number;
}

/** Automation validation result */
export interface ValidationResult {
  type: 'validation-result';
  automationId: number;
  errors: ValidationError[];
  success: boolean;
  timestamp: string;
}

export interface ValidationError {
  line: number;
  column: number;
  message: string;
  severity: number; // 0=warning, 1=error, 2=suggestion
}

/** Device live stream frame */
export interface DeviceStreamFrame {
  type: 'device-frame';
  deviceId: string;
  frame: string; // base64-encoded JPEG
  timestamp: number;
}

/** Device stream control messages */
export interface DeviceStreamStart {
  action: 'device-stream-start';
  deviceId: string;
}

export interface DeviceStreamStop {
  action: 'device-stream-stop';
  deviceId: string;
}

/** Device touch input sent from client */
export interface DeviceTouchInput {
  action: 'device-touch';
  deviceId: string;
  eventType: 'down' | 'move' | 'up';
  x: number;
  y: number;
}

/** Device key input sent from client */
export interface DeviceKeyInput {
  action: 'device-key';
  deviceId: string;
  key: string;
}

/** Device swipe/drag input sent from client */
export interface DeviceSwipeInput {
  action: 'device-swipe';
  deviceId: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs?: number;
}

/** Device navigation button input sent from client */
export interface DeviceNavInput {
  action: 'device-nav';
  deviceId: string;
  button: 'back' | 'home' | 'recents' | 'power' | 'wake' | 'sleep';
}

/** Traffic entry broadcast to clients in real-time */
export interface TrafficEntryMessage {
  type: 'traffic-entry';
  entry: {
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
    trafficType?: string;
    wsMessageCount?: number;
    capturedAt: string;
    flowId?: string;
    matchedRules?: any[];
    responseContentType?: string | null;
    hasImage?: boolean;
  };
}

/** Pending request notification — broadcast when a request starts */
export interface TrafficRequestStartedMessage {
  type: 'traffic-request-started';
  flowId: string;
  deviceId: string | null;
  sessionId: number | null;
  requestMethod: string;
  requestUrl: string;
  requestHeaders: string | null;
  timestamp: string;
}

/** WebSocket frame broadcast to clients in real-time */
export interface WebSocketFrameMessage {
  type: 'ws-frame';
  trafficId: number;
  frame: {
    id: number;
    direction: 'send' | 'receive';
    opcode: 'text' | 'binary' | 'close';
    payload: string | null;
    isBinary: boolean;
    payloadSize: number;
    timestamp: string;
  };
}

/** WebSocket connection closed broadcast */
export interface WebSocketConnectionClosedMessage {
  type: 'ws-connection-closed';
  trafficId: number;
  closeCode: number | null;
  closeReason: string | null;
  messageCount: number;
}

// ---- Interactive intercept ("breakpoints") ----
// Separate from the rule-based Intercept feature. These messages keep every
// connected UI in sync about flows paused in-flight awaiting a manual verdict.

/** A flow paused in-flight, awaiting a manual resolve. */
export interface HeldFlow {
  flowId: string;
  phase: 'request' | 'response';
  deviceId: string | null;
  sessionId: number | null;
  method: string;
  url: string;
  /** Header object (request headers in request phase, response headers in response phase). */
  headers: Record<string, string>;
  /** Body text (request body in request phase, response body in response phase). May be a truncation marker. */
  body: string | null;
  /** Present in response phase only. */
  statusCode?: number | null;
  /** ms since epoch when the flow was held. */
  createdAt: number;
}

/** Armed configuration for interactive interception. */
export interface InterceptArmedConfig {
  enabled: boolean;
  matchHostname?: string | null;
  matchPath?: string | null;
  matchMethod?: string | null;
  phases: ('request' | 'response')[];
}

/** Broadcast when a flow is paused in-flight and needs a manual verdict. */
export interface InterceptHeldMessage {
  type: 'intercept-held';
  flowId: string;
  phase: 'request' | 'response';
  flow: HeldFlow;
}

/** Broadcast when a held flow is resolved (by a user, a timeout, or capture stop). */
export interface InterceptResolvedMessage {
  type: 'intercept-resolved';
  flowId: string;
  action: 'forward' | 'drop';
}

/** Broadcast when the armed config changes so every UI reflects the same state. */
export interface InterceptArmedChangedMessage {
  type: 'intercept-armed-changed';
  config: InterceptArmedConfig;
}

/** Per-subsystem status during capture startup */
export interface CaptureSubsystemStatus {
  mitmproxy: 'pending' | 'ok' | 'error';
  certInjection: 'pending' | 'ok' | 'error' | 'skipped';
  wireguard: 'pending' | 'ok' | 'error' | 'skipped';
  connectivity: 'pending' | 'ok' | 'warning' | 'skipped';
}

/** Capture session status update */
export interface CaptureStatusMessage {
  type: 'capture-status';
  deviceId: string;
  status: 'capturing' | 'stopped' | 'error';
  sessionId?: number;
  error?: string;
  subsystems?: CaptureSubsystemStatus;
}

/** Automation session status update */
export interface SessionStatusUpdate {
  type: 'session-status';
  sessionId: number;
  automationId?: number;
  deviceId?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  triggerType?: 'manual' | 'schedule' | 'api' | 'capture';
  completedAt?: string;
}

/** Automation live log during execution */
export interface AutomationLogMessage {
  type: 'automation-log';
  sessionId: number;
  line: number; // line of code being executed
  message: string;
  timestamp: string;
}

/** Live log subscription request */
export interface LiveLogSubscribe {
  action: 'livelog/subscribe';
  systemId?: string; // filter by system, omit for all
}

/** Live log unsubscribe request */
export interface LiveLogUnsubscribe {
  action: 'livelog/unsubscribe';
}

/** Validate automation request over WebSocket */
export interface ValidateAutomationRequest {
  action: 'validate-automation';
  code: string;
  automationId: number;
}

/** ADB shell start request */
export interface AdbShellStart {
  action: 'adb-shell/start';
  deviceId: string;
  cols?: number;
  rows?: number;
}

/** ADB shell input from client */
export interface AdbShellInput {
  action: 'adb-shell/input';
  data: string;
}

/** ADB shell resize request */
export interface AdbShellResize {
  action: 'adb-shell/resize';
  cols: number;
  rows: number;
}

/** ADB shell stop request */
export interface AdbShellStop {
  action: 'adb-shell/stop';
}

/** ADB shell session started */
export interface AdbShellStartedMessage {
  type: 'adb-shell/started';
  deviceId: string;
}

/** ADB shell output data */
export interface AdbShellOutputMessage {
  type: 'adb-shell/output';
  deviceId: string;
  data: string;
}

/** ADB shell session exited */
export interface AdbShellExitMessage {
  type: 'adb-shell/exit';
  deviceId: string;
  exitCode: number;
}

/** Union of all client → server WebSocket messages */
export type ClientMessage =
  | RestApiRequest
  | DeviceStreamStart
  | DeviceStreamStop
  | DeviceTouchInput
  | DeviceKeyInput
  | DeviceSwipeInput
  | DeviceNavInput
  | LiveLogSubscribe
  | LiveLogUnsubscribe
  | ValidateAutomationRequest
  | AdbShellStart
  | AdbShellInput
  | AdbShellResize
  | AdbShellStop
  | AiChatSendMessage
  | AiChatCancelMessage
  | IosSyslogStart
  | IosSyslogStop
  | WebSocketRequest;

/** Proxied request queued */
export interface ProxiedRequestQueuedMessage {
  type: 'proxied-request-queued';
  id: string;
  url: string;
  method: string;
  proxyType: string;
  proxyLabel: string;
  createdAt: string;
}

/** Proxied request started executing */
export interface ProxiedRequestStartedMessage {
  type: 'proxied-request-started';
  id: string;
  startedAt: string;
}

/** Proxied request completed successfully */
export interface ProxiedRequestCompletedMessage {
  type: 'proxied-request-completed';
  id: string;
  status: number;
  timingMs: number;
  responseSize: number;
  proxyUsed: string;
  completedAt: string;
}

/** Proxied request failed */
export interface ProxiedRequestFailedMessage {
  type: 'proxied-request-failed';
  id: string;
  error: string;
  completedAt: string;
}

/** iOS syslog entry */
export interface IosSyslogEntry {
  timestamp: string;
  pid: number;
  process: string;
  level: string;
  message: string;
  subsystem: string;
  category: string;
}

/** iOS syslog entries broadcast to clients in real-time */
export interface IosSyslogMessage {
  type: 'ios-syslog';
  deviceId: string;
  entries: IosSyslogEntry[];
}

/** iOS syslog stream started confirmation */
export interface IosSyslogStartedMessage {
  type: 'ios-syslog-started';
  deviceId: string;
}

/** iOS syslog stream stopped */
export interface IosSyslogStoppedMessage {
  type: 'ios-syslog-stopped';
  deviceId: string;
}

/** Client action to start iOS syslog */
export interface IosSyslogStart {
  action: 'ios-syslog/start';
  deviceId: string;
}

/** Client action to stop iOS syslog */
export interface IosSyslogStop {
  action: 'ios-syslog/stop';
  deviceId: string;
}

/** Warning that a busy device is approaching forced idle */
export interface BusyTimeoutWarningMessage {
  type: 'busy-timeout-warning';
  deviceId: string;
  remainingSeconds: number;
}

/** APK version pulled by tracker */
export interface ApkVersionPulledMessage {
  type: 'apk:version-pulled';
  trackedAppId: number;
  packageName: string;
  versionCode: number;
  versionName: string | null;
  source?: 'device' | 'playstore' | 'upload';
}

/** APK scan cycle complete */
export interface ApkScanCompleteMessage {
  type: 'apk:scan-complete';
  newVersions: number;
}

/** APK analysis notes updated */
export interface ApkNotesUpdatedMessage {
  type: 'apk:notes-updated';
  versionId: number;
  notes: string;
}

/** APK analysis AI agent status update */
export interface ApkAiAgentUpdateMessage {
  type: 'apk:ai-agent-update';
  versionId: number;
  status: 'running' | 'completed' | 'failed';
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** APK diff analysis status update */
export interface ApkDiffUpdateMessage {
  type: 'apk:diff-update';
  versionId: number;
  reportId: number;
  status: 'running' | 'completed' | 'failed';
  contextPercent?: number;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Server startup progress message */
export interface StartupProgressMessage {
  type: 'startup-progress';
  phase: 'initializing' | 'preparing_python' | 'starting_services' | 'ready';
  message: string;
}

/** APK analysis job status update */
export interface AnalysisUpdateMessage {
  type: 'apk:analysis-update';
  jobId: number;
  apkVersionId: number;
  packageName: string;
  status: 'running' | 'completed' | 'failed';
  stage: string | null; // 'metadata' | 'decompiling' | 'storing' | 'scanning' | 'done'
  progress: number | null; // 0-100 percentage within current stage
  error: string | null;
  result: {
    appName: string | null;
    icon: boolean;
  } | null;
}

// Plugin-specific WebSocket message types are defined by the plugin itself;
// the core's ServerMessage union only enumerates the host's own message
// types. Subscribers to plugin-defined channels widen the type at the
// call site.

/** Union of all server → client WebSocket messages emitted by the core. */
export type ServerMessage =
  | RestApiResponse
  | LiveLogMessage
  | ValidationResult
  | DeviceStreamFrame
  | SessionStatusUpdate
  | AutomationLogMessage
  | TrafficEntryMessage
  | TrafficRequestStartedMessage
  | CaptureStatusMessage
  | WebSocketFrameMessage
  | WebSocketConnectionClosedMessage
  | ProxiedRequestQueuedMessage
  | ProxiedRequestStartedMessage
  | ProxiedRequestCompletedMessage
  | ProxiedRequestFailedMessage
  | BusyTimeoutWarningMessage
  | AnalysisUpdateMessage
  | StartupProgressMessage
  | ApkVersionPulledMessage
  | ApkScanCompleteMessage
  | ApkNotesUpdatedMessage
  | ApkAiAgentUpdateMessage
  | ApkDiffUpdateMessage
  | AdbShellStartedMessage
  | AdbShellOutputMessage
  | AdbShellExitMessage
  | InterceptHeldMessage
  | InterceptResolvedMessage
  | InterceptArmedChangedMessage
  | AiServerEvent;
