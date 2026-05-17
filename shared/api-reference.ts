/** Single source of truth for all automation API documentation */

export interface ApiEntry {
  name: string;
  object: string;
  signature: string;
  description: string;
  example: string;
  category: string;
}

export const CATEGORY_LABELS: Record<string, string> = {
  maps: 'Map Tile Archiving',
  elements: 'Finding & Clicking Elements',
  waiting: 'Waiting & Checking',
  text: 'Text Input & Reading',
  scrolling: 'Scrolling',
  gestures: 'Gestures & Keys',
  apps: 'App Lifecycle',
  dom: 'DOM & Screen',
  device: 'Device Info',
  'http-requests': 'HTTP Requests',
  'http-hooks': 'Traffic Hooks',
  proxy: 'Proxy & TLS',
  credentials: 'Credentials',
  frida: 'Frida Instrumentation',
  'dom-utils': 'DOM Utilities',
  utilities: 'Utilities',
};

export const CATEGORY_ORDER = [
  'elements',
  'maps',
  'waiting',
  'text',
  'scrolling',
  'gestures',
  'apps',
  'dom',
  'device',
  'http-requests',
  'http-hooks',
  'proxy',
  'credentials',
  'frida',
  'dom-utils',
  'utilities',
];

export const API_REFERENCE: ApiEntry[] = [
  // --- elements ---
  {
    name: 'click',
    object: 'device',
    signature: 'click(selector: Selector, timeout?: number): Promise<void>',
    description: 'Click a UI element matching the selector.',
    example: "await device.click({ text: 'Sign In' });",
    category: 'elements',
  },
  {
    name: 'longClick',
    object: 'device',
    signature: 'longClick(selector: Selector, duration?: number, timeout?: number): Promise<void>',
    description: 'Long-press a UI element. Duration in ms (default 1000).',
    example: "await device.longClick({ text: 'Item' }, 1000);",
    category: 'elements',
  },
  {
    name: 'pressButton',
    object: 'device',
    signature: 'pressButton(selector: Selector, options?: PressButtonOptions): Promise<void>',
    description: 'Scroll to an element then click it. Supports longClick and custom timeout.',
    example: "await device.pressButton({ text: 'Submit' });",
    category: 'elements',
  },

  // --- waiting ---
  {
    name: 'waitFor',
    object: 'device',
    signature: 'waitFor(selector: Selector, timeout: number): Promise<void>',
    description: 'Wait until an element matching the selector appears on screen.',
    example: "await device.waitFor({ text: 'Home' }, 10000);",
    category: 'waiting',
  },
  {
    name: 'waitForAndClick',
    object: 'device',
    signature: 'waitForAndClick(selector: Selector, timeout?: number): Promise<void>',
    description: 'Wait for an element to appear, then click it.',
    example: "await device.waitForAndClick({ text: 'OK' });",
    category: 'waiting',
  },
  {
    name: 'exists',
    object: 'device',
    signature: 'exists(selector: Selector, timeout?: number): Promise<boolean>',
    description: 'Check whether an element matching the selector exists on screen.',
    example: "if (await device.exists({ text: 'Error' })) { ... }",
    category: 'waiting',
  },

  // --- text ---
  {
    name: 'setText',
    object: 'device',
    signature: 'setText(selector: Selector, text: string, timeout?: number): Promise<void>',
    description: 'Set the text of an input field matching the selector.',
    example: "await device.setText({ resourceId: 'com.app:id/input' }, 'hello');",
    category: 'text',
  },
  {
    name: 'getText',
    object: 'device',
    signature: 'getText(selector: Selector, timeout?: number): Promise<string>',
    description: 'Read the text content of an element matching the selector.',
    example: "const label = await device.getText({ resourceId: 'com.app:id/title' });",
    category: 'text',
  },

  // --- scrolling ---
  {
    name: 'scroll',
    object: 'device',
    signature: "scroll(direction: 'up' | 'down' | 'left' | 'right', percent?: number): Promise<void>",
    description: 'Scroll in a direction by a percentage of the screen (default 50%).',
    example: "await device.scroll('down', 50);",
    category: 'scrolling',
  },
  {
    name: 'scrollToElement',
    object: 'device',
    signature: 'scrollToElement(selector: Selector, maxScrolls?: number): Promise<void>',
    description: 'Repeatedly scroll down until an element matching the selector is visible.',
    example: "await device.scrollToElement({ text: 'More' });",
    category: 'scrolling',
  },

  // --- gestures ---
  {
    name: 'swipe',
    object: 'device',
    signature: 'swipe(startX: number, startY: number, endX: number, endY: number, duration?: number): Promise<void>',
    description: 'Perform a swipe gesture between two points. Duration in ms.',
    example: 'await device.swipe(500, 1500, 500, 500, 300);',
    category: 'gestures',
  },
  {
    name: 'tapAt',
    object: 'device',
    signature: 'tapAt(x: number, y: number): Promise<void>',
    description: 'Tap at exact screen coordinates.',
    example: 'await device.tapAt(540, 960);',
    category: 'gestures',
  },
  {
    name: 'pressKey',
    object: 'device',
    signature: 'pressKey(key: string): Promise<void>',
    description: "Press a device key. Common keys: BACK, HOME, ENTER, VOLUME_UP, VOLUME_DOWN.",
    example: "await device.pressKey('BACK');",
    category: 'gestures',
  },

  // --- apps ---
  {
    name: 'startApp',
    object: 'device',
    signature: 'startApp(packageName: string, activity?: string): Promise<void>',
    description: 'Launch an app by package name. Optionally specify an activity.',
    example: "await device.startApp('com.example.app');",
    category: 'apps',
  },
  {
    name: 'stopApp',
    object: 'device',
    signature: 'stopApp(packageName: string): Promise<void>',
    description: 'Force-stop an app by package name.',
    example: "await device.stopApp('com.example.app');",
    category: 'apps',
  },
  {
    name: 'getAppInfo',
    object: 'device',
    signature: 'getAppInfo(packageName: string): Promise<AppInfo>',
    description: 'Get info about an installed app (version, APK path, etc.).',
    example: "const info = await device.getAppInfo('com.example.app');",
    category: 'apps',
  },

  // --- dom ---
  {
    name: 'getDOM',
    object: 'device',
    signature: 'getDOM(timeout?: number): Promise<DOMNode>',
    description: 'Capture the current UI hierarchy as a DOM tree.',
    example: 'const dom = await device.getDOM();',
    category: 'dom',
  },
  {
    name: 'updateDOM',
    object: 'device',
    signature: 'updateDOM(): Promise<DOMNode>',
    description: 'Re-capture the UI hierarchy (shorthand for getDOM with no timeout).',
    example: 'const dom = await device.updateDOM();',
    category: 'dom',
  },
  {
    name: 'gatherDOM',
    object: 'device',
    signature: 'gatherDOM(options?: GatherDOMOptions): Promise<DOMNode>',
    description: 'Capture DOM across multiple scroll pages, merging results into one tree.',
    example: 'const fullDom = await device.gatherDOM({ maxScrollPages: 3 });',
    category: 'dom',
  },
  {
    name: 'searchDOM',
    object: 'device',
    signature: 'searchDOM(selector: Selector, options?: SearchDOMOptions): Promise<DOMNode[]>',
    description: 'Search the DOM tree for nodes matching a selector. Can scroll to find more.',
    example: "const buttons = await device.searchDOM({ className: 'android.widget.Button' });",
    category: 'dom',
  },
  {
    name: 'screenshot',
    object: 'device',
    signature: 'screenshot(name?: string): Promise<string>',
    description: 'Take a screenshot. Returns base64-encoded PNG. Optional name for logging.',
    example: "const png = await device.screenshot('step1');",
    category: 'dom',
  },

  // --- device ---
  {
    name: 'deviceInfo',
    object: 'device',
    signature: 'deviceInfo(): Promise<DeviceInfo>',
    description: 'Get device information: model, brand, Android version, screen size, battery.',
    example: 'const info = await device.deviceInfo();',
    category: 'device',
  },
  {
    name: 'getWebViewInfo',
    object: 'device',
    signature: 'getWebViewInfo(): Promise<WebViewInfo>',
    description: 'List all debuggable WebView pages on the device (Chrome DevTools Protocol).',
    example: 'const webviews = await device.getWebViewInfo();',
    category: 'device',
  },

  // --- http-requests ---
  {
    name: 'httpGet',
    object: 'device',
    signature: 'httpGet(url: string, options?: HttpRequestOptions): Promise<HttpResponse>',
    description: 'Make an HTTP GET request. Returns status, headers, and body.',
    example: "const res = await device.httpGet('https://api.example.com/data');",
    category: 'http-requests',
  },
  {
    name: 'httpPost',
    object: 'device',
    signature: 'httpPost(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse>',
    description: 'Make an HTTP POST request. Body is JSON-serialized automatically.',
    example: "const res = await device.httpPost('https://api.example.com', { key: 'value' });",
    category: 'http-requests',
  },

  // --- http-hooks ---
  {
    name: 'hook',
    object: 'device.http',
    signature: 'hook(filter: TrafficFilter, onRequest?: RequestHookCallback, onResponse?: ResponseHookCallback): string',
    description: 'Intercept live HTTP traffic matching a filter. Returns a hook ID. Requires HTTPS capture. Filter fields accept strings (substring match) or RegExp.',
    example: `const hookId = device.http.hook(
  { hostname: 'example.com' },
  async (req) => { console.log(req.url); return req; },
  async (resp) => { console.log(resp.status); return resp; }
);`,
    category: 'http-hooks',
  },
  {
    name: 'hookRequest',
    object: 'device.http',
    signature: 'hookRequest(filter: TrafficFilter, onRequest: RequestHookCallback): string',
    description: 'Intercept and optionally modify outgoing requests matching a filter.',
    example: `const hookId = device.http.hookRequest(
  { hostname: 'example.com', path: '/login' },
  async (req) => {
    req.headers['X-Custom'] = 'value';
    return req;
  }
);`,
    category: 'http-hooks',
  },
  {
    name: 'hookResponse',
    object: 'device.http',
    signature: 'hookResponse(filter: TrafficFilter, onResponse: ResponseHookCallback): string',
    description: 'Intercept and optionally modify responses matching a filter.',
    example: `const hookId = device.http.hookResponse(
  { hostname: 'example.com' },
  async (resp) => {
    const data = JSON.parse(resp.body!);
    data.modified = true;
    resp.body = JSON.stringify(data);
    return resp;
  }
);`,
    category: 'http-hooks',
  },
  {
    name: 'unhook',
    object: 'device.http',
    signature: 'unhook(hookId: string): void',
    description: 'Remove a specific traffic hook by its ID.',
    example: 'device.http.unhook(hookId);',
    category: 'http-hooks',
  },
  {
    name: 'unhookAll',
    object: 'device.http',
    signature: 'unhookAll(): void',
    description: 'Remove all active traffic hooks.',
    example: 'device.http.unhookAll();',
    category: 'http-hooks',
  },

  // --- proxy ---
  {
    name: 'setProxy',
    object: 'device',
    signature: "setProxy(mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }): Promise<void>",
    description: "Change the proxy mode. 'normal' uses mitmproxy, 'nordvpn' routes through NordVPN SOCKS5.",
    example: "await device.setProxy('nordvpn', { country: 'us' });",
    category: 'proxy',
  },
  {
    name: 'setTlsProfile',
    object: 'device',
    signature: "setTlsProfile(profile: 'chrome' | 'okhttp' | 'default'): Promise<void>",
    description: "Set TLS fingerprint profile for upstream connections. 'chrome' mimics Chrome 120 on Android.",
    example: "await device.setTlsProfile('chrome');",
    category: 'proxy',
  },

  // --- credentials ---
  {
    name: 'getCredentials',
    object: 'device',
    signature: 'getCredentials(appId: string): Promise<{ username: string; password: string; customFields: Record<string, string> }>',
    description: 'Retrieve stored credentials for an app. Throws if no credentials are found.',
    example: "const creds = await device.getCredentials('com.example.app');",
    category: 'credentials',
  },

  // --- frida ---
  {
    name: 'run',
    object: 'device.frida',
    signature: 'device.frida.run(bundleId: string, scripts: string | string[]): Promise<void>',
    description: 'Spawn app via Frida, inject named scripts, and resume. Starts frida-server if needed.',
    example: `await device.frida.run('com.example.app', 'ssl-pinning-bypass');\nawait device.frida.run('com.example.app', ['bypass1', 'bypass2']);`,
    category: 'frida',
  },
  {
    name: 'inject',
    object: 'device.frida',
    signature: 'device.frida.inject(bundleId: string, code: string): Promise<void>',
    description: 'Spawn app and inject inline Frida JavaScript code.',
    example: `await device.frida.inject('com.example.app', \`\n  Java.perform(function() {\n    var Activity = Java.use('com.example.MainActivity');\n    Activity.isRooted.implementation = function() { return false; };\n  });\n\`);`,
    category: 'frida',
  },
  {
    name: 'loadScript',
    object: 'device.frida',
    signature: 'device.frida.loadScript(name: string): Promise<void>',
    description: 'Load a saved Frida script by name into the current session.',
    example: `await device.frida.loadScript('ssl-pinning-bypass');`,
    category: 'frida',
  },
  {
    name: 'getMessages',
    object: 'device.frida',
    signature: 'device.frida.getMessages(): Promise<FridaMessage[]>',
    description: 'Get messages from Frida scripts (console.log, send(), errors) since last call.',
    example: `const messages = await device.frida.getMessages();\nfor (const msg of messages) {\n  console.log(msg.type, msg.payload);\n}`,
    category: 'frida',
  },
  {
    name: 'send',
    object: 'device.frida',
    signature: 'device.frida.send(message: any): Promise<void>',
    description: "Send a message to the Frida script's recv() handler.",
    example: `await device.frida.send({ type: 'config', value: 42 });`,
    category: 'frida',
  },
  {
    name: 'stop',
    object: 'device.frida',
    signature: 'device.frida.stop(): Promise<void>',
    description: 'Stop Frida: detach all sessions and stop frida-server on the device.',
    example: `await device.frida.stop();`,
    category: 'frida',
  },

  // --- dom-utils ---
  {
    name: 'findAll',
    object: 'dom',
    signature: 'findAll(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode[]',
    description: 'Recursively find all nodes in the tree matching a predicate (DFS).',
    example: "const inputs = dom.findAll(tree, n => n.className === 'android.widget.EditText');",
    category: 'dom-utils',
  },
  {
    name: 'find',
    object: 'dom',
    signature: 'find(root: DOMNode, predicate: (node: DOMNode) => boolean): DOMNode | null',
    description: 'Find the first node matching a predicate, or null.',
    example: "const btn = dom.find(tree, n => n.text === 'Submit');",
    category: 'dom-utils',
  },
  {
    name: 'flatten',
    object: 'dom',
    signature: 'flatten(root: DOMNode): DOMNode[]',
    description: 'Flatten the DOM tree into a flat array of all nodes.',
    example: 'const allNodes = dom.flatten(tree);',
    category: 'dom-utils',
  },
  {
    name: 'filter',
    object: 'dom',
    signature: 'filter(nodes: DOMNode[], predicate: (node: DOMNode) => boolean): DOMNode[]',
    description: 'Filter an array of DOM nodes by a predicate.',
    example: 'const clickable = dom.filter(allNodes, n => n.clickable);',
    category: 'dom-utils',
  },
  {
    name: 'getCenter',
    object: 'dom',
    signature: 'getCenter(node: DOMNode): { x: number; y: number }',
    description: 'Get the center point of a node from its bounds.',
    example: 'const { x, y } = dom.getCenter(node);\nawait device.tapAt(x, y);',
    category: 'dom-utils',
  },
  {
    name: 'getSize',
    object: 'dom',
    signature: 'getSize(node: DOMNode): { width: number; height: number }',
    description: 'Get the width and height of a node from its bounds.',
    example: 'const { width, height } = dom.getSize(node);',
    category: 'dom-utils',
  },
  {
    name: 'getAllText',
    object: 'dom',
    signature: 'getAllText(root: DOMNode): string[]',
    description: 'Recursively collect all non-empty text and description values from the tree.',
    example: 'const texts = dom.getAllText(tree);',
    category: 'dom-utils',
  },

  // --- maps (provided by the maps plugin via the tools registry) ---
  {
    name: 'maps_update_variables',
    object: 'tools',
    signature: 'tools.maps_update_variables(options: { appId: string; version?: string; url?: string; mapId?: string; variables?: Record<string, string> }): Promise<{ created: boolean; versionId?: number; mapConfigId?: number; updatedCount?: number }>',
    description: 'Archive or update a map tile version. Finds or creates a map config by appId, then either queues a new version for download or merges variables into existing versions. Requires plugin.maps:write.',
    example: `const result = await tools.maps_update_variables({\n  appId: 'com.example.parkapp',\n  version: '2024-01-15',\n  url: 'https://cdn.example.com/{version}/{z}/{x}/{y}.png',\n});`,
    category: 'maps',
  },

  // --- utilities ---
  {
    name: 'sleep',
    object: 'device',
    signature: 'sleep(ms: number): Promise<void>',
    description: 'Pause execution for the specified number of milliseconds.',
    example: 'await device.sleep(2000);',
    category: 'utilities',
  },
];

/** Build a compact API reference string for AI system prompts */
export function buildAiReferencePrompt(): string {
  const lines: string[] = [
    '\n--- DeviceAPI & DOM Utils Reference ---',
  ];

  for (const cat of CATEGORY_ORDER) {
    const entries = API_REFERENCE.filter(e => e.category === cat);
    if (entries.length === 0) continue;
    const label = CATEGORY_LABELS[cat] || cat;
    lines.push(`\n[${label}]`);
    for (const e of entries) {
      lines.push(`${e.object}.${e.signature} — ${e.description}`);
    }
  }

  lines.push('\nSelector fields: text, textContains, textStartsWith, resourceId, className, description, descriptionContains, clickable, enabled, index, instance');
  lines.push('TrafficFilter fields: hostname (string | RegExp), path (string | RegExp), method (string | RegExp), url (string | RegExp). Strings match as substrings.');

  return lines.join('\n');
}
