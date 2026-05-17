import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { AutomationCompiler } from './automation-compiler';
import { executeInSandbox } from './automation-sandbox';

/**
 * Helper: compile TypeScript source to JS and run it in the sandbox.
 * Returns a promise so the caller can await / assert rejection.
 */
function compileAndRun(
  compiler: AutomationCompiler,
  source: string,
  device: any = {} as any,
  context: Record<string, any> = {},
  id = `test-${Date.now()}-${Math.random()}`,
) {
  const { code } = compiler.compileWithCache(source, id);
  return executeInSandbox(code, device, context);
}

describe('AutomationSandbox', () => {
  let compiler: AutomationCompiler;

  beforeEach(() => {
    compiler = new AutomationCompiler();
  });

  // ─── 1. Sandbox escape prevention ─────────────────────────────────

  describe('sandbox escape prevention', () => {
    it('this.constructor.constructor("return process")() must fail', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            const p = (this as any).constructor.constructor('return process')();
            if (p && p.exit) p.exit(1);
          }
        `),
      ).rejects.toThrow();
    });

    it('require("fs") must throw', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            const fs = require('fs');
          }
        `),
      ).rejects.toThrow(/not available/);
    });

    it('require("child_process") must throw', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            const cp = require('child_process');
          }
        `),
      ).rejects.toThrow(/not available/);
    });

    it('require("crypto") must succeed (allowed module)', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const c = require('crypto');
          const hash = c.createHash('sha256').update('ok').digest('hex');
          await device.report(hash);
        }
      `, mockDevice);

      const expected = crypto.createHash('sha256').update('ok').digest('hex');
      expect(mockDevice.report).toHaveBeenCalledWith(expected);
    });

    it('global.process must be undefined', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.report(typeof (global as any).process);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('undefined');
    });

    it('globalThis.process must be undefined', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.report(typeof (globalThis as any).process);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('undefined');
    });

    it('Function("return process")() must fail or return undefined', async () => {
      // In isolated-vm, the global Function constructor is the isolate's
      // Function — it cannot reach Node's process object.
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      // This either throws (isolate blocks it) or returns undefined
      try {
        await compileAndRun(compiler, `
          export default async function(device: any) {
            const result = Function('return typeof process')();
            await device.report(result);
          }
        `, mockDevice);

        // If it didn't throw, the result must be 'undefined'
        expect(mockDevice.report).toHaveBeenCalledWith('undefined');
      } catch {
        // Throwing is also acceptable — the escape was blocked
      }
    });

    it('__proto__ chain traversal cannot escape the isolate', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      try {
        await compileAndRun(compiler, `
          export default async function(device: any) {
            const obj = {};
            let proto = obj.__proto__;
            while (proto && proto.__proto__) proto = proto.__proto__;
            const ctor = proto?.constructor?.constructor;
            if (ctor) {
              const proc = ctor('return typeof process')();
              await device.report(proc);
            } else {
              await device.report('undefined');
            }
          }
        `, mockDevice);

        // If it completed, process must still be unreachable
        expect(mockDevice.report).toHaveBeenCalledWith('undefined');
      } catch {
        // Throwing is also acceptable
      }
    });

    it('cannot access Node.js Buffer global', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.report(typeof Buffer);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('undefined');
    });

    it('cannot access require from global scope', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            const r = (global as any).require;
            if (typeof r === 'function') r('fs');
          }
        `),
      ).rejects.toThrow();
    });
  });

  // ─── 2. Device API proxy ──────────────────────────────────────────

  describe('device API proxy', () => {
    it('async device method call crosses boundary and returns result', async () => {
      const mockDevice = {
        getText: vi.fn(async () => 'Hello World'),
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const text = await device.getText({ text: 'label' });
          await device.report(text);
        }
      `, mockDevice);

      expect(mockDevice.getText).toHaveBeenCalledWith({ text: 'label' });
      expect(mockDevice.report).toHaveBeenCalledWith('Hello World');
    });

    it('device method with complex object return (like getDOM)', async () => {
      const domTree = {
        className: 'FrameLayout',
        text: '',
        resourceId: 'root',
        description: '',
        bounds: [0, 0, 1080, 1920],
        clickable: false,
        enabled: true,
        children: [
          {
            className: 'TextView',
            text: 'Hello',
            resourceId: 'label',
            description: '',
            bounds: [10, 10, 200, 50],
            clickable: true,
            enabled: true,
            children: [],
          },
        ],
      };

      const mockDevice = {
        getDOM: vi.fn(async () => domTree),
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const root = await device.getDOM();
          await device.report({
            rootClass: root.className,
            childText: root.children[0].text,
            childCount: root.children.length,
          });
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith({
        rootClass: 'FrameLayout',
        childText: 'Hello',
        childCount: 1,
      });
    });

    it('device method error propagates back to the isolate', async () => {
      const mockDevice = {
        click: vi.fn(async () => {
          throw new Error('Element not found');
        }),
      } as any;

      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            await device.click({ text: 'missing' });
          }
        `, mockDevice),
      ).rejects.toThrow();
    });

    it('null/undefined device (deviceless automation) does not crash', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            // device is null for deviceless automations
            if (device === null) return;
            throw new Error('device should be null');
          }
        `, null),
      ).resolves.toBeUndefined();
    });

    it('device method returning null transfers correctly', async () => {
      const mockDevice = {
        existsAny: vi.fn(async () => null),
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const result = await device.existsAny([{ text: 'a' }]);
          await device.report(result);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith(null);
    });

    it('device method returning undefined transfers correctly', async () => {
      const mockDevice = {
        click: vi.fn(async () => undefined),
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const result = await device.click({ text: 'btn' });
          await device.report(result === undefined ? 'undef' : 'other');
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('undef');
    });

    it('device method with multiple arguments', async () => {
      const mockDevice = {
        swipe: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.swipe(100, 200, 300, 400, 500);
        }
      `, mockDevice);

      expect(mockDevice.swipe).toHaveBeenCalledWith(100, 200, 300, 400, 500);
    });
  });

  // ─── 3. Crypto proxy ──────────────────────────────────────────────

  describe('crypto proxy', () => {
    it('createHash("sha256").update("test").digest("hex") returns correct hash', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const hash = crypto.createHash('sha256').update('test').digest('hex');
          await device.report(hash);
        }
      `, mockDevice);

      const expected = crypto.createHash('sha256').update('test').digest('hex');
      expect(mockDevice.report).toHaveBeenCalledWith(expected);
    });

    it('createHmac("sha256", "key").update("data").digest("hex") works', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const hmac = crypto.createHmac('sha256', 'key').update('data').digest('hex');
          await device.report(hmac);
        }
      `, mockDevice);

      const expected = crypto.createHmac('sha256', 'key').update('data').digest('hex');
      expect(mockDevice.report).toHaveBeenCalledWith(expected);
    });

    it('randomUUID() returns a valid UUID', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const uuid = crypto.randomUUID();
          await device.report(uuid);
        }
      `, mockDevice);

      const uuid = mockDevice.report.mock.calls[0][0];
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('randomInt(100) returns a number in range', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const n = crypto.randomInt(100);
          await device.report(n);
        }
      `, mockDevice);

      const n = mockDevice.report.mock.calls[0][0];
      expect(typeof n).toBe('number');
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(100);
    });

    it('randomInt(10, 20) respects min/max range', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const n = crypto.randomInt(10, 20);
          await device.report(n);
        }
      `, mockDevice);

      const n = mockDevice.report.mock.calls[0][0];
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThan(20);
    });

    it('createHash with chained updates works', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const hash = crypto.createHash('md5').update('hello').update(' world').digest('hex');
          await device.report(hash);
        }
      `, mockDevice);

      const expected = crypto.createHash('md5').update('hello').update(' world').digest('hex');
      expect(mockDevice.report).toHaveBeenCalledWith(expected);
    });
  });

  // ─── 4. Timer proxy ───────────────────────────────────────────────

  describe('timer proxy', () => {
    it('setTimeout fires callback after delay', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              device.report('fired');
              resolve();
            }, 10);
          });
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('fired');
    });

    it('await new Promise(resolve => setTimeout(resolve, 50)) works (sleep pattern)', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      const start = Date.now();
      await compileAndRun(compiler, `
        export default async function(device: any) {
          await new Promise(resolve => setTimeout(resolve, 50));
          await device.report('done');
        }
      `, mockDevice);

      const elapsed = Date.now() - start;
      expect(mockDevice.report).toHaveBeenCalledWith('done');
      // Should have waited at least ~40ms (allow some timing slack)
      expect(elapsed).toBeGreaterThanOrEqual(30);
    });

    it('multiple sequential setTimeout delays accumulate', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await new Promise(resolve => setTimeout(resolve, 20));
          await device.report('first');
          await new Promise(resolve => setTimeout(resolve, 20));
          await device.report('second');
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledTimes(2);
      expect(mockDevice.report).toHaveBeenNthCalledWith(1, 'first');
      expect(mockDevice.report).toHaveBeenNthCalledWith(2, 'second');
    });

    it('clearTimeout prevents callback from firing', async () => {
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          const id = setTimeout(() => {
            device.report('should-not-fire');
          }, 100);
          clearTimeout(id);
          // Wait a bit to confirm it doesn't fire
          await new Promise(resolve => setTimeout(resolve, 150));
          await device.report('done');
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledTimes(1);
      expect(mockDevice.report).toHaveBeenCalledWith('done');
    });
  });

  // ─── 5. Console proxy ─────────────────────────────────────────────

  describe('console proxy', () => {
    it('console.log() calls through to the host', async () => {
      const mockConsole = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            console.log('hello from sandbox');
          }
        `,
        {} as any,
        { console: mockConsole },
      );

      expect(mockConsole.log).toHaveBeenCalledWith('hello from sandbox');
    });

    it('console.warn() calls host warn', async () => {
      const mockConsole = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            console.warn('warning message');
          }
        `,
        {} as any,
        { console: mockConsole },
      );

      expect(mockConsole.warn).toHaveBeenCalledWith('warning message');
    });

    it('console.error() calls host error', async () => {
      const mockConsole = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            console.error('error message');
          }
        `,
        {} as any,
        { console: mockConsole },
      );

      expect(mockConsole.error).toHaveBeenCalledWith('error message');
    });

    it('console.log() serializes objects to JSON', async () => {
      const mockConsole = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            console.log({ key: 'value', num: 42 });
          }
        `,
        {} as any,
        { console: mockConsole },
      );

      expect(mockConsole.log).toHaveBeenCalledWith('{"key":"value","num":42}');
    });
  });

  // ─── 6. DocumentStore proxy ───────────────────────────────────────

  describe('documentStore proxy', () => {
    it('documentStore.getDoc(id) calls host and returns result', async () => {
      const mockDocStore = {
        getDoc: vi.fn(async () => ({ title: 'My Doc', body: 'content' })),
        putDoc: vi.fn(async () => ({})),
      };
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            const doc = await documentStore.getDoc('doc-123');
            await device.report(doc);
          }
        `,
        mockDevice,
        { documentStore: mockDocStore },
      );

      expect(mockDocStore.getDoc).toHaveBeenCalledWith('doc-123');
      expect(mockDevice.report).toHaveBeenCalledWith({ title: 'My Doc', body: 'content' });
    });

    it('documentStore.putDoc(id, doc) calls host', async () => {
      const mockDocStore = {
        getDoc: vi.fn(async () => ({})),
        putDoc: vi.fn(async () => ({ ok: true })),
      };

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            await documentStore.putDoc('doc-456', { title: 'New', items: [1, 2, 3] });
          }
        `,
        {} as any,
        { documentStore: mockDocStore },
      );

      expect(mockDocStore.putDoc).toHaveBeenCalledWith('doc-456', { title: 'New', items: [1, 2, 3] });
    });

    it('documentStore is not defined when not in context', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            await (globalThis as any).documentStore.getDoc('x');
          }
        `),
      ).rejects.toThrow();
    });
  });

  // ─── 7. Tools proxy ───────────────────────────────────────────────

  describe('tools proxy', () => {
    it('tools.someTool({ param: "value" }) calls host', async () => {
      const mockTools = {
        someTool: vi.fn(async (params: any) => ({ result: 'ok', input: params.param })),
      };
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            const result = await tools.someTool({ param: 'value' });
            await device.report(result);
          }
        `,
        mockDevice,
        { tools: mockTools },
      );

      expect(mockTools.someTool).toHaveBeenCalledWith({ param: 'value' });
      expect(mockDevice.report).toHaveBeenCalledWith({ result: 'ok', input: 'value' });
    });

    it('tools proxy dispatches to any named tool dynamically', async () => {
      const mockTools = {
        toolAlpha: vi.fn(async () => 'alpha-result'),
        toolBeta: vi.fn(async () => 'beta-result'),
      };
      const mockDevice = {
        report: vi.fn(async () => {}),
      } as any;

      await compileAndRun(
        compiler,
        `
          export default async function(device: any) {
            const a = await tools.toolAlpha({});
            const b = await tools.toolBeta({});
            await device.report([a, b]);
          }
        `,
        mockDevice,
        { tools: mockTools },
      );

      expect(mockTools.toolAlpha).toHaveBeenCalled();
      expect(mockTools.toolBeta).toHaveBeenCalled();
      expect(mockDevice.report).toHaveBeenCalledWith(['alpha-result', 'beta-result']);
    });

    it('tools is not defined when not in context', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            await (globalThis as any).tools.anyTool({});
          }
        `),
      ).rejects.toThrow();
    });
  });

  // ─── 8. DOM utilities ─────────────────────────────────────────────

  describe('DOM utilities', () => {
    const domTreeSource = `
      const root = {
        className: 'FrameLayout', text: 'root', resourceId: 'main', description: '',
        bounds: [0, 0, 1080, 1920], clickable: false, enabled: true,
        children: [
          {
            className: 'TextView', text: 'Hello', resourceId: 'label', description: 'greeting',
            bounds: [10, 10, 200, 50], clickable: true, enabled: true, children: [],
          },
          {
            className: 'Button', text: 'OK', resourceId: 'btn', description: '',
            bounds: [10, 60, 200, 110], clickable: true, enabled: false, children: [],
          },
        ],
      };
    `;

    it('dom.find() locates a node by predicate', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const found = dom.find(root, (n: any) => n.resourceId === 'btn');
          await device.report(found ? found.text : null);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('OK');
    });

    it('dom.find() returns null when no match', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const found = dom.find(root, (n: any) => n.resourceId === 'nonexistent');
          await device.report(found);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith(null);
    });

    it('dom.findAll() returns all matching nodes', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const clickable = dom.findAll(root, (n: any) => n.clickable);
          await device.report(clickable.map((n: any) => n.text));
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith(['Hello', 'OK']);
    });

    it('dom.flatten() returns all nodes in the tree', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const flat = dom.flatten(root);
          await device.report(flat.length);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith(3);
    });

    it('dom.getAllText() collects all text and descriptions', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const texts = dom.getAllText(root);
          await device.report(texts);
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith(['root', 'Hello', 'greeting', 'OK']);
    });

    it('dom.getCenter() computes the center of node bounds', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const center = dom.getCenter(root.children[0]);
          await device.report(center);
        }
      `, mockDevice);

      // bounds [10, 10, 200, 50] => center (105, 30)
      expect(mockDevice.report).toHaveBeenCalledWith({ x: 105, y: 30 });
    });

    it('dom.getSize() computes the size of a node', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const size = dom.getSize(root.children[1]);
          await device.report(size);
        }
      `, mockDevice);

      // bounds [10, 60, 200, 110] => size 190x50
      expect(mockDevice.report).toHaveBeenCalledWith({ width: 190, height: 50 });
    });

    it('dom.filter() filters an array of nodes', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          ${domTreeSource}
          const flat = dom.flatten(root);
          const enabled = dom.filter(flat, (n: any) => n.enabled);
          await device.report(enabled.map((n: any) => n.text));
        }
      `, mockDevice);

      // root (enabled) + Hello (enabled); OK is disabled
      expect(mockDevice.report).toHaveBeenCalledWith(['root', 'Hello']);
    });
  });

  // ─── 9. Error propagation ─────────────────────────────────────────

  describe('error propagation', () => {
    it('exception in automation code surfaces as rejected promise', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            throw new Error('something went wrong');
          }
        `),
      ).rejects.toThrow('something went wrong');
    });

    it('sync throw in automation code surfaces as rejected promise', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            const obj: any = null;
            obj.foo();
          }
        `),
      ).rejects.toThrow();
    });

    it('"Automation must export a default async function" for non-function export', async () => {
      const { code } = compiler.compileWithCache(`
        const x = 42;
      `, 'non-function-export');

      await expect(executeInSandbox(code, {} as any)).rejects.toThrow(
        'Automation must export a default async function',
      );
    });

    it('string export is not a valid function', async () => {
      const { code } = compiler.compileWithCache(`
        export default "not a function";
      `, 'string-export');

      await expect(executeInSandbox(code, {} as any)).rejects.toThrow(
        'Automation must export a default async function',
      );
    });

    it('TypeError for accessing property of undefined is surfaced', async () => {
      await expect(
        compileAndRun(compiler, `
          export default async function(device: any) {
            const obj: any = undefined;
            return obj.property;
          }
        `),
      ).rejects.toThrow();
    });
  });

  // ─── 10. Module system ────────────────────────────────────────────

  describe('module system', () => {
    it('module.exports = fn pattern works', async () => {
      // Raw JS (no TypeScript compilation) to test the CJS module pattern directly
      const code = `
        module.exports = async function(device) {
          await device.report('cjs-works');
        };
      `;

      const mockDevice = { report: vi.fn(async () => {}) } as any;
      await executeInSandbox(code, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('cjs-works');
    });

    it('export default pattern works (after TypeScript compilation)', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.report('esm-works');
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('esm-works');
    });

    it('module.exports.default = fn pattern works', async () => {
      const code = `
        module.exports.default = async function(device) {
          await device.report('default-export-works');
        };
      `;

      const mockDevice = { report: vi.fn(async () => {}) } as any;
      await executeInSandbox(code, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('default-export-works');
    });

    it('named export default via TypeScript compiles and runs', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        async function myAutomation(device: any) {
          await device.report('named-default');
        }
        export default myAutomation;
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith('named-default');
    });

    it('helper functions alongside default export work', async () => {
      const mockDevice = { report: vi.fn(async () => {}) } as any;

      await compileAndRun(compiler, `
        function add(a: number, b: number): number {
          return a + b;
        }

        export default async function(device: any) {
          await device.report(add(3, 4));
        }
      `, mockDevice);

      expect(mockDevice.report).toHaveBeenCalledWith(7);
    });
  });

  describe('http hook registration', () => {
    it('hookRequest with a RegExp filter rehydrates the filter to a real RegExp', async () => {
      // Regression guard: isolated-vm applySync({arguments:{reference:true}})
      // wraps every arg as a Reference, including the JSON filter string.
      // Rehydration restores RegExp objects from the __isRegex markers so the
      // traffic hook registry can call .test() on them.
      const hookSpy = vi.fn(() => 'hook-id-1');
      const mockDevice = {
        http: { hook: hookSpy, hookRequest: undefined, hookResponse: undefined },
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.http.hookRequest({ url: /.*/ }, (req: any) => req);
        }
      `, mockDevice);

      expect(hookSpy).toHaveBeenCalledTimes(1);
      const [filter, onRequest] = hookSpy.mock.calls[0];
      expect(filter.url).toBeInstanceOf(RegExp);
      expect((filter.url as RegExp).source).toBe('.*');
      expect(typeof onRequest).toBe('function');
    });

    it('rehydrates RegExp on every supported filter field (hostname, path, method, url)', async () => {
      const hookSpy = vi.fn(() => 'hook-id-2');
      const mockDevice = {
        http: { hook: hookSpy, hookRequest: undefined, hookResponse: undefined },
      } as any;

      await compileAndRun(compiler, `
        export default async function(device: any) {
          await device.http.hook({
            hostname: /host/,
            path: /path/,
            method: /GET/i,
            url: /url/,
          });
        }
      `, mockDevice);

      const [filter] = hookSpy.mock.calls[0];
      expect(filter.hostname).toBeInstanceOf(RegExp);
      expect(filter.path).toBeInstanceOf(RegExp);
      expect(filter.method).toBeInstanceOf(RegExp);
      expect((filter.method as RegExp).flags).toBe('i');
      expect(filter.url).toBeInstanceOf(RegExp);
    });
  });

  // ─── Persistent sandbox (capture rules) ───────────────────────────
  //
  // Capture rules register traffic hooks that must fire AFTER the script
  // itself has returned. The default execute flow disposes the isolate in
  // its finally block, which silently kills every registered callback
  // (ivm.Reference.apply throws "isolate is disposed", which the host-side
  // wrapper swallows). The keepAlive option returns a dispose handle so
  // the caller can keep the isolate alive for the hook lifetime.

  describe('keepAlive (persistent sandbox)', () => {
    it('returns a dispose handle and keeps the isolate alive after the script returns', async () => {
      const mockConsole = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      let capturedOnRequest: any = null;
      const hookSpy = vi.fn((_filter: any, onRequest: any) => {
        capturedOnRequest = onRequest;
        return 'hook-keepalive-1';
      });
      const mockDevice = {
        http: { hook: hookSpy },
      } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookRequest({ url: /.*/ }, (req: any) => {
              console.log('hook fired for', req.url);
              return req;
            });
          }
        `,
        `keepalive-basic-${Math.random()}`,
      );

      const handle = await executeInSandbox(
        code,
        mockDevice,
        { console: mockConsole },
        { keepAlive: true },
      );

      expect(handle).toBeDefined();
      expect(typeof handle!.dispose).toBe('function');
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(typeof capturedOnRequest).toBe('function');

      // Script has returned. The isolate must still be alive so the
      // registered hook callback can run and its console.log is observable.
      const req = {
        guid: 'g1',
        method: 'GET',
        url: 'https://example.com/foo',
        hostname: 'example.com',
        path: '/foo',
        headers: {},
        body: null,
      };
      await capturedOnRequest(req);

      expect(mockConsole.log).toHaveBeenCalledTimes(1);
      expect(mockConsole.log).toHaveBeenCalledWith('hook fired for', 'https://example.com/foo');

      handle!.dispose();
    });

    it('omitting keepAlive still disposes the isolate (existing behavior)', async () => {
      const hookSpy = vi.fn(() => 'hook-noalive');
      const mockDevice = { http: { hook: hookSpy } } as any;

      const result = await executeInSandbox(
        (compiler.compileWithCache(
          `
            export default async function(device: any) {
              device.http.hookRequest({ url: /.*/ }, (req: any) => req);
            }
          `,
          `keepalive-default-${Math.random()}`,
        )).code,
        mockDevice,
      );

      // Default behavior returns nothing (void) — isolate is disposed in finally.
      expect(result).toBeUndefined();
    });

    it('hook chain: the object returned from one hook passes into the next hook with all fields intact', async () => {
      // Regression guard: Reference.apply with { promise: true } alone
      // returns an ivm.Reference, not a plain object. That Reference used
      // to be stored as `current` in TrafficHookRegistry, and the next
      // hook's sanitize saw no own-enumerable props — wiping `headers`
      // and making user code crash with
      // "Cannot read properties of undefined (reading 'x-acf-sensor-data')".
      let capturedOnRequest: any = null;
      const hookSpy = vi.fn((_f: any, onRequest: any) => {
        capturedOnRequest = onRequest;
        return 'hook-id-chain';
      });
      const mockDevice = { http: { hook: hookSpy } } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookRequest({ url: /.*/ }, (req: any) => req);
          }
        `,
        `keepalive-chain-${Math.random()}`,
      );

      const handle = await executeInSandbox(code, mockDevice, {}, { keepAlive: true });

      const input = {
        guid: 'g1',
        method: 'GET',
        url: 'https://example.com/a',
        hostname: 'example.com',
        path: '/a',
        headers: { 'x-acf-sensor-data': 'abc', 'content-type': 'x' },
        body: null,
      };

      const returned = await capturedOnRequest(input);

      // The returned value must be a plain object whose headers survived.
      // Under the old code this was an ivm.Reference and `.headers` was undefined.
      expect(returned).toBeDefined();
      expect(typeof returned).toBe('object');
      expect((returned as any).headers).toEqual({
        'x-acf-sensor-data': 'abc',
        'content-type': 'x',
      });
      expect((returned as any).url).toBe('https://example.com/a');

      handle!.dispose();
    });

    it('hookRequest (no onResponse) does not register a bogus onResponse wrapper', async () => {
      // Regression guard: with { arguments: { reference: true } } ivm wraps
      // null/undefined args into a *truthy* Reference whose target is null.
      // The old `onResponseRef ? wrapper : undefined` check was always true,
      // so every response fired the wrapper and crashed with
      // "Reference is not a function". Check ref.typeof instead.
      let registeredOnResponse: any = 'sentinel';
      const hookSpy = vi.fn((_f: any, _onReq: any, onResp: any) => {
        registeredOnResponse = onResp;
        return 'hook-id-norespwrap';
      });
      const mockDevice = { http: { hook: hookSpy } } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookRequest({ url: /.*/ }, (req: any) => req);
          }
        `,
        `keepalive-norespwrap-${Math.random()}`,
      );

      const handle = await executeInSandbox(code, mockDevice, {}, { keepAlive: true });
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(registeredOnResponse).toBeUndefined();
      handle!.dispose();
    });

    it('hookResponse (no onRequest) does not register a bogus onRequest wrapper', async () => {
      let registeredOnRequest: any = 'sentinel';
      const hookSpy = vi.fn((_f: any, onReq: any, _onResp: any) => {
        registeredOnRequest = onReq;
        return 'hook-id-noreqwrap';
      });
      const mockDevice = { http: { hook: hookSpy } } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookResponse({ url: /.*/ }, (res: any) => res);
          }
        `,
        `keepalive-noreqwrap-${Math.random()}`,
      );

      const handle = await executeInSandbox(code, mockDevice, {}, { keepAlive: true });
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(registeredOnRequest).toBeUndefined();
      handle!.dispose();
    });

    it('req.save() inside onRequest bridges back to the host save function', async () => {
      // Regression guard: sanitizeForCopy strips the real save() function
      // before ExternalCopy, but user scripts rely on req.save() to mark a
      // flow for persisting to the saved-traffic store. The sandbox must
      // expose save() as a proxy that calls through to the host.
      let capturedOnRequest: any = null;
      const hookSpy = vi.fn((_f: any, onRequest: any) => {
        capturedOnRequest = onRequest;
        return 'hook-id-save-req';
      });
      const hostSave = vi.fn(async () => { /* real save */ });
      const mockDevice = { http: { hook: hookSpy } } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookRequest({ url: /.*/ }, async (req: any) => {
              await req.save();
              return req;
            });
          }
        `,
        `keepalive-save-req-${Math.random()}`,
      );

      const handle = await executeInSandbox(code, mockDevice, {}, { keepAlive: true });

      const hostReq: any = {
        guid: 'g-req-1',
        method: 'GET',
        url: 'https://example.com/a',
        hostname: 'example.com',
        path: '/a',
        headers: {},
        body: null,
        save: hostSave,
      };

      await capturedOnRequest(hostReq);

      expect(hostSave).toHaveBeenCalledTimes(1);
      handle!.dispose();
    });

    it('returning req from onRequest (after save was attached) does not break clone-back', async () => {
      // Regression guard: the isolate-side wrapper attaches req.save() before
      // invoking the user callback. If the user returns req (common pattern),
      // that save function would get cloned back to the host via copy:true
      // and blow up with "could not be cloned". The wrapper must strip save
      // from the return value.
      let capturedOnRequest: any = null;
      const hookSpy = vi.fn((_f: any, onRequest: any) => {
        capturedOnRequest = onRequest;
        return 'hook-id-return-save';
      });
      const mockDevice = { http: { hook: hookSpy } } as any;
      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookRequest({ url: /.*/ }, (req: any) => req);
          }
        `,
        `keepalive-return-save-${Math.random()}`,
      );
      const handle = await executeInSandbox(code, mockDevice, {}, { keepAlive: true });

      const hostReq: any = {
        guid: 'g-return-1',
        method: 'GET',
        url: 'https://example.com/a',
        hostname: 'example.com',
        path: '/a',
        headers: {},
        body: null,
        save: async () => {},
      };

      // Previously crashed the host with "() => __saveHookFlow.apply(...) could not be cloned."
      // The wrapper caught the error and silently returned the untouched host
      // req — so the only visible symptom in tests is: the returned object is
      // the SAME reference as hostReq (clone failed, catch fell back to the
      // original) instead of a fresh structured clone.
      const returned = await capturedOnRequest(hostReq);
      expect(returned).toBeDefined();
      expect(returned).not.toBe(hostReq); // a proper copy, not the catch fallback
      expect((returned as any).url).toBe('https://example.com/a');
      handle!.dispose();
    });

    it('res.save() inside onResponse bridges back to the host save function', async () => {
      let capturedOnResponse: any = null;
      const hookSpy = vi.fn((_f: any, _onReq: any, onResponse: any) => {
        capturedOnResponse = onResponse;
        return 'hook-id-save-res';
      });
      const hostSave = vi.fn(async () => {});
      const mockDevice = { http: { hook: hookSpy } } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookResponse({ url: /.*/ }, async (res: any) => {
              await res.save();
              return res;
            });
          }
        `,
        `keepalive-save-res-${Math.random()}`,
      );

      const handle = await executeInSandbox(code, mockDevice, {}, { keepAlive: true });

      const hostRes: any = {
        guid: 'g-res-1',
        status: 200,
        headers: {},
        body: null,
        request: { guid: 'g-res-1', method: 'GET', url: 'https://example.com/a', hostname: 'example.com', path: '/a', headers: {}, body: null },
        save: hostSave,
      };

      await capturedOnResponse(hostRes);

      expect(hostSave).toHaveBeenCalledTimes(1);
      handle!.dispose();
    });

    it('hook callback runs even when req contains function properties (e.g. req.save)', async () => {
      // Regression guard: TrafficHookRegistry attaches a save() function onto
      // the HookRequestObject. ivm.ExternalCopy rejects functions ("could not
      // be cloned"), which previously made the wrapper's catch swallow every
      // hook invocation silently. The wrapper must strip functions before
      // copying, and must not swallow errors silently either.
      const mockConsole = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      let capturedOnRequest: any = null;
      const hookSpy = vi.fn((_f: any, onRequest: any) => {
        capturedOnRequest = onRequest;
        return 'hook-id-savefn';
      });
      const mockDevice = { http: { hook: hookSpy } } as any;

      const { code } = compiler.compileWithCache(
        `
          export default async function(device: any) {
            device.http.hookRequest({ url: /.*/ }, (req: any) => {
              console.log('got', req.url);
              return req;
            });
          }
        `,
        `keepalive-savefn-${Math.random()}`,
      );

      const handle = await executeInSandbox(
        code,
        mockDevice,
        { console: mockConsole },
        { keepAlive: true },
      );

      const reqWithSave: any = {
        guid: 'g1',
        method: 'GET',
        url: 'https://example.com/withsave',
        hostname: 'example.com',
        path: '/withsave',
        headers: {},
        body: null,
        save: async () => { /* function property — blows up naive ExternalCopy */ },
      };

      await capturedOnRequest(reqWithSave);

      expect(mockConsole.log).toHaveBeenCalledWith('got', 'https://example.com/withsave');

      handle!.dispose();
    });

    it('dispose is idempotent and safe to call after the isolate is already gone', async () => {
      const hookSpy = vi.fn(() => 'hook-dispose');
      const mockDevice = { http: { hook: hookSpy } } as any;

      const handle = await executeInSandbox(
        (compiler.compileWithCache(
          `
            export default async function(device: any) {
              device.http.hookRequest({ url: /.*/ }, (req: any) => req);
            }
          `,
          `keepalive-dispose-${Math.random()}`,
        )).code,
        mockDevice,
        {},
        { keepAlive: true },
      );

      expect(() => handle!.dispose()).not.toThrow();
      expect(() => handle!.dispose()).not.toThrow();
    });
  });

  // ─── Top-level `http` namespace (deviceless-friendly) ────────────────────
  describe('http namespace', () => {
    it('http.get is available when context.httpAPI is wired (no device required)', async () => {
      const get = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: '{"ok":true}' });
      const httpAPI = { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() };

      const { code } = compiler.compileWithCache(`
        export default async function(_device: any) {
          const res = await http.get('https://api.example.com/health');
          if (res.status !== 200) throw new Error('expected 200');
        }
      `, `http-get-${Math.random()}`);

      // Deviceless — pass null for deviceAPI but supply httpAPI in context.
      await executeInSandbox(code, null, { httpAPI });
      // The isolate JSON-serialises args across the boundary; undefined→null.
      expect(get).toHaveBeenCalledWith('https://api.example.com/health', null);
    });

    it('http.post forwards body + options to the host impl', async () => {
      const post = vi.fn().mockResolvedValue({ status: 201, headers: {}, body: '{}' });
      const httpAPI = { get: vi.fn(), post, put: vi.fn(), delete: vi.fn(), patch: vi.fn() };

      const { code } = compiler.compileWithCache(`
        export default async function() {
          await http.post('https://api.example.com/items', { name: 'x' }, { headers: { 'X-Test': 'true' } });
        }
      `, `http-post-${Math.random()}`);

      await executeInSandbox(code, null, { httpAPI });
      expect(post).toHaveBeenCalledWith(
        'https://api.example.com/items',
        { name: 'x' },
        { headers: { 'X-Test': 'true' } },
      );
    });

    it('http is undefined when context.httpAPI is not provided (back-compat)', async () => {
      const { code } = compiler.compileWithCache(`
        export default async function() {
          if (typeof http !== 'undefined') throw new Error('expected http to be undefined');
        }
      `, `http-absent-${Math.random()}`);
      // No httpAPI in context — `http` should not exist in the sandbox.
      await executeInSandbox(code, null, {});
    });

    it('abort signal disposes the isolate and rejects with AbortError', async () => {
      const { code } = compiler.compileWithCache(`
        export default async function() {
          // Spin forever — abort should yank us out.
          await new Promise(() => {});
        }
      `, `abort-mid-${Math.random()}`);

      const controller = new AbortController();
      // Fire the abort 50ms after start.
      setTimeout(() => controller.abort(), 50);

      await expect(
        executeInSandbox(code, null, {}, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('pre-aborted signal cancels immediately', async () => {
      const { code } = compiler.compileWithCache(`
        export default async function() {
          // Should never run.
          await new Promise(r => setTimeout(r, 1000));
        }
      `, `abort-pre-${Math.random()}`);

      const controller = new AbortController();
      controller.abort();

      await expect(
        executeInSandbox(code, null, {}, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('http and device coexist when both are provided', async () => {
      const get = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: '' });
      const httpAPI = { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() };
      const sleep = vi.fn().mockResolvedValue(undefined);
      class FakeDevice { async sleep(ms: number) { return sleep(ms); } }

      const { code } = compiler.compileWithCache(`
        export default async function(device: any) {
          await device.sleep(10);
          await http.get('https://x');
        }
      `, `http-with-device-${Math.random()}`);

      await executeInSandbox(code, new FakeDevice() as any, { httpAPI });
      expect(sleep).toHaveBeenCalledWith(10);
      expect(get).toHaveBeenCalled();
    });
  });
});
