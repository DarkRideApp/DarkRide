/** Selector for matching UI elements via uiautomator2 */
export interface Selector {
  text?: string;
  textContains?: string;
  textStartsWith?: string;
  textMatches?: string;
  resourceId?: string;
  resourceIdMatches?: string;
  className?: string;
  classNameMatches?: string;
  description?: string;
  descriptionContains?: string;
  descriptionMatches?: string;
  clickable?: boolean;
  enabled?: boolean;
  index?: number;
  instance?: number;
}

/** DOM node representation from uiautomator2 UI hierarchy */
export interface DOMNode {
  className: string;
  text: string;
  resourceId: string;
  description: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  enabled: boolean;
  children: DOMNode[];
  source?: 'native' | 'webview';
}

/** Options for GatherDOM */
export interface GatherDOMOptions {
  maxScrollPages?: number; // default 5
}

/** Options for SearchDOM */
export interface SearchDOMOptions {
  dom?: DOMNode;
  maxScrollPages?: number;
}

/** Options for pressButton */
export interface PressButtonOptions {
  timeout?: number;
  longClick?: boolean;
  duration?: number;
}

/** Options for HTTP requests */
export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

/** HTTP response from httpGet/httpPost */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Server-side HTTP helpers exposed to automations as the top-level `http`
 * object. Available regardless of whether the automation has a device
 * attached — requests originate from the DarkRide server, NOT from the
 * device. For requests that should appear in mitmproxy / device traffic,
 * use whatever the app under test does (often nothing the automation
 * does directly).
 *
 * `device.httpGet` and `device.httpPost` are kept as back-compat aliases
 * for this surface — they call the same underlying logic.
 */
