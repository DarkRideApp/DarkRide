import { describe, it, expect } from 'vitest';
import { API_REFERENCE, CATEGORY_LABELS, CATEGORY_ORDER, buildAiReferencePrompt } from './api-reference';
import type { DeviceAPI, DOMUtils } from './types/automation';

// Extract method names from interfaces at type level
type DeviceAPIMethods = keyof Omit<DeviceAPI, 'http'>;
type DOMUtilsMethods = keyof DOMUtils;
type DeviceHTTPMethods = keyof DeviceAPI['http'];

// These are the method names from each interface — kept in sync manually
const DEVICE_API_METHODS: DeviceAPIMethods[] = [
  'click', 'longClick', 'setText', 'getText', 'exists', 'waitFor', 'waitForAndClick',
  'scroll', 'scrollToElement',
  'getDOM', 'updateDOM', 'screenshot', 'getAppInfo',
  'startApp', 'stopApp',
  'pressKey', 'swipe', 'tapAt',
  'deviceInfo', 'getWebViewInfo',
  'pressButton', 'gatherDOM', 'searchDOM',
  'httpGet', 'httpPost',
  'getCredentials',
  'setProxy', 'setTlsProfile',
  'sleep',
];

const DOM_UTILS_METHODS: DOMUtilsMethods[] = [
  'findAll', 'find', 'flatten', 'filter', 'getCenter', 'getSize', 'getAllText',
];

const DEVICE_HTTP_METHODS: DeviceHTTPMethods[] = [
  'hook', 'hookRequest', 'hookResponse', 'unhook', 'unhookAll',
];

describe('API Reference', () => {
  it('has an entry for every DeviceAPI method', () => {
    for (const method of DEVICE_API_METHODS) {
      const entry = API_REFERENCE.find(e => e.name === method && e.object === 'device');
      expect(entry, `Missing entry for device.${method}`).toBeDefined();
    }
  });

  it('has an entry for every DOMUtils method', () => {
    for (const method of DOM_UTILS_METHODS) {
      const entry = API_REFERENCE.find(e => e.name === method && e.object === 'dom');
      expect(entry, `Missing entry for dom.${method}`).toBeDefined();
    }
  });

  it('has an entry for every DeviceHTTP method', () => {
    for (const method of DEVICE_HTTP_METHODS) {
      const entry = API_REFERENCE.find(e => e.name === method && e.object === 'device.http');
      expect(entry, `Missing entry for device.http.${method}`).toBeDefined();
    }
  });

  it('has no duplicate entries', () => {
    const keys = API_REFERENCE.map(e => `${e.object}.${e.name}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('has all fields non-empty for every entry', () => {
    for (const entry of API_REFERENCE) {
      expect(entry.name, `Empty name`).toBeTruthy();
      expect(entry.object, `Empty object for ${entry.name}`).toBeTruthy();
      expect(entry.signature, `Empty signature for ${entry.name}`).toBeTruthy();
      expect(entry.description, `Empty description for ${entry.name}`).toBeTruthy();
      expect(entry.example, `Empty example for ${entry.name}`).toBeTruthy();
      expect(entry.category, `Empty category for ${entry.name}`).toBeTruthy();
    }
  });

  it('uses only valid categories', () => {
    for (const entry of API_REFERENCE) {
      expect(CATEGORY_LABELS[entry.category], `Unknown category "${entry.category}" for ${entry.name}`).toBeDefined();
    }
  });

  it('CATEGORY_ORDER includes all used categories', () => {
    const usedCategories = new Set(API_REFERENCE.map(e => e.category));
    for (const cat of usedCategories) {
      expect(CATEGORY_ORDER).toContain(cat);
    }
  });

  describe('buildAiReferencePrompt', () => {
    const prompt = buildAiReferencePrompt();

    it('returns a non-empty string', () => {
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes all function names', () => {
      for (const entry of API_REFERENCE) {
        expect(prompt, `Missing ${entry.object}.${entry.name} in AI prompt`).toContain(entry.name);
      }
    });

    it('includes category headers', () => {
      for (const cat of CATEGORY_ORDER) {
        const label = CATEGORY_LABELS[cat];
        if (API_REFERENCE.some(e => e.category === cat)) {
          expect(prompt).toContain(`[${label}]`);
        }
      }
    });

    it('includes Selector fields reference', () => {
      expect(prompt).toContain('Selector fields:');
      expect(prompt).toContain('textContains');
      expect(prompt).toContain('resourceId');
    });

    it('includes TrafficFilter fields reference', () => {
      expect(prompt).toContain('TrafficFilter fields:');
      expect(prompt).toContain('hostname');
    });
  });
});
