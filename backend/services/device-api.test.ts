import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as schema from '../db/schema';
import { DeviceAPIImpl, BridgeError } from './device-api';
import { TrafficHookRegistry } from './traffic-hook-registry';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: vi.fn().mockResolvedValue(undefined) };
});

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockJsonRpcResponse(result: any) {
  return {
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', result, id: 'test-id' }),
  };
}

function mockJsonRpcError(code: number, message: string) {
  return {
    ok: true,
    json: () => Promise.resolve({
      jsonrpc: '2.0',
      error: { code, message },
      id: 'test-id',
    }),
  };
}

describe('DeviceAPIImpl', () => {
  let db: AppDatabase;
  let api: DeviceAPIImpl;

  beforeEach(() => {
    db = createTestDb();
    api = new DeviceAPIImpl('test-device', 9100, 1, db, '/tmp/screenshots');
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('click', () => {
    it('sends correct JSON-RPC request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.click({ text: 'Login' }, 5000);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:9100/rpc');
      const body = JSON.parse(options.body);
      expect(body.method).toBe('click');
      expect(body.params.selector).toEqual({ text: 'Login' });
      expect(body.params.timeout).toBe(5000);
    });

    it('clears cached DOM after click', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'OK', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: true, enabled: true, children: [],
        }],
      };
      api.setCachedDOM(dom as any);

      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      await api.click({ text: 'OK' });

      // Cache should be cleared — next exists() must call bridge
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));
      await api.exists({ text: 'OK' });
      // 2 fetch calls: click + getDOM (not using cache)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('longClick', () => {
    it('sends correct parameters', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.longClick({ resourceId: 'btn' }, 2000, 5000);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('longClick');
      expect(body.params.duration).toBe(2000);
      expect(body.params.timeout).toBe(5000);
    });

    it('clears cached DOM after longClick', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      api.setCachedDOM(dom as any);

      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      await api.longClick({ resourceId: 'btn' }, 1000);

      // Cache should be cleared — next getDOM must call bridge
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));
      await api.getDOM();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('setText', () => {
    it('sends text with selector', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.setText({ resourceId: 'input' }, 'hello world');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('setText');
      expect(body.params.text).toBe('hello world');
    });
  });

  describe('getText', () => {
    it('returns text from response', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ text: 'Hello' }));

      const result = await api.getText({ text: 'label' });
      expect(result).toBe('Hello');
    });

    it('falls back to DOM node text when u2 selector fails', async () => {
      const domWithText = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'TextView', text: 'Hello World', resourceId: 'title', description: '',
          bounds: [0, 0, 200, 50], clickable: false, enabled: true, children: [],
        }],
      };

      // u2 getText fails
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));
      // Bridge getDOM returns DOM with matching element
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithText));

      const result = await api.getText({ resourceId: 'title' });
      expect(result).toBe('Hello World');
    });
  });

  describe('exists', () => {
    const domWithButton = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
      children: [{
        className: 'Button', text: 'Button', resourceId: '', description: '',
        bounds: [0, 0, 200, 50], clickable: true, enabled: true, children: [],
      }],
    };

    const emptyDom = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
    };

    it('returns true when element exists in DOM', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));

      const result = await api.exists({ text: 'Button' });
      expect(result).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('getDOM');
    });

    it('returns false when element does not exist in DOM', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      const result = await api.exists({ text: 'Missing' });
      expect(result).toBe(false);
    });

    it('polls with timeout until element appears', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));

      const result = await api.exists({ text: 'Button' }, 5000);
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns false after timeout when element never appears', async () => {
      mockFetch.mockResolvedValue(mockJsonRpcResponse(emptyDom));

      const result = await api.exists({ text: 'Missing' }, 600);
      expect(result).toBe(false);
    });

    it('uses cached DOM without calling bridge when cache is set', async () => {
      api.setCachedDOM(domWithButton as any);

      const result = await api.exists({ text: 'Button' });
      expect(result).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns false from cached DOM when element not present', async () => {
      api.setCachedDOM(emptyDom as any);

      const result = await api.exists({ text: 'Missing' });
      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('waitFor', () => {
    it('resolves immediately when element is in DOM', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'TextView', text: 'Loading...', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: false, enabled: true, children: [],
        }],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      await api.waitFor({ text: 'Loading...' }, 10000);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('getDOM');
    });

    it('throws BridgeError after timeout when element not found', async () => {
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      mockFetch.mockResolvedValue(mockJsonRpcResponse(emptyDom));

      await expect(api.waitFor({ text: 'Missing' }, 600)).rejects.toThrow(BridgeError);
    });

    it('resolves from cached DOM without calling bridge', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'TextView', text: 'Found', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: false, enabled: true, children: [],
        }],
      };
      api.setCachedDOM(dom as any);

      await api.waitFor({ text: 'Found' }, 5000);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws ELEMENT_NOT_FOUND from cached DOM when element missing', async () => {
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      api.setCachedDOM(emptyDom as any);

      await expect(api.waitFor({ text: 'Missing' }, 5000)).rejects.toThrow(BridgeError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('updateDOM', () => {
    it('fetches fresh DOM and updates cache when caching is active', async () => {
      const oldDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      const newDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'New', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: true, enabled: true, children: [],
        }],
      };

      api.setCachedDOM(oldDom as any);
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(newDom));

      const result = await api.updateDOM();
      expect(result.children).toHaveLength(1);

      // Subsequent exists should use the updated cache
      const found = await api.exists({ text: 'New' });
      expect(found).toBe(true);
      // Only 1 fetch call (updateDOM), not 2 (exists used cache)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not set cache when caching is not active', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      await api.updateDOM();

      // Subsequent exists should still call bridge (no cache)
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));
      await api.exists({ text: 'Something' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('scroll', () => {
    it('sends scroll with direction', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.scroll('down', 80);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('scroll');
      expect(body.params.direction).toBe('down');
      expect(body.params.percent).toBe(80);
    });
  });

  describe('scrollToElement', () => {
    it('finds element immediately without scrolling', async () => {
      const domWithTarget = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'Target', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: true, enabled: true, children: [],
        }],
      };
      // getDOM returns element immediately
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithTarget));

      await api.scrollToElement({ text: 'Target' });
      // Only 1 call (getDOM), no scroll needed
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('scrolls then finds element', async () => {
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      const domWithTarget = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'Target', resourceId: '', description: '',
          bounds: [0, 800, 200, 850], clickable: true, enabled: true, children: [],
        }],
      };
      // First getDOM: not found
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));
      // scroll
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      // Second getDOM: found
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithTarget));

      await api.scrollToElement({ text: 'Target' });
    });

    it('throws after max scrolls if element not found', async () => {
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      // Return empty DOM for every getDOM + scroll call
      mockFetch.mockResolvedValue(mockJsonRpcResponse(emptyDom));

      await expect(api.scrollToElement({ text: 'Missing' }, 2)).rejects.toThrow(BridgeError);
    });
  });

  describe('getDOM', () => {
    it('returns DOM tree', async () => {
      const dom = {
        className: 'FrameLayout',
        text: '',
        resourceId: '',
        description: '',
        bounds: [0, 0, 1080, 1920],
        clickable: false,
        enabled: true,
        children: [],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      const result = await api.getDOM();
      expect(result.className).toBe('FrameLayout');
      expect(result.children).toEqual([]);
    });
  });

  describe('screenshot', () => {
    it('returns base64 screenshot', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ base64: 'iVBOR...' }));
      // getDOM call for DOM snapshot capture
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      const result = await api.screenshot('test');
      expect(result).toBe('iVBOR...');
    });
  });

  describe('getAppInfo', () => {
    it('returns app info', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({
        packageName: 'com.test.app',
        name: 'Test App',
        versionCode: 42,
        versionName: '1.0.0',
        apkPath: '/data/app/com.test.app',
      }));

      const result = await api.getAppInfo('com.test.app');
      expect(result.packageName).toBe('com.test.app');
      expect(result.versionCode).toBe(42);
    });
  });

  describe('startApp', () => {
    it('sends startApp request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.startApp('com.test.app', '.MainActivity');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('startApp');
      expect(body.params.packageName).toBe('com.test.app');
      expect(body.params.activity).toBe('.MainActivity');
    });
  });

  describe('stopApp', () => {
    it('sends stopApp request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.stopApp('com.test.app');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('stopApp');
    });
  });

  describe('pressKey', () => {
    it('sends pressKey request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.pressKey('home');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('pressKey');
      expect(body.params.key).toBe('home');
    });
  });

  describe('swipe', () => {
    it('sends swipe with coordinates', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.swipe(100, 200, 300, 400, 500);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('swipe');
      expect(body.params.startX).toBe(100);
      expect(body.params.endY).toBe(400);
      expect(body.params.duration).toBe(500);
    });
  });

  describe('deviceInfo', () => {
    it('returns device info', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({
        serial: 'test-device',
        model: 'Pixel',
        brand: 'Google',
        androidVersion: '13',
        sdkVersion: 33,
        screenSize: { width: 1080, height: 1920 },
        batteryLevel: 85,
      }));

      const result = await api.deviceInfo();
      expect(result.serial).toBe('test-device');
      expect(result.batteryLevel).toBe(85);
    });
  });

  describe('getCurrentAppId', () => {
    it('returns the current foreground app package name', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse('com.example.app'));

      const result = await api.getCurrentAppId();
      expect(result).toBe('com.example.app');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('getCurrentAppId');
    });
  });

  describe('tapAt', () => {
    it('sends correct JSON-RPC request with coordinates', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.tapAt(540, 960);

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('tapAt');
      expect(body.params.x).toBe(540);
      expect(body.params.y).toBe(960);
    });

    it('clears cached DOM after tapAt', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      api.setCachedDOM(dom as any);

      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      await api.tapAt(100, 200);

      // Cache should be cleared
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));
      await api.getDOM();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('click DOM fallback', () => {
    it('falls back to tapAt when native click fails and DOM match found', async () => {
      const domWithButton = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'android.widget.Button', text: 'Submit', resourceId: '', description: '',
          bounds: [100, 200, 300, 250], clickable: true, enabled: true, children: [],
        }],
      };

      // Native click fails with ELEMENT_NOT_FOUND
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));
      // Bridge getDOM returns DOM with matching element
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));
      // tapAt fallback
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.click({ text: 'Submit' });

      // Verify tapAt was called with center of bounds
      const tapCall = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(tapCall.method).toBe('tapAt');
      expect(tapCall.params.x).toBe(200); // (100+300)/2
      expect(tapCall.params.y).toBe(225); // (200+250)/2
    });

    it('re-throws when no DOM match found', async () => {
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };

      // Native click fails
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));
      // Bridge DOM has no matching elements
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      await expect(api.click({ text: 'NonExistent' })).rejects.toThrow(BridgeError);
    });

    it('re-throws non-ELEMENT_NOT_FOUND errors without fallback', async () => {
      // Device disconnected error — should not attempt fallback
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32003, 'Device disconnected'));

      await expect(api.click({ text: 'Button' })).rejects.toThrow(BridgeError);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No fallback attempted
    });
  });

  describe('setText DOM fallback', () => {
    it('falls back to tapAt + bridge setText when native fails and DOM match found', async () => {
      const domWithInput = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'android.widget.EditText', text: '', resourceId: 'email', description: '',
          bounds: [50, 100, 350, 140], clickable: true, enabled: true, children: [],
        }],
      };

      // Native setText fails
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));
      // Bridge getDOM returns DOM with matching input
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithInput));
      // tapAt to focus
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      // setText with empty selector (type into focused element)
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.setText({ resourceId: 'email' }, 'test@example.com');

      const tapCall = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(tapCall.method).toBe('tapAt');
      expect(tapCall.params.x).toBe(200); // (50+350)/2
      expect(tapCall.params.y).toBe(120); // (100+140)/2

      const setTextCall = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(setTextCall.method).toBe('setText');
      expect(setTextCall.params.text).toBe('test@example.com');
    });
  });

  describe('error handling', () => {
    it('throws BridgeError on JSON-RPC error response', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));

      await expect(api.click({ text: 'Missing' })).rejects.toThrow(BridgeError);
    });

    it('throws BridgeError on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(api.click({ text: 'Button' })).rejects.toThrow(BridgeError);
    });

    it('throws BridgeError on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(api.click({ text: 'Button' })).rejects.toThrow();
    });
  });

  describe('pressButton', () => {
    it('clicks element after scrolling to find it', async () => {
      const domWithButton = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'Submit', resourceId: '', description: '',
          bounds: [100, 800, 300, 850], clickable: true, enabled: true, children: [],
        }],
      };
      // scrollToElement: getDOM finds it immediately
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));
      // click call
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.pressButton({ text: 'Submit' });
    });

    it('handles longClick option', async () => {
      const domWithButton = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'Hold', resourceId: '', description: '',
          bounds: [100, 800, 300, 850], clickable: true, enabled: true, children: [],
        }],
      };
      // scrollToElement: getDOM finds it immediately
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));
      // longClick call
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.pressButton({ text: 'Hold' }, { longClick: true, duration: 2000 });

      const longClickCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(longClickCall.method).toBe('longClick');
    });
  });

  describe('searchDOM', () => {
    it('finds matching nodes in provided DOM', async () => {
      const dom = {
        className: 'FrameLayout',
        text: '',
        resourceId: '',
        description: '',
        bounds: [0, 0, 1080, 1920] as [number, number, number, number],
        clickable: false,
        enabled: true,
        children: [
          {
            className: 'Button',
            text: 'Login',
            resourceId: 'btn_login',
            description: '',
            bounds: [100, 200, 300, 250] as [number, number, number, number],
            clickable: true,
            enabled: true,
            children: [],
          },
          {
            className: 'Button',
            text: 'Register',
            resourceId: 'btn_register',
            description: '',
            bounds: [100, 300, 300, 350] as [number, number, number, number],
            clickable: true,
            enabled: true,
            children: [],
          },
        ],
      };

      const results = await api.searchDOM({ text: 'Login' }, { dom });
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('Login');
    });

    it('returns empty for non-matching selector', async () => {
      const dom = {
        className: 'FrameLayout',
        text: '',
        resourceId: '',
        description: '',
        bounds: [0, 0, 1080, 1920] as [number, number, number, number],
        clickable: false,
        enabled: true,
        children: [],
      };

      const results = await api.searchDOM({ text: 'NonExistent' }, { dom });
      expect(results).toHaveLength(0);
    });

    it('matches textContains selector', async () => {
      const dom = {
        className: 'TextView',
        text: 'Hello World',
        resourceId: '',
        description: '',
        bounds: [0, 0, 100, 50] as [number, number, number, number],
        clickable: false,
        enabled: true,
        children: [],
      };

      const results = await api.searchDOM({ textContains: 'World' }, { dom });
      expect(results).toHaveLength(1);
    });
  });

  describe('getWebViewInfo', () => {
    it('returns pages array on success', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({
        pages: [
          { url: 'https://accounts.google.com/login', title: 'Sign in', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/1' },
          { url: 'about:blank', title: '', webSocketDebuggerUrl: null },
        ],
      }));

      const result = await api.getWebViewInfo();
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].url).toBe('https://accounts.google.com/login');
      expect(result.pages[0].title).toBe('Sign in');
      expect(result.pages[1].url).toBe('about:blank');
    });

    it('returns empty pages when no WebViews found', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ pages: [] }));

      const result = await api.getWebViewInfo();
      expect(result.pages).toHaveLength(0);
    });

    it('propagates bridge errors', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32003, 'Device disconnected'));

      await expect(api.getWebViewInfo()).rejects.toThrow(BridgeError);
    });

    it('sends correct JSON-RPC method', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ pages: [] }));

      await api.getWebViewInfo();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('getWebViewInfo');
      expect(body.params).toEqual({});
    });
  });

  describe('httpGet', () => {
    it('makes GET request and returns response', async () => {
      // Reset fetch mock for HTTP helpers (different from bridge calls)
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () => Promise.resolve('{"data": "test"}'),
        headers: new Map([['content-type', 'application/json']]),
      });

      const result = await api.httpGet('https://api.example.com/data');
      expect(result.status).toBe(200);
      expect(result.body).toBe('{"data": "test"}');
    });
  });

  describe('httpPost', () => {
    it('makes POST request with body', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
        text: () => Promise.resolve('{"id": 1}'),
        headers: new Map([['content-type', 'application/json']]),
      });

      const result = await api.httpPost('https://api.example.com/data', { key: 'value' });
      expect(result.status).toBe(201);
    });
  });

  describe('execution logging', () => {
    it('logs click with params and duration', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.click({ text: 'Login' }, 5000);

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('click');
      expect(log[0].params).toEqual({ selector: { text: 'Login' }, timeout: 5000 });
      expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(log[0].timestamp).toBeDefined();
      expect(log[0].error).toBeUndefined();
    });

    it('logs errors on failed calls', async () => {
      // click fails with ELEMENT_NOT_FOUND
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));
      // findDOMMatch: ADB fails (default), bridge DOM is empty
      const emptyDom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      await expect(api.click({ text: 'Missing' })).rejects.toThrow(BridgeError);

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('click');
      expect(log[0].error).toBe('Element not found');
    });

    it('captures DOM snapshot for exists()', async () => {
      const domWithButton = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'OK', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: true, enabled: true, children: [],
        }],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));

      const result = await api.exists({ text: 'OK' });
      expect(result).toBe(true);

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('exists');
      expect(log[0].domSnapshot).toBeDefined();
      expect(log[0].selector).toEqual({ text: 'OK' });
      expect(JSON.parse(log[0].domSnapshot!).children[0].text).toBe('OK');
    });

    it('logs getText return value', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ text: 'Hello World' }));

      const result = await api.getText({ text: 'label' });
      expect(result).toBe('Hello World');

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('getText');
      expect(log[0].result).toBe('Hello World');
    });

    it('screenshot persists file and logs filename', async () => {
      const base64 = 'iVBOR...';
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ base64 }));
      // getDOM call for DOM snapshot
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      const result = await api.screenshot('test-shot');
      expect(result).toBe(base64);

      // Verify file was written
      expect(fs.writeFile).toHaveBeenCalledOnce();
      const writtenPath = (fs.writeFile as any).mock.calls[0][0] as string;
      expect(writtenPath).toContain('test-shot.png');

      // Verify DB entry
      const rows = db.select().from(schema.screenshots).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].filename).toContain('test-shot.png');

      // Verify execution log
      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('screenshot');
      expect(log[0].screenshotFilename).toContain('test-shot.png');
    });

    it('sleep logged with duration', async () => {
      await api.sleep(10);

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('sleep');
      expect(log[0].params).toEqual({ ms: 10 });
      expect(log[0].durationMs).toBeGreaterThanOrEqual(5);
    });

    it('does not double-log inner calls from DOM-query methods', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'Button', text: 'OK', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: true, enabled: true, children: [],
        }],
      };
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      await api.exists({ text: 'OK' });

      // Should only have 1 entry for exists(), not 2 (exists + getDOM)
      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('exists');
    });

    it('accumulates multiple calls in order', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.click({ text: 'A' });
      await api.pressKey('home');

      const log = api.getExecutionLog();
      expect(log).toHaveLength(2);
      expect(log[0].method).toBe('click');
      expect(log[1].method).toBe('pressKey');
    });
  });

  describe('getCredentials', () => {
    it('returns credential when one exists', async () => {
      const now = new Date();
      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user1',
        password: 'pass1',
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = await api.getCredentials('com.example.app');
      expect(result.username).toBe('user1');
      expect(result.password).toBe('pass1');
      expect(result.customFields).toEqual({});
    });

    it('round-robins across multiple credentials (returns least recently used)', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 10000);

      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user1',
        password: 'pass1',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user2',
        password: 'pass2',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: past,
      }).run();

      // Should return user2 (least recently used)
      const result = await api.getCredentials('com.example.app');
      expect(result.username).toBe('user2');
    });

    it('prefers null lastUsedAt (never used)', async () => {
      const now = new Date();

      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user1',
        password: 'pass1',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user-never-used',
        password: 'pass2',
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = await api.getCredentials('com.example.app');
      expect(result.username).toBe('user-never-used');
    });

    it('updates lastUsedAt timestamp', async () => {
      const now = new Date();
      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user1',
        password: 'pass1',
        createdAt: now,
        updatedAt: now,
      }).run();

      await api.getCredentials('com.example.app');

      const rows = db.select().from(schema.credentials).all();
      expect(rows[0].lastUsedAt).not.toBeNull();
    });

    it('parses customFields JSON', async () => {
      const now = new Date();
      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'user1',
        password: 'pass1',
        customFields: JSON.stringify({ apiKey: 'abc123', region: 'us-east' }),
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = await api.getCredentials('com.example.app');
      expect(result.customFields).toEqual({ apiKey: 'abc123', region: 'us-east' });
    });

    it('throws error when no credentials found', async () => {
      await expect(api.getCredentials('com.nonexistent')).rejects.toThrow(
        'No credentials found for app: com.nonexistent',
      );
    });

    it('only returns credentials matching requested appId', async () => {
      const now = new Date();
      db.insert(schema.credentials).values({
        appId: 'com.other.app',
        username: 'other',
        password: 'other',
        createdAt: now,
        updatedAt: now,
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.target.app',
        username: 'target',
        password: 'target',
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = await api.getCredentials('com.target.app');
      expect(result.username).toBe('target');
    });
  });

  describe('setProxy', () => {
    it('calls proxy handler with correct args', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setProxyHandler(handler);

      await api.setProxy('nordvpn', { country: 'us' });

      expect(handler).toHaveBeenCalledWith('nordvpn', { country: 'us' });
    });

    it('calls proxy handler for normal mode', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setProxyHandler(handler);

      await api.setProxy('normal');

      expect(handler).toHaveBeenCalledWith('normal', undefined);
    });

    it('calls proxy handler for none mode', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setProxyHandler(handler);

      await api.setProxy('none');

      expect(handler).toHaveBeenCalledWith('none', undefined);
    });

    it('throws without country for nordvpn mode', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setProxyHandler(handler);

      await expect(api.setProxy('nordvpn')).rejects.toThrow('country is required for nordvpn proxy mode');
      expect(handler).not.toHaveBeenCalled();
    });

    it('throws when no handler set', async () => {
      await expect(api.setProxy('normal')).rejects.toThrow('Proxy handler not configured');
    });

    it('appears in execution log', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setProxyHandler(handler);

      await api.setProxy('nordvpn', { country: 'de' });

      const log = api.getExecutionLog();
      const entry = log.find((e) => e.method === 'setProxy');
      expect(entry).toBeDefined();
      expect(entry!.params.mode).toBe('nordvpn');
      expect(entry!.params.country).toBe('de');
    });
  });

  describe('setTlsProfile', () => {
    it('calls handler with correct args', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setTlsProfileHandler(handler);

      await api.setTlsProfile('okhttp');

      expect(handler).toHaveBeenCalledWith('okhttp');
    });

    it('calls handler for chrome profile', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setTlsProfileHandler(handler);

      await api.setTlsProfile('chrome');

      expect(handler).toHaveBeenCalledWith('chrome');
    });

    it('calls handler for default profile', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setTlsProfileHandler(handler);

      await api.setTlsProfile('default');

      expect(handler).toHaveBeenCalledWith('default');
    });

    it('throws when no handler set', async () => {
      await expect(api.setTlsProfile('chrome')).rejects.toThrow('TLS profile handler not configured');
    });

    it('appears in execution log', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      api.setTlsProfileHandler(handler);

      await api.setTlsProfile('okhttp');

      const log = api.getExecutionLog();
      const entry = log.find((e) => e.method === 'setTlsProfile');
      expect(entry).toBeDefined();
      expect(entry!.params.profile).toBe('okhttp');
    });
  });

  describe('ATX-free mode', () => {
    const domWithButton = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
      children: [{
        className: 'Button', text: 'Submit', resourceId: '', description: '',
        bounds: [100, 200, 300, 250], clickable: true, enabled: true, children: [],
      }],
    };

    const domWithInput = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
      children: [{
        className: 'EditText', text: '', resourceId: 'email', description: '',
        bounds: [50, 100, 350, 140], clickable: true, enabled: true, children: [],
      }],
    };

    const domWithText = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
      children: [{
        className: 'TextView', text: 'Hello World', resourceId: 'title', description: '',
        bounds: [0, 0, 200, 50], clickable: false, enabled: true, children: [],
      }],
    };

    const emptyDom = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920], clickable: false, enabled: true, children: [],
    };

    beforeEach(async () => {
      // Enable ATX-free mode
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true, atxFree: true }));
      await api.setATXFree(true);
      mockFetch.mockReset();
    });

    it('setATXFree sends correct bridge RPC', async () => {
      // Already called in beforeEach, verify it was called correctly
      // Re-test explicitly
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true, atxFree: false }));
      await api.setATXFree(false);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('setATXFree');
      expect(body.params.enabled).toBe(false);
    });

    it('click skips bridge click, goes directly to getDOM + tapAt', async () => {
      // getDOM for findDOMMatch
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));
      // tapAt
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.click({ text: 'Submit' });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const getDomCall = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(getDomCall.method).toBe('getDOM');
      const tapCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(tapCall.method).toBe('tapAt');
      expect(tapCall.params.x).toBe(200); // (100+300)/2
      expect(tapCall.params.y).toBe(225); // (200+250)/2
    });

    it('click throws ELEMENT_NOT_FOUND when element not in DOM', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      await expect(api.click({ text: 'NonExistent' })).rejects.toThrow(BridgeError);
      // Only 1 call (getDOM), no tapAt attempted
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('longClick goes to DOM + longClickAt', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithButton));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.longClick({ text: 'Submit' }, 2000);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const longClickCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(longClickCall.method).toBe('longClickAt');
      expect(longClickCall.params.x).toBe(200);
      expect(longClickCall.params.y).toBe(225);
      expect(longClickCall.params.duration).toBe(2000);
    });

    it('setText uses inputText RPC instead of bridge setText', async () => {
      // getDOM for findDOMMatch
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithInput));
      // tapAt to focus
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));
      // inputText
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.setText({ resourceId: 'email' }, 'test@example.com');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const tapCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(tapCall.method).toBe('tapAt');
      const inputTextCall = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(inputTextCall.method).toBe('inputText');
      expect(inputTextCall.params.text).toBe('test@example.com');
    });

    it('getText reads from DOM directly with only 1 bridge call', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithText));

      const result = await api.getText({ resourceId: 'title' });
      expect(result).toBe('Hello World');
      // Only 1 call: getDOM for findDOMMatch
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('getText throws when element not in DOM', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      await expect(api.getText({ resourceId: 'missing' })).rejects.toThrow(BridgeError);
    });
  });

  describe('captureDomOnError', () => {
    it('waitForAndClick timeout attaches last polled DOM to log entry', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'TextView', text: 'Wrong text', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: false, enabled: true, children: [],
        }],
      };
      // waitFor polls getDOM repeatedly — always return DOM without matching element
      mockFetch.mockResolvedValue(mockJsonRpcResponse(dom));

      await expect(api.waitForAndClick({ text: 'Login' }, 600)).rejects.toThrow(BridgeError);

      const log = api.getExecutionLog();
      // Only the outer waitForAndClick should be logged (inner calls suppressed)
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('waitForAndClick');
      expect(log[0].error).toBeDefined();
      expect(log[0].domSnapshot).toBeDefined();
      const snapshot = JSON.parse(log[0].domSnapshot!);
      expect(snapshot.children[0].text).toBe('Wrong text');
    });

    it('click element-not-found attaches DOM from findDOMMatch fallback', async () => {
      const dom = {
        className: 'FrameLayout', text: '', resourceId: '', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [{
          className: 'TextView', text: 'Something else', resourceId: '', description: '',
          bounds: [0, 0, 200, 50], clickable: false, enabled: true, children: [],
        }],
      };

      // Native click fails with ELEMENT_NOT_FOUND
      mockFetch.mockResolvedValueOnce(mockJsonRpcError(-32001, 'Element not found'));
      // findDOMMatch: getDOM returns DOM without matching element
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(dom));

      await expect(api.click({ text: 'Missing' })).rejects.toThrow(BridgeError);

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('click');
      expect(log[0].error).toBeDefined();
      expect(log[0].domSnapshot).toBeDefined();
      const snapshot = JSON.parse(log[0].domSnapshot!);
      expect(snapshot.children[0].text).toBe('Something else');
    });

    it('successful click does NOT attach domSnapshot', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.click({ text: 'OK' });

      const log = api.getExecutionLog();
      expect(log).toHaveLength(1);
      expect(log[0].method).toBe('click');
      expect(log[0].error).toBeUndefined();
      expect(log[0].domSnapshot).toBeUndefined();
    });
  });

  describe('device.http', () => {
    it('exists and works when registry is provided', () => {
      const registry = new TrafficHookRegistry();
      const apiWithRegistry = new DeviceAPIImpl('test-device', 9100, 1, db, '/tmp/screenshots', registry);
      const hookId = apiWithRegistry.http.hook({ hostname: /disney/ }, async () => {});
      expect(typeof hookId).toBe('string');
      expect(registry.hasHooks('test-device')).toBe(true);
    });

    it('throws when no registry provided (NoopDeviceHTTP)', () => {
      // Default api has no registry
      expect(() => api.http.hook({ hostname: /disney/ })).toThrow('Traffic hooks require HTTPS capture');
    });
  });

  describe('existsAny', () => {
    const domWithSkip = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920] as [number, number, number, number], clickable: false, enabled: true,
      children: [{
        className: 'Button', text: 'Skip', resourceId: '', description: '',
        bounds: [100, 200, 300, 260] as [number, number, number, number], clickable: true, enabled: true, children: [],
      }],
    };

    const emptyDom = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920] as [number, number, number, number], clickable: false, enabled: true, children: [],
    };

    it('returns matching selector when second of three matches', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithSkip));

      const result = await api.existsAny([
        { text: 'Get Started' },
        { text: 'Skip' },
        { text: 'Continue' },
      ]);
      expect(result).toEqual({ text: 'Skip' });
    });

    it('returns null when no selectors match', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      const result = await api.existsAny([
        { text: 'Get Started' },
        { text: 'Skip' },
      ]);
      expect(result).toBeNull();
    });

    it('polls with timeout until a selector appears', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithSkip));

      const result = await api.existsAny([
        { text: 'Get Started' },
        { text: 'Skip' },
      ], 5000);
      expect(result).toEqual({ text: 'Skip' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('uses cached DOM when available', async () => {
      api.setCachedDOM(domWithSkip as any);

      const result = await api.existsAny([
        { text: 'Get Started' },
        { text: 'Skip' },
      ]);
      expect(result).toEqual({ text: 'Skip' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null from cached DOM when no selectors match', async () => {
      api.setCachedDOM(emptyDom as any);

      const result = await api.existsAny([
        { text: 'Get Started' },
        { text: 'Skip' },
      ]);
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('clickAny', () => {
    const domWithSkip = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920] as [number, number, number, number], clickable: false, enabled: true,
      children: [{
        className: 'Button', text: 'Skip', resourceId: '', description: '',
        bounds: [100, 200, 300, 260] as [number, number, number, number], clickable: true, enabled: true, children: [],
      }],
    };

    const emptyDom = {
      className: 'FrameLayout', text: '', resourceId: '', description: '',
      bounds: [0, 0, 1080, 1920] as [number, number, number, number], clickable: false, enabled: true, children: [],
    };

    it('clicks first matching selector and returns true', async () => {
      // getDOM
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithSkip));
      // tapAt
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      const result = await api.clickAny([
        { text: 'Get Started' },
        { text: 'Skip' },
        { text: 'Continue' },
      ]);
      expect(result).toBe(true);

      // Second call should be tapAt
      const tapBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(tapBody.method).toBe('tapAt');
    });

    it('returns false when no selectors match', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));

      const result = await api.clickAny([
        { text: 'Get Started' },
        { text: 'Skip' },
      ]);
      expect(result).toBe(false);
    });

    it('taps at correct center coordinates from DOM bounds', async () => {
      // Skip button bounds: [100, 200, 300, 260] → center (200, 230)
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithSkip));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.clickAny([{ text: 'Skip' }]);

      const tapBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(tapBody.params.x).toBe(200);
      expect(tapBody.params.y).toBe(230);
    });

    it('clears cachedDOM after click', async () => {
      // getDOM returns dom with OK button
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithSkip));
      // tapAt
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      await api.clickAny([{ text: 'Skip' }]);

      // Cache should be cleared — next exists() must call bridge
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));
      await api.exists({ text: 'Skip' });
      // 3 calls: getDOM + tapAt + getDOM (not using cache)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('polls with timeout until a selector appears and clicks it', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(emptyDom));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse(domWithSkip));
      mockFetch.mockResolvedValueOnce(mockJsonRpcResponse({ success: true }));

      const result = await api.clickAny([
        { text: 'Get Started' },
        { text: 'Skip' },
      ], 5000);
      expect(result).toBe(true);
      // getDOM (empty) + getDOM (with skip) + tapAt
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // ─── Deviceless mode: bridgePort === 0 ───────────────────────────────────
  describe('deviceless callBridge guard', () => {
    it('device.tapAt throws a clear "requires device" error when bridgePort is 0', async () => {
      const devicelessApi = new DeviceAPIImpl('', 0, 1, db, '/tmp/screenshots');
      await expect(devicelessApi.tapAt(100, 200)).rejects.toThrow(/requires a connected device/i);
    });

    it('device.httpGet still works in deviceless mode (uses global fetch, no bridge)', async () => {
      const devicelessApi = new DeviceAPIImpl('', 0, 1, db, '/tmp/screenshots');
      mockFetch.mockResolvedValueOnce(new Response('hello', { status: 200 }));
      const res = await devicelessApi.httpGet('https://example.com');
      expect(res.status).toBe(200);
      expect(res.body).toBe('hello');
    });

    it('device.sleep still works in deviceless mode (no bridge)', async () => {
      const devicelessApi = new DeviceAPIImpl('', 0, 1, db, '/tmp/screenshots');
      const start = Date.now();
      await devicelessApi.sleep(5);
      expect(Date.now() - start).toBeGreaterThanOrEqual(4);
    });
  });
});
