import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { getDataRoot } from '../config/paths';
import { screenshots, credentials } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';
import type {
  DeviceAPI,
  DeviceHTTP,
  DeviceFrida,
  Selector,
  DOMNode,
  GatherDOMOptions,
  SearchDOMOptions,
  PressButtonOptions,
  HttpRequestOptions,
  HttpResponse,
  DeviceInfo,
  AppInfo,
  WebViewInfo,
  ExecutionLogEntry,
} from '../../shared/types/automation';
import { BridgeErrorCode } from '../../shared/types/automation';
import { DeviceHTTPImpl, NoopDeviceHTTP } from './device-http';
import { DeviceFridaImpl, NoopDeviceFrida } from './device-frida';
import type { TrafficHookRegistry } from './traffic-hook-registry';

const { log, error } = createLoggers('device-api');

interface JsonRpcResponse {
  jsonrpc: string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: string;
}

export class BridgeError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: any,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export class DeviceAPIImpl implements DeviceAPI {
  private static readonly POLL_INTERVAL_START_MS = 100;
  private static readonly POLL_INTERVAL_MAX_MS = 500;
  private static readonly POLL_INTERVAL_STEP_MS = 100;
  private static readonly DOM_REUSE_TTL_MS = 500;
  private screenshotPath: string;
  private rulesRunner: (() => Promise<void>) | null = null;
  private proxyHandler: ((mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }) => Promise<void>) | null = null;
  private tlsProfileHandler: ((profile: 'chrome' | 'okhttp' | 'default') => Promise<void>) | null = null;
  private cachedDOM: DOMNode | null = null;
  private lastFetchedDOM: DOMNode | null = null;
  private lastDOMFetchTime = 0;
  private executionLog: ExecutionLogEntry[] = [];
  private suppressLogging = false;
  private atxFree = false;
  readonly http: DeviceHTTP;
  readonly frida: DeviceFrida;
  private platform: 'android' | 'ios';
  private iosManager: import('./ios-device-manager').IosDeviceManager | null;

  constructor(
    private deviceId: string,
    private bridgePort: number,
    private sessionId: number,
    private db: AppDatabase,
    screenshotPath?: string,
    registry?: TrafficHookRegistry,
    platform: 'android' | 'ios' = 'android',
    iosManager?: import('./ios-device-manager').IosDeviceManager | null,
  ) {
    this.screenshotPath = screenshotPath || process.env.SCREENSHOT_PATH || join(getDataRoot(), 'screenshots');
    this.http = registry ? new DeviceHTTPImpl(deviceId, registry, db, sessionId) : new NoopDeviceHTTP();
    this.frida = new NoopDeviceFrida();
    this.platform = platform;
    this.iosManager = iosManager ?? null;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getExecutionLog(): ExecutionLogEntry[] {
    return this.executionLog;
  }

  private async logCall<T>(
    method: string,
    params: Record<string, any>,
    fn: () => Promise<T>,
    options?: {
      isDomQuery?: boolean;
      captureDomOnError?: boolean;
      selector?: Selector;
      domProvider?: () => DOMNode | null;
      patchEntry?: (entry: ExecutionLogEntry) => void;
    },
  ): Promise<T> {
    if (this.suppressLogging) {
      return fn();
    }

    const start = Date.now();
    const entry: ExecutionLogEntry = {
      timestamp: new Date().toISOString(),
      method,
      params,
      durationMs: 0,
    };

    if (options?.selector) {
      entry.selector = options.selector;
    }

    try {
      const result = await fn();
      entry.durationMs = Date.now() - start;
      if (result !== undefined && result !== null) {
        entry.result = result;
      }
      if (options?.isDomQuery && options.domProvider) {
        const dom = options.domProvider();
        if (dom) entry.domSnapshot = JSON.stringify(dom);
      }
      if (options?.patchEntry) options.patchEntry(entry);
      this.executionLog.push(entry);
      return result;
    } catch (err: any) {
      entry.durationMs = Date.now() - start;
      entry.error = err.message || 'Unknown error';
      if (options?.isDomQuery && options.domProvider) {
        const dom = options.domProvider();
        if (dom) entry.domSnapshot = JSON.stringify(dom);
      }
      if (options?.captureDomOnError && !entry.domSnapshot && this.lastFetchedDOM) {
        entry.domSnapshot = JSON.stringify(this.lastFetchedDOM);
      }
      if (options?.patchEntry) options.patchEntry(entry);
      this.executionLog.push(entry);
      throw err;
    }
  }

  setRulesRunner(fn: () => Promise<void>): void {
    this.rulesRunner = fn;
  }

  setProxyHandler(fn: (mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }) => Promise<void>): void {
    this.proxyHandler = fn;
  }

  setTlsProfileHandler(fn: (profile: 'chrome' | 'okhttp' | 'default') => Promise<void>): void {
    this.tlsProfileHandler = fn;
  }

  setFridaScriptResolver(resolver: (name: string) => Promise<string | null>): void {
    (this as any).frida = new DeviceFridaImpl(
      this.callBridge.bind(this),
      this.logCall.bind(this),
      resolver,
    );
  }

  setCachedDOM(dom: DOMNode): void {
    this.cachedDOM = dom;
  }

  clearCachedDOM(): void {
    this.invalidateDOMCache();
  }

  private invalidateDOMCache(): void {
    this.cachedDOM = null;
    this.lastDOMFetchTime = 0;
  }

  async setATXFree(enabled: boolean): Promise<void> {
    if (this.platform === 'ios') {
      // iOS always uses DOM-based matching (no ATX agent)
      this.atxFree = true;
      return;
    }
    await this.callBridge('setATXFree', { enabled });
    this.atxFree = enabled;
  }

  private async callBridge(method: string, params: Record<string, any> = {}): Promise<any> {
    if (this.bridgePort === 0) {
      throw new Error(
        `device.${method}() requires a connected device. ` +
        `This automation is running deviceless. Either set requiresDevice: true and ` +
        `invoke it with a device, or remove the device-only call. ` +
        `For server-side HTTP, use the top-level \`http\` namespace (http.get / http.post / etc.).`,
      );
    }
    const id = randomUUID();

    const response = await fetch(`http://localhost:${this.bridgePort}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id,
      }),
    });

    if (!response.ok) {
      throw new BridgeError(
        BridgeErrorCode.DEVICE_DISCONNECTED,
        `Bridge HTTP error: ${response.status}`,
      );
    }

    const result = await response.json() as JsonRpcResponse;

    if (result.error) {
      throw new BridgeError(result.error.code, result.error.message, result.error.data);
    }

    return result.result;
  }

  // Wake & unlock

  async wakeAndUnlock(): Promise<void> {
    if (this.platform === 'ios') {
      // iOS doesn't need wake/unlock via bridge — WDA handles this
      return;
    }
    await this.callBridge('wakeAndUnlock', {});
  }

  // Core element interactions

  async click(selector: Selector, timeout?: number): Promise<void> {
    await this.logCall('click', { selector, timeout }, async () => {
      if (this.atxFree) {
        // ATX-free: skip bridge click, go directly to DOM match + tap
        const match = await this.findDOMMatch(selector);
        if (match) {
          const [x1, y1, x2, y2] = match.bounds;
          const cx = Math.round((x1 + x2) / 2);
          const cy = Math.round((y1 + y2) / 2);
          log(`click [ATX-free]: tapping at DOM coordinates (${cx}, ${cy})`);
          await this.callBridge('tapAt', { x: cx, y: cy });
        } else {
          throw new BridgeError(
            BridgeErrorCode.ELEMENT_NOT_FOUND,
            'Element not found',
            { selector },
          );
        }
      } else {
        try {
          await this.callBridge('click', { selector, timeout });
        } catch (err: any) {
          if (err instanceof BridgeError && err.code === BridgeErrorCode.ELEMENT_NOT_FOUND) {
            // u2 selector failed — find element in ADB DOM and tap at its coordinates
            const match = await this.findDOMMatch(selector);
            if (match) {
              const [x1, y1, x2, y2] = match.bounds;
              const cx = Math.round((x1 + x2) / 2);
              const cy = Math.round((y1 + y2) / 2);
              log(`click: u2 selector failed, tapping at DOM coordinates (${cx}, ${cy})`);
              await this.callBridge('tapAt', { x: cx, y: cy });
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
      this.invalidateDOMCache();
    }, { captureDomOnError: true, selector });
  }

  async longClick(selector: Selector, duration?: number, timeout?: number): Promise<void> {
    await this.logCall('longClick', { selector, duration, timeout }, async () => {
      if (this.atxFree) {
        const match = await this.findDOMMatch(selector);
        if (match) {
          const [x1, y1, x2, y2] = match.bounds;
          const cx = Math.round((x1 + x2) / 2);
          const cy = Math.round((y1 + y2) / 2);
          log(`longClick [ATX-free]: long-pressing at DOM coordinates (${cx}, ${cy})`);
          await this.callBridge('longClickAt', { x: cx, y: cy, duration });
        } else {
          throw new BridgeError(
            BridgeErrorCode.ELEMENT_NOT_FOUND,
            'Element not found',
            { selector },
          );
        }
      } else {
        try {
          await this.callBridge('longClick', { selector, duration, timeout });
        } catch (err: any) {
          if (err instanceof BridgeError && err.code === BridgeErrorCode.ELEMENT_NOT_FOUND) {
            const match = await this.findDOMMatch(selector);
            if (match) {
              const [x1, y1, x2, y2] = match.bounds;
              const cx = Math.round((x1 + x2) / 2);
              const cy = Math.round((y1 + y2) / 2);
              log(`longClick: u2 selector failed, long-pressing at DOM coordinates (${cx}, ${cy})`);
              await this.callBridge('longClickAt', { x: cx, y: cy, duration });
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
      this.invalidateDOMCache();
    }, { captureDomOnError: true, selector });
  }

  async setText(selector: Selector, text: string, timeout?: number): Promise<void> {
    await this.logCall('setText', { selector, text, timeout }, async () => {
      if (this.atxFree) {
        // ATX-free: find element via DOM, tap to focus, then use inputText
        const match = await this.findDOMMatch(selector);
        if (match) {
          const [x1, y1, x2, y2] = match.bounds;
          const cx = Math.round((x1 + x2) / 2);
          const cy = Math.round((y1 + y2) / 2);
          log(`setText [ATX-free]: tapping at DOM coordinates (${cx}, ${cy}) to focus`);
          await this.callBridge('tapAt', { x: cx, y: cy });
          await new Promise((r) => setTimeout(r, 300));
          await this.callBridge('inputText', { text });
        } else {
          throw new BridgeError(
            BridgeErrorCode.ELEMENT_NOT_FOUND,
            'Element not found',
            { selector },
          );
        }
      } else {
        try {
          await this.callBridge('setText', { selector, text, timeout });
        } catch (err: any) {
          if (err instanceof BridgeError && err.code === BridgeErrorCode.ELEMENT_NOT_FOUND) {
            // u2 selector failed — find element in DOM, tap to focus, then type
            const match = await this.findDOMMatch(selector);
            if (match) {
              const [x1, y1, x2, y2] = match.bounds;
              const cx = Math.round((x1 + x2) / 2);
              const cy = Math.round((y1 + y2) / 2);
              log(`setText: u2 selector failed, tapping at DOM coordinates (${cx}, ${cy}) to focus`);
              await this.callBridge('tapAt', { x: cx, y: cy });
              await new Promise((r) => setTimeout(r, 300));
              // Type into the now-focused element via bridge
              await this.callBridge('setText', { selector: {}, text, timeout: 2000 });
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
      this.invalidateDOMCache();
    }, { captureDomOnError: true, selector });
  }

  async getText(selector: Selector, timeout?: number): Promise<string> {
    return this.logCall('getText', { selector, timeout }, async () => {
      if (this.atxFree) {
        // ATX-free: read text directly from DOM
        const match = await this.findDOMMatch(selector);
        if (match) {
          log(`getText [ATX-free]: returning text from DOM node`);
          return match.text;
        }
        throw new BridgeError(
          BridgeErrorCode.ELEMENT_NOT_FOUND,
          'Element not found',
          { selector },
        );
      }
      try {
        const result = await this.callBridge('getText', { selector, timeout });
        return result.text;
      } catch (err: any) {
        if (err instanceof BridgeError && err.code === BridgeErrorCode.ELEMENT_NOT_FOUND) {
          const match = await this.findDOMMatch(selector);
          if (match) {
            log(`getText: u2 selector failed, returning text from DOM node`);
            return match.text;
          }
          throw err;
        }
        throw err;
      }
    }, { captureDomOnError: true, selector });
  }

  async exists(selector: Selector, timeout?: number): Promise<boolean> {
    let lastDOM: DOMNode | null = null;
    return this.logCall('exists', { selector, timeout }, async () => {
      // When using cached DOM (e.g. during rules), check once against the snapshot
      if (this.cachedDOM) {
        lastDOM = this.cachedDOM;
        return this.findFirstMatchingNode(this.cachedDOM, selector) !== null;
      }

      this.suppressLogging = true;
      try {
        const timeoutMs = timeout ?? 0;
        if (timeoutMs > 0) {
          const deadline = Date.now() + timeoutMs;
          let pollInterval = DeviceAPIImpl.POLL_INTERVAL_START_MS;
          while (Date.now() < deadline) {
            const dom = await this.getDOM();
            lastDOM = dom;
            if (this.findFirstMatchingNode(dom, selector) !== null) return true;
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((r) => setTimeout(r, Math.min(pollInterval, remaining)));
            pollInterval = Math.min(pollInterval + DeviceAPIImpl.POLL_INTERVAL_STEP_MS, DeviceAPIImpl.POLL_INTERVAL_MAX_MS);
          }
          return false;
        }
        const dom = await this.getDOM();
        lastDOM = dom;
        return this.findFirstMatchingNode(dom, selector) !== null;
      } finally {
        this.suppressLogging = false;
      }
    }, { isDomQuery: true, selector, domProvider: () => lastDOM });
  }

  async waitFor(selector: Selector, timeout: number): Promise<void> {
    let lastDOM: DOMNode | null = null;
    await this.logCall('waitFor', { selector, timeout }, async () => {
      // When using cached DOM (e.g. during rules), check once against the snapshot
      if (this.cachedDOM) {
        lastDOM = this.cachedDOM;
        if (this.findFirstMatchingNode(this.cachedDOM, selector) !== null) return;
        throw new BridgeError(
          BridgeErrorCode.ELEMENT_NOT_FOUND,
          'Element not found in cached DOM',
          { selector },
        );
      }

      this.suppressLogging = true;
      try {
        const deadline = Date.now() + timeout;
        let pollInterval = DeviceAPIImpl.POLL_INTERVAL_START_MS;
        while (Date.now() < deadline) {
          const dom = await this.getDOM();
          lastDOM = dom;
          if (this.findFirstMatchingNode(dom, selector) !== null) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((r) => setTimeout(r, Math.min(pollInterval, remaining)));
          pollInterval = Math.min(pollInterval + DeviceAPIImpl.POLL_INTERVAL_STEP_MS, DeviceAPIImpl.POLL_INTERVAL_MAX_MS);
        }

        // Timed out — run rules if available, then retry once
        if (this.rulesRunner) {
          log(`waitFor timed out, running rules before retry`);
          await this.rulesRunner();
          const dom = await this.getDOM();
          lastDOM = dom;
          if (this.findFirstMatchingNode(dom, selector) !== null) return;
        }
      } finally {
        this.suppressLogging = false;
      }

      throw new BridgeError(
        BridgeErrorCode.TIMEOUT,
        'Timed out waiting for element',
        { selector, timeout },
      );
    }, { isDomQuery: true, selector, domProvider: () => lastDOM });
  }

  async existsAny(selectors: Selector[], timeout?: number): Promise<Selector | null> {
    let lastDOM: DOMNode | null = null;
    return this.logCall('existsAny', { selectors, timeout }, async () => {
      if (this.cachedDOM) {
        lastDOM = this.cachedDOM;
        for (const sel of selectors) {
          if (this.findFirstMatchingNode(this.cachedDOM, sel) !== null) return sel;
        }
        return null;
      }

      this.suppressLogging = true;
      try {
        const timeoutMs = timeout ?? 0;
        if (timeoutMs > 0) {
          const deadline = Date.now() + timeoutMs;
          let pollInterval = DeviceAPIImpl.POLL_INTERVAL_START_MS;
          while (Date.now() < deadline) {
            const dom = await this.getDOM();
            lastDOM = dom;
            for (const sel of selectors) {
              if (this.findFirstMatchingNode(dom, sel) !== null) return sel;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((r) => setTimeout(r, Math.min(pollInterval, remaining)));
            pollInterval = Math.min(pollInterval + DeviceAPIImpl.POLL_INTERVAL_STEP_MS, DeviceAPIImpl.POLL_INTERVAL_MAX_MS);
          }
          return null;
        }
        const dom = await this.getDOM();
        lastDOM = dom;
        for (const sel of selectors) {
          if (this.findFirstMatchingNode(dom, sel) !== null) return sel;
        }
        return null;
      } finally {
        this.suppressLogging = false;
      }
    }, { isDomQuery: true, domProvider: () => lastDOM });
  }

  async clickAny(selectors: Selector[], timeout?: number): Promise<boolean> {
    let lastDOM: DOMNode | null = null;
    return this.logCall('clickAny', { selectors, timeout }, async () => {
      this.suppressLogging = true;
      try {
        const timeoutMs = timeout ?? 0;
        if (timeoutMs > 0) {
          const deadline = Date.now() + timeoutMs;
          let pollInterval = DeviceAPIImpl.POLL_INTERVAL_START_MS;
          while (Date.now() < deadline) {
            const dom = await this.getDOM();
            lastDOM = dom;
            for (const sel of selectors) {
              const match = this.findFirstMatchingNode(dom, sel);
              if (match) {
                const [x1, y1, x2, y2] = match.bounds;
                const cx = Math.round((x1 + x2) / 2);
                const cy = Math.round((y1 + y2) / 2);
                log(`clickAny: tapping at DOM coordinates (${cx}, ${cy})`);
                await this.callBridge('tapAt', { x: cx, y: cy });
                this.invalidateDOMCache();
                return true;
              }
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((r) => setTimeout(r, Math.min(pollInterval, remaining)));
            pollInterval = Math.min(pollInterval + DeviceAPIImpl.POLL_INTERVAL_STEP_MS, DeviceAPIImpl.POLL_INTERVAL_MAX_MS);
          }
          return false;
        }
        const dom = await this.getDOM();
        lastDOM = dom;
        for (const sel of selectors) {
          const match = this.findFirstMatchingNode(dom, sel);
          if (match) {
            const [x1, y1, x2, y2] = match.bounds;
            const cx = Math.round((x1 + x2) / 2);
            const cy = Math.round((y1 + y2) / 2);
            log(`clickAny: tapping at DOM coordinates (${cx}, ${cy})`);
            await this.callBridge('tapAt', { x: cx, y: cy });
            this.invalidateDOMCache();
            return true;
          }
        }
        return false;
      } finally {
        this.suppressLogging = false;
      }
    }, { isDomQuery: true, domProvider: () => lastDOM });
  }

  async waitForAndClick(selector: Selector, timeout?: number): Promise<void> {
    await this.logCall('waitForAndClick', { selector, timeout }, async () => {
      this.suppressLogging = true;
      try {
        await this.waitFor(selector, timeout ?? 5000);
        await this.click(selector);
      } finally {
        this.suppressLogging = false;
      }
    }, { captureDomOnError: true, selector });
  }

  // Scrolling

  async scroll(direction: 'up' | 'down' | 'left' | 'right', percent?: number): Promise<void> {
    await this.logCall('scroll', { direction, percent }, async () => {
      if (this.platform === 'ios' && this.iosManager) {
        // iOS: implement scroll as swipe gesture (no native scroll RPC)
        const pct = percent ?? 50;
        const screenSize = await this.iosManager.wdaWindowSize(this.deviceId);
        const midX = Math.round(screenSize.width / 2);
        const midY = Math.round(screenSize.height / 2);
        const distance = Math.round(midY * (pct / 100));
        const swipeMap = {
          down: { sx: midX, sy: midY + distance / 2, ex: midX, ey: midY - distance / 2 },
          up: { sx: midX, sy: midY - distance / 2, ex: midX, ey: midY + distance / 2 },
          right: { sx: midX + distance / 2, sy: midY, ex: midX - distance / 2, ey: midY },
          left: { sx: midX - distance / 2, sy: midY, ex: midX + distance / 2, ey: midY },
        };
        const s = swipeMap[direction];
        await this.iosManager.wdaSwipe(this.deviceId, s.sx, s.sy, s.ex, s.ey, 0.3);
        // Invalidate WDA-side DOM cache (IosDeviceManager's parsed DOM with TTL)
        this.iosManager.invalidateDomCache(this.deviceId);
      } else {
        await this.callBridge('scroll', { direction, percent });
      }
      // Invalidate DeviceAPI-level DOM cache (separate from WDA cache above)
      this.invalidateDOMCache();
    });
  }

  async scrollToElement(selector: Selector, maxScrolls?: number): Promise<void> {
    await this.logCall('scrollToElement', { selector, maxScrolls: maxScrolls ?? 10 }, async () => {
      const limit = maxScrolls ?? 10;
      let prevDomSignature = '';
      this.suppressLogging = true;
      try {
        for (let i = 0; i < limit; i++) {
          const dom = await this.getDOM();
          if (this.findFirstMatchingNode(dom, selector) !== null) return;

          // Detect stale scroll — if DOM didn't change after last scroll,
          // we've hit the end of the scrollable area
          const sig = JSON.stringify(dom);
          if (i > 0 && sig === prevDomSignature) {
            break; // Scroll had no effect — stop trying
          }
          prevDomSignature = sig;

          await this.scroll('down', 50);
          await new Promise((r) => setTimeout(r, 500));
        }
        // Check once more after final scroll
        const dom = await this.getDOM();
        if (this.findFirstMatchingNode(dom, selector) !== null) return;
      } finally {
        this.suppressLogging = false;
      }
      throw new BridgeError(
        BridgeErrorCode.ELEMENT_NOT_FOUND,
        'Element not found after scrolling',
        { selector, maxScrolls: limit },
      );
    }, { captureDomOnError: true, selector });
  }

  // DOM / Screen

  async getDOM(timeout?: number): Promise<DOMNode> {
    return this.logCall('getDOM', { timeout }, async () => {
      if (this.cachedDOM) return this.cachedDOM;

      let dom: DOMNode;
      if (this.platform === 'ios' && this.iosManager) {
        // iOS: get parsed DOM via WDA with aggressive caching (3s TTL)
        dom = await this.iosManager.wdaDomParsed(this.deviceId);
      } else {
        // Android: get DOM via Python bridge
        // Only enrich WebViews for user-facing calls (not internal polling)
        const enrichWebViews = !this.suppressLogging;
        dom = await this.callBridge('getDOM', { timeout, enrichWebViews });
      }
      this.lastFetchedDOM = dom;
      this.lastDOMFetchTime = Date.now();
      return dom;
    });
  }

  async updateDOM(): Promise<DOMNode> {
    let lastDOM: DOMNode | null = null;
    return this.logCall('updateDOM', {}, async () => {
      this.suppressLogging = true;
      try {
        const result = await this.callBridge('getDOM', { enrichWebViews: true });
        if (this.cachedDOM !== null) {
          this.cachedDOM = result;
        }
        lastDOM = result;
        this.lastFetchedDOM = result;
        this.lastDOMFetchTime = Date.now();
        return result;
      } finally {
        this.suppressLogging = false;
      }
    }, { isDomQuery: true, domProvider: () => lastDOM });
  }

  async screenshot(name?: string): Promise<string> {
    let savedFilename = '';
    return this.logCall('screenshot', { name }, async () => {
      let base64: string;
      if (this.platform === 'ios' && this.iosManager) {
        const result = await this.iosManager.wdaScreenshot(this.deviceId);
        base64 = result.image;
      } else {
        const result = await this.callBridge('screenshot', {});
        base64 = result.base64;
      }

      // Persist to disk
      const filename = `${this.sessionId}_${Date.now()}_${name || 'screenshot'}.png`;
      const filePath = join(this.screenshotPath, filename);
      const buffer = Buffer.from(base64, 'base64');
      await writeFile(filePath, buffer);
      savedFilename = filename;

      // Get current DOM for snapshot
      let domSnapshot: string | null = null;
      this.suppressLogging = true;
      try {
        const dom = await this.getDOM();
        domSnapshot = JSON.stringify(dom);
      } catch {
        // DOM capture may fail, that's ok
      } finally {
        this.suppressLogging = false;
      }

      // Save metadata to DB
      this.db
        .insert(screenshots)
        .values({
          sessionId: this.sessionId,
          filename,
          name: name || null,
          domSnapshot,
          capturedAt: new Date(),
        })
        .run();

      log(`Screenshot saved: ${filename}`);
      return base64;
    }, {
      patchEntry: (entry) => {
        if (savedFilename) entry.screenshotFilename = savedFilename;
        delete entry.result; // Don't store base64 in the log — it's huge
      },
    });
  }

  async getAppInfo(packageName: string): Promise<AppInfo> {
    return this.logCall('getAppInfo', { packageName }, async () => {
      const result = await this.callBridge('getAppInfo', { packageName });
      return result;
    });
  }

  // App lifecycle

  async startApp(packageName: string, activity?: string): Promise<void> {
    let appVersion: string | undefined;
    await this.logCall('startApp', { packageName, activity }, async () => {
      await this.callBridge('startApp', { packageName, activity });
      this.invalidateDOMCache();
      try {
        const info = await this.callBridge('getAppInfo', { packageName });
        appVersion = info.versionName;
        log(`startApp: ${packageName} v${info.versionName} (code ${info.versionCode})`);
      } catch {
        log(`startApp: ${packageName} (version unknown)`);
      }
    }, {
      patchEntry: (entry) => {
        if (appVersion) entry.result = { appVersion };
      },
    });
  }

  async stopApp(packageName: string): Promise<void> {
    await this.logCall('stopApp', { packageName }, async () => {
      await this.callBridge('stopApp', { packageName });
      this.invalidateDOMCache();
    });
  }

  // Input

  async pressKey(key: string): Promise<void> {
    await this.logCall('pressKey', { key }, async () => {
      if (this.platform === 'ios' && this.iosManager) {
        // Map common key names to WDA button names
        const iosButtonMap: Record<string, string> = {
          home: 'home',
          volumeup: 'volumeUp',
          volumedown: 'volumeDown',
        };
        const button = iosButtonMap[key.toLowerCase()];
        if (button) {
          await this.iosManager.wdaPressButton(this.deviceId, button);
          this.iosManager.invalidateDomCache(this.deviceId);
        } else {
          log(`pressKey: iOS does not support key '${key}', ignoring`);
        }
      } else {
        await this.callBridge('pressKey', { key });
      }
      this.invalidateDOMCache();
    });
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration?: number,
  ): Promise<void> {
    await this.logCall('swipe', { startX, startY, endX, endY, duration }, async () => {
      if (this.platform === 'ios' && this.iosManager) {
        await this.iosManager.wdaSwipe(this.deviceId, startX, startY, endX, endY, duration ?? 0.3);
        this.iosManager.invalidateDomCache(this.deviceId);
      } else {
        await this.callBridge('swipe', { startX, startY, endX, endY, duration });
      }
      this.invalidateDOMCache();
    });
  }

  async tapAt(x: number, y: number): Promise<void> {
    await this.logCall('tapAt', { x, y }, async () => {
      if (this.platform === 'ios' && this.iosManager) {
        await this.iosManager.wdaTap(this.deviceId, x, y);
        this.iosManager.invalidateDomCache(this.deviceId);
      } else {
        await this.callBridge('tapAt', { x, y });
      }
      this.invalidateDOMCache();
    });
  }

  // Device

  async deviceInfo(): Promise<DeviceInfo> {
    return this.logCall('deviceInfo', {}, async () => {
      const result = await this.callBridge('deviceInfo', {});
      return result;
    });
  }

  async getCurrentAppId(): Promise<string> {
    return this.logCall('getCurrentAppId', {}, async () => {
      const result = await this.callBridge('getCurrentAppId', {});
      return result;
    });
  }

  async getWebViewInfo(): Promise<WebViewInfo> {
    return this.logCall('getWebViewInfo', {}, async () => {
      return await this.callBridge('getWebViewInfo', {});
    });
  }

  // Higher-level helpers

  async pressButton(selector: Selector, options?: PressButtonOptions): Promise<void> {
    await this.logCall('pressButton', { selector, ...options }, async () => {
      const timeout = options?.timeout;

      this.suppressLogging = true;
      try {
        // Try to scroll to the element first
        try {
          await this.scrollToElement(selector, 5);
        } catch {
          // Element might already be visible
        }

        if (options?.longClick) {
          await this.longClick(selector, options.duration, timeout);
        } else {
          await this.click(selector, timeout);
        }
      } finally {
        this.suppressLogging = false;
      }
    }, { captureDomOnError: true, selector });
  }

  async gatherDOM(options?: GatherDOMOptions): Promise<DOMNode> {
    let lastDOM: DOMNode | null = null;
    return this.logCall('gatherDOM', { ...options }, async () => {
      const maxScrollPages = options?.maxScrollPages ?? 5;

      this.suppressLogging = true;
      try {
        let fullDOM = await this.getDOM();

        for (let i = 0; i < maxScrollPages; i++) {
          try {
            await this.scroll('down', 80);
            await new Promise((resolve) => setTimeout(resolve, 300));
            const pageDOM = await this.getDOM();
            fullDOM = this.mergeDOM(fullDOM, pageDOM);
          } catch {
            break;
          }
        }

        lastDOM = fullDOM;
        return fullDOM;
      } finally {
        this.suppressLogging = false;
      }
    }, { isDomQuery: true, domProvider: () => lastDOM });
  }

  async searchDOM(selector: Selector, options?: SearchDOMOptions): Promise<DOMNode[]> {
    let lastDOM: DOMNode | null = null;
    return this.logCall('searchDOM', { selector, maxScrollPages: options?.maxScrollPages }, async () => {
      this.suppressLogging = true;
      try {
        const dom = options?.dom ?? await this.gatherDOM({ maxScrollPages: options?.maxScrollPages });
        lastDOM = dom;
        return this.findMatchingNodes(dom, selector);
      } finally {
        this.suppressLogging = false;
      }
    }, { isDomQuery: true, selector, domProvider: () => lastDOM });
  }

  async takeScreenshot(name?: string): Promise<string> {
    // Delegate to screenshot() which handles saving to disk, DB, and DOM snapshot
    await this.screenshot(name);
    // Return the filename from the most recent execution log entry
    const lastEntry = this.executionLog[this.executionLog.length - 1];
    return lastEntry?.screenshotFilename || `${this.sessionId}_${name || 'screenshot'}.png`;
  }

  // HTTP helpers

  async httpGet(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.logCall('httpGet', { url, ...options }, async () => {
      const controller = new AbortController();
      const timeoutId = options?.timeout
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: options?.headers,
          signal: controller.signal,
        });

        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        return { status: response.status, headers, body };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    });
  }

  async httpPost(url: string, body: any, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.logCall('httpPost', { url, body, ...options }, async () => {
      const controller = new AbortController();
      const timeoutId = options?.timeout
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...options?.headers,
          },
          body: typeof body === 'string' ? body : JSON.stringify(body),
          signal: controller.signal,
        });

        const responseBody = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        return { status: response.status, headers, body: responseBody };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    });
  }

  // Credentials

  async getCredentials(appId: string): Promise<{ username: string; password: string; customFields: Record<string, string> }> {
    return this.logCall('getCredentials', { appId }, async () => {
      const rows = this.db
        .select()
        .from(credentials)
        .where(eq(credentials.appId, appId))
        .all();

      // Sort by lastUsedAt ASC with nulls first
      rows.sort((a, b) => {
        if (a.lastUsedAt === null && b.lastUsedAt === null) return 0;
        if (a.lastUsedAt === null) return -1;
        if (b.lastUsedAt === null) return 1;
        return (a.lastUsedAt as Date).getTime() - (b.lastUsedAt as Date).getTime();
      });

      if (rows.length === 0) {
        throw new BridgeError(
          BridgeErrorCode.INVALID_REQUEST,
          `No credentials found for app: ${appId}`,
        );
      }

      const selected = rows[0];

      // Update last_used_at
      this.db
        .update(credentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(credentials.id, selected.id))
        .run();

      let customFields: Record<string, string> = {};
      if (selected.customFields) {
        try {
          customFields = JSON.parse(selected.customFields);
        } catch {
          // ignore
        }
      }

      return {
        username: selected.username,
        password: selected.password,
        customFields,
      };
    });
  }

  // Proxy

  async setProxy(mode: 'none' | 'normal' | 'nordvpn', options?: { country?: string }): Promise<void> {
    await this.logCall('setProxy', { mode, ...options }, async () => {
      if (mode === 'nordvpn' && !options?.country) {
        throw new Error('country is required for nordvpn proxy mode');
      }
      if (!this.proxyHandler) {
        throw new Error('Proxy handler not configured');
      }
      await this.proxyHandler(mode, options);
    });
  }

  // TLS profile

  async setTlsProfile(profile: 'chrome' | 'okhttp' | 'default'): Promise<void> {
    await this.logCall('setTlsProfile', { profile }, async () => {
      const validProfiles = ['chrome', 'okhttp', 'default'];
      if (!validProfiles.includes(profile)) {
        throw new Error(`Invalid TLS profile: ${profile}. Must be one of: ${validProfiles.join(', ')}`);
      }
      if (!this.tlsProfileHandler) {
        throw new Error('TLS profile handler not configured');
      }
      await this.tlsProfileHandler(profile);
    });
  }

  // Utilities

  async sleep(ms: number): Promise<void> {
    await this.logCall('sleep', { ms }, () => {
      return new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  // Internal helpers

  private mergeDOM(existing: DOMNode, newPage: DOMNode): DOMNode {
    // Simple merge: add new children that don't already exist
    const existingTexts = new Set(this.collectTexts(existing));
    const newChildren = this.collectLeafNodes(newPage).filter(
      (node) => !existingTexts.has(node.text + node.resourceId),
    );

    return {
      ...existing,
      children: [...existing.children, ...newChildren],
    };
  }

  private collectTexts(node: DOMNode): string[] {
    const texts: string[] = [node.text + node.resourceId];
    for (const child of node.children) {
      texts.push(...this.collectTexts(child));
    }
    return texts;
  }

  private collectLeafNodes(node: DOMNode): DOMNode[] {
    if (node.children.length === 0) return [node];
    const leaves: DOMNode[] = [];
    for (const child of node.children) {
      leaves.push(...this.collectLeafNodes(child));
    }
    return leaves;
  }

  /**
   * Find a matching node in the DOM when native u2 selectors fail.
   * Reuses recently fetched DOM (within TTL) to avoid redundant ADB dumps
   * after waitFor/exists polling that just confirmed the element exists.
   */
  private async findDOMMatch(selector: Selector): Promise<DOMNode | null> {
    this.suppressLogging = true;
    try {
      let dom: DOMNode;
      if (this.cachedDOM) {
        dom = this.cachedDOM;
      } else if (this.lastFetchedDOM && (Date.now() - this.lastDOMFetchTime) < DeviceAPIImpl.DOM_REUSE_TTL_MS) {
        dom = this.lastFetchedDOM;
      } else if (this.platform === 'ios' && this.iosManager) {
        dom = await this.iosManager.wdaDomParsed(this.deviceId);
        this.lastFetchedDOM = dom;
        this.lastDOMFetchTime = Date.now();
      } else {
        dom = await this.callBridge('getDOM', {});
        this.lastFetchedDOM = dom;
        this.lastDOMFetchTime = Date.now();
      }
      return this.findFirstMatchingNode(dom, selector);
    } catch {
      return null;
    } finally {
      this.suppressLogging = false;
    }
  }

  private findMatchingNodes(node: DOMNode, selector: Selector): DOMNode[] {
    const matches: DOMNode[] = [];
    if (this.matchesSelector(node, selector)) {
      matches.push(node);
    }
    for (const child of node.children) {
      matches.push(...this.findMatchingNodes(child, selector));
    }
    return matches;
  }

  private findFirstMatchingNode(node: DOMNode, selector: Selector): DOMNode | null {
    if (this.matchesSelector(node, selector)) return node;
    for (const child of node.children) {
      const match = this.findFirstMatchingNode(child, selector);
      if (match) return match;
    }
    return null;
  }

  private matchesSelector(node: DOMNode, selector: Selector): boolean {
    if (selector.text !== undefined && node.text !== selector.text) return false;
    if (selector.textContains !== undefined && !node.text.includes(selector.textContains)) return false;
    if (selector.textStartsWith !== undefined && !node.text.startsWith(selector.textStartsWith)) return false;
    if (selector.textMatches !== undefined && !new RegExp(selector.textMatches).test(node.text)) return false;
    if (selector.resourceId !== undefined && node.resourceId !== selector.resourceId) return false;
    if (selector.resourceIdMatches !== undefined && !new RegExp(selector.resourceIdMatches).test(node.resourceId)) return false;
    if (selector.className !== undefined && node.className !== selector.className) return false;
    if (selector.classNameMatches !== undefined && !new RegExp(selector.classNameMatches).test(node.className)) return false;
    if (selector.description !== undefined && node.description !== selector.description) return false;
    if (selector.descriptionContains !== undefined && !node.description.includes(selector.descriptionContains)) return false;
    if (selector.descriptionMatches !== undefined && !new RegExp(selector.descriptionMatches).test(node.description)) return false;
    if (selector.clickable !== undefined && node.clickable !== selector.clickable) return false;
    if (selector.enabled !== undefined && node.enabled !== selector.enabled) return false;
    return true;
  }
}