export interface HttpAPI {
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  post(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse>;
  put(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse>;
  delete(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  patch(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse>;

  /**
   * Route subsequent `http.*` requests (and any `device.httpGet`/`httpPost`
   * back-compat aliases) through a proxy. Scope is the current automation
   * run only — each run gets its own HttpAPI instance, so state never
   * leaks across automations.
   *
   *  - `'none'`     — clear the proxy, requests go direct.
   *  - `'normal'`   — use the first enabled proxy from the host's proxy list.
   *  - `'nordvpn'`  — SOCKS5 via `<country>.socks.nordhold.net:1080`,
   *                   using NordVPN credentials configured in Settings.
   *                   `options.country` is required.
   */
  setProxy(mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }): Promise<void>;

  /**
   * Apply a TLS fingerprint profile to subsequent `http.*` requests. Same
   * profile names used by mitmproxy's `tls_profile` option for device
   * traffic — server-side requests reuse the same Python TLS-context
   * builder via a per-profile mitmproxy forward proxy.
   *
   *  - `'default'` — no spoofing (clear any previous profile, requests go direct).
   *  - `'chrome'`  — Chrome 120 / Android JA3.
   *  - `'okhttp'`  — OkHttp 4.x / Retrofit JA3.
   *
   * Per-automation: setting a profile on one automation does not affect
   * any other concurrent automation. Spinning a profile up for the first
   * time costs ~1-2s (mitmproxy spawn); subsequent runs using the same
   * profile reuse the warm instance.
   */
  setTlsProfile(profile: 'default' | 'chrome' | 'okhttp'): Promise<void>;
}

/** Device info returned by deviceInfo() */
export interface DeviceInfo {
  serial: string;
  model: string;
  brand: string;
  androidVersion: string;
  sdkVersion: number;
  screenSize: { width: number; height: number };
  batteryLevel: number;
}

/** App info returned by getAppInfo() */
export interface AppInfo {
  packageName: string;
  name: string;
  versionCode: number;
  versionName: string;
  apkPath: string;
}

/** A page inside a debuggable WebView (from Chrome DevTools Protocol) */
export interface WebViewPage {
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/** Info about all debuggable WebView pages on the device */
export interface WebViewInfo {
  pages: WebViewPage[];
}

/** Filter for matching traffic in hooks.
 *  String values match as substrings, RegExp values match as regex. */
export interface TrafficFilter {
  hostname?: string | RegExp;
  path?: string | RegExp;
  method?: string | RegExp;
  url?: string | RegExp;
}

/** Request object passed to traffic hook callbacks */
export interface HookRequestObject {
  guid: string;
  method: string;
  url: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  /** Save this request to the saved traffic store for external querying */
  save: () => Promise<void>;
}

/** Response object passed to traffic hook callbacks */
export interface HookResponseObject {
  guid: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  request: HookRequestObject;
  /** Save this response (with its request) to the saved traffic store for external querying */
  save: () => Promise<void>;
}

/** Callback for intercepting requests */
export type RequestHookCallback = (req: HookRequestObject) => Promise<HookRequestObject | null | void>;

/** Callback for intercepting responses */
export type ResponseHookCallback = (resp: HookResponseObject) => Promise<HookResponseObject | null | void>;

/** HTTP traffic interception API */
export interface DeviceHTTP {
  hook(filter: TrafficFilter, onRequest?: RequestHookCallback, onResponse?: ResponseHookCallback): string;
  hookRequest(filter: TrafficFilter, onRequest: RequestHookCallback): string;
  hookResponse(filter: TrafficFilter, onResponse: ResponseHookCallback): string;
  unhook(hookId: string): void;
  unhookAll(): void;

  /** Create a session-scoped intercept rule (applied in mitmproxy) */
  intercept(options: {
    hostname: string;
    path?: string;
    method?: string;
    phase: 'request' | 'response';
    actions: Array<{ type: string; [key: string]: any }>;
  }): number; // returns rule ID

  /** Register a client certificate for mTLS connections */
  useClientCert(options: {
    hostnames: string[];
    certPath: string;
    keyPath: string;
  }): number; // returns cert ID
}

/** Frida message from an injected script */
export interface FridaMessage {
  type: 'log' | 'send' | 'error';
  level?: 'info' | 'warning' | 'error';
  payload: any;
  timestamp: string;
}

/** Frida instrumentation API */
export interface DeviceFrida {
  /** Spawn app via Frida, inject saved script(s), resume. Full lifecycle. */
  run(bundleId: string, scripts: string | string[]): Promise<void>;
  /** Inject inline JS code into an already-running or freshly-spawned app */
  inject(bundleId: string, code: string): Promise<void>;
  /** Load a saved script by name into the current Frida session */
  loadScript(name: string): Promise<void>;
  /** Get messages from Frida scripts since last call */
  getMessages(): Promise<FridaMessage[]>;
  /** Send a message to scripts' recv() handler */
  send(message: any): Promise<void>;
  /** Detach from all processes, stop frida-server */
  stop(): Promise<void>;
}

/** The DeviceAPI available to automations */
export interface DeviceAPI {
  // Core element interactions
  click(selector: Selector, timeout?: number): Promise<void>;
  longClick(selector: Selector, duration?: number, timeout?: number): Promise<void>;
  setText(selector: Selector, text: string, timeout?: number): Promise<void>;
  getText(selector: Selector, timeout?: number): Promise<string>;
  exists(selector: Selector, timeout?: number): Promise<boolean>;
  waitFor(selector: Selector, timeout: number): Promise<void>;
  waitForAndClick(selector: Selector, timeout?: number): Promise<void>;
  existsAny(selectors: Selector[], timeout?: number): Promise<Selector | null>;
  clickAny(selectors: Selector[], timeout?: number): Promise<boolean>;

  // Scrolling
  scroll(direction: 'up' | 'down' | 'left' | 'right', percent?: number): Promise<void>;
  scrollToElement(selector: Selector, maxScrolls?: number): Promise<void>;

  // DOM / Screen
  getDOM(timeout?: number): Promise<DOMNode>;
  updateDOM(): Promise<DOMNode>;
  screenshot(name?: string): Promise<string>;
  getAppInfo(packageName: string): Promise<AppInfo>;

  // App lifecycle
  startApp(packageName: string, activity?: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;

  // Input
  pressKey(key: string): Promise<void>;
  swipe(startX: number, startY: number, endX: number, endY: number, duration?: number): Promise<void>;
  tapAt(x: number, y: number): Promise<void>;

  // Device
  deviceInfo(): Promise<DeviceInfo>;
  getCurrentAppId(): Promise<string>;
  getWebViewInfo(): Promise<WebViewInfo>;

  // Higher-level helpers
  pressButton(selector: Selector, options?: PressButtonOptions): Promise<void>;
  gatherDOM(options?: GatherDOMOptions): Promise<DOMNode>;
  searchDOM(selector: Selector, options?: SearchDOMOptions): Promise<DOMNode[]>;

  // HTTP helpers
  httpGet(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  httpPost(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse>;

  // Credentials
  getCredentials(appId: string): Promise<{ username: string; password: string; customFields: Record<string, string> }>;

  // Proxy
  setProxy(mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }): Promise<void>;

  // TLS profile
  setTlsProfile(profile: 'chrome' | 'okhttp' | 'default'): Promise<void>;

  // Traffic hooks
  readonly http: DeviceHTTP;

  // Frida instrumentation
  readonly frida: DeviceFrida;

  // Utilities
  sleep(ms: number): Promise<void>;
}

/** A single entry in the execution log captured during automation runs */
export interface ExecutionLogEntry {
  timestamp: string;
  method: string;
  params: Record<string, any>;
  result?: any;
  error?: string;
  durationMs: number;
  domSnapshot?: string;        // JSON-stringified DOMNode, only for DOM-query methods
  selector?: Selector;         // only for element-query methods
  screenshotFilename?: string; // only for screenshot()
}

/** DOM utility functions available in automation sandbox as `dom` */
export interface DOMUtils {
  /** Recursive DFS — returns all nodes matching the predicate */
  findAll(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode[];
  /** Returns first node matching the predicate, or null */
  find(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode | null;
  /** Flatten tree to array (includes root) */
  flatten(root: DOMNode): DOMNode[];
  /** Typed convenience wrapper over Array.filter */
  filter(nodes: DOMNode[], predicate: (node: DOMNode) => boolean): DOMNode[];
  /** Center point of the node's bounds */
  getCenter(node: DOMNode): { x: number; y: number };
  /** Size of the node's bounds */
  getSize(node: DOMNode): { width: number; height: number };
  /** Recursively collects non-empty text and description values */
  getAllText(root: DOMNode): string[];
}

/** Bridge error codes from Python bridge JSON-RPC */
export enum BridgeErrorCode {
  ELEMENT_NOT_FOUND = -32001,
  TIMEOUT = -32002,
  DEVICE_DISCONNECTED = -32003,
  APP_NOT_INSTALLED = -32004,
  PERMISSION_DENIED = -32005,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,

  // Frida errors
  FRIDA_NOT_AVAILABLE = -32010,
  FRIDA_SERVER_NOT_RUNNING = -32011,
  FRIDA_SPAWN_FAILED = -32012,
  FRIDA_ATTACH_FAILED = -32013,
  FRIDA_SCRIPT_ERROR = -32014,
}

/** Document store API for automation scripts */
export interface DocumentStore {
  getDoc(docId: string): Promise<any>;
  putDoc(docId: string, doc: any): Promise<any>;
}

/** Global `dom` utility available in automation scripts */
export declare const dom: DOMUtils;
/** Global `device` available in automation scripts */
export declare const device: DeviceAPI;
/** Global `documentStore` available in automation scripts */
export declare const documentStore: DocumentStore;
/**
 * Global `tools` object available in automation scripts and plugin-defined triggers.
 * Keyed by registered tool name (e.g. `tools.my_plugin_action(params)`).
 * Provided by plugins via `ctx.tools([...])`.
 */
export declare const tools: Record<string, (params: any) => Promise<any>>;
