import { describe, it, expect, beforeEach } from 'vitest';
import { AutomationCompiler } from './automation-compiler';
import type { DeviceAPI } from '../../shared/types/automation';

describe('AutomationCompiler', () => {
  let compiler: AutomationCompiler;

  beforeEach(() => {
    compiler = new AutomationCompiler();
  });

  describe('compileWithCache', () => {
    it('compiles valid TypeScript to JavaScript', () => {
      const code = `
        export default async function automation(device: any) {
          const x: number = 42;
          return x;
        }
      `;

      const result = compiler.compileWithCache(code, 'test-1');
      expect(result.code).toBeDefined();
      expect(result.code.length).toBeGreaterThan(0);
      expect(result.code).toContain('exports');
      expect(result.diagnostics).toHaveLength(0);
    });

    it('returns cached result for unchanged code', () => {
      const code = `export default async function(device: any) { }`;

      const result1 = compiler.compileWithCache(code, 'test-cache');
      const result2 = compiler.compileWithCache(code, 'test-cache');

      expect(result1.code).toBe(result2.code);
      // Second call should return empty diagnostics (from cache)
      expect(result2.diagnostics).toHaveLength(0);
    });

    it('recompiles when code changes', () => {
      const code1 = `export default async function(d: any) { return 1; }`;
      const code2 = `export default async function(d: any) { return 2; }`;

      const result1 = compiler.compileWithCache(code1, 'test-change');
      const result2 = compiler.compileWithCache(code2, 'test-change');

      expect(result1.code).not.toBe(result2.code);
    });

    it('handles different automation IDs independently', () => {
      const code = `export default async function(d: any) { }`;

      const result1 = compiler.compileWithCache(code, 'id-1');
      const result2 = compiler.compileWithCache(code, 'id-2');

      expect(result1.code).toBe(result2.code);
    });

    it('transpiles TypeScript features correctly', () => {
      const code = `
        interface Foo { bar: string; }
        const fn = (x: Foo): string => x.bar;
        export default async function(device: any) {
          const result = fn({ bar: "hello" });
        }
      `;

      const result = compiler.compileWithCache(code, 'ts-features');
      expect(result.code).toBeDefined();
      // Interface should be stripped
      expect(result.code).not.toContain('interface');
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe('execute', () => {
    it('executes compiled code with default export function', async () => {
      const code = `export default async function(device: any) { }`;
      const compiled = compiler.compileWithCache(code, 'exec-1');

      const mockDevice = {} as DeviceAPI;
      await expect(compiler.execute(compiled.code, mockDevice)).resolves.toBeUndefined();
    });

    it('passes deviceAPI to the automation function', async () => {
      let called = false;
      const code = `
        export default async function(device: any) {
          await device.testMethod();
        }
      `;
      const compiled = compiler.compileWithCache(code, 'exec-device');

      const mockDevice = { testMethod: async () => { called = true; } } as any;
      await compiler.execute(compiled.code, mockDevice);
      expect(called).toBe(true);
    });

    it('throws when no default export is found', async () => {
      const code = `const x = 42;`;
      const compiled = compiler.compileWithCache(code, 'exec-no-export');

      const mockDevice = {} as DeviceAPI;
      await expect(compiler.execute(compiled.code, mockDevice)).rejects.toThrow(
        'Automation must export a default async function',
      );
    });

    it('propagates errors from automation code', async () => {
      const code = `
        export default async function(device: any) {
          throw new Error('automation error');
        }
      `;
      const compiled = compiler.compileWithCache(code, 'exec-error');

      const mockDevice = {} as DeviceAPI;
      await expect(compiler.execute(compiled.code, mockDevice)).rejects.toThrow('automation error');
    });

    it('provides console in sandbox context', async () => {
      const code = `
        export default async function(device: any) {
          console.log('test log');
        }
      `;
      const compiled = compiler.compileWithCache(code, 'exec-console');

      const mockDevice = {} as DeviceAPI;
      // Should not throw — console is available
      await expect(compiler.execute(compiled.code, mockDevice)).resolves.toBeUndefined();
    });

    it('provides dom utilities in sandbox context', async () => {
      let results: any = null;
      const code = `
        export default async function(device: any) {
          const root = {
            className: 'View', text: 'root', resourceId: '', description: '',
            bounds: [0, 0, 100, 100], clickable: false, enabled: true,
            children: [
              { className: 'View', text: 'child', resourceId: '', description: 'desc',
                bounds: [10, 10, 50, 50], clickable: true, enabled: true, children: [] }
            ]
          };
          const found = dom.find(root, (n) => n.clickable);
          await device.report({
            domResult: found ? found.text : null,
            flatCount: dom.flatten(root).length,
            texts: dom.getAllText(root),
          });
        }
      `;
      const compiled = compiler.compileWithCache(code, 'exec-dom');

      const mockDevice = { report: async (data: any) => { results = data; } } as any;
      await compiler.execute(compiled.code, mockDevice);
      expect(results.domResult).toBe('child');
      expect(results.flatCount).toBe(2);
      expect(results.texts).toEqual(['root', 'child', 'desc']);
    });

    it('makes crypto available in sandbox', async () => {
      let hashResult: string | null = null;
      const code = `
        export default async function(device: any) {
          const hash = crypto.createHash('sha256').update('test').digest('hex');
          await device.report(hash);
        }
      `;
      const compiled = compiler.compileWithCache(code, 'exec-crypto');

      const mockDevice = { report: async (val: any) => { hashResult = val; } } as any;
      await compiler.execute(compiled.code, mockDevice);
      expect(hashResult).toBe(require('crypto').createHash('sha256').update('test').digest('hex'));
    });

    it('makes documentStore accessible via context', async () => {
      let getDocCalled = false;
      let putDocCalled = false;
      const code = `
        export default async function(device: any) {
          await documentStore.getDoc('test-id');
          await documentStore.putDoc('test-id', { hello: 'world' });
        }
      `;
      const compiled = compiler.compileWithCache(code, 'exec-docstore');

      const mockDevice = {} as any;
      const mockDocStore = {
        getDoc: async () => { getDocCalled = true; return {}; },
        putDoc: async () => { putDocCalled = true; return {}; },
      };
      await compiler.execute(compiled.code, mockDevice, { documentStore: mockDocStore });
      expect(getDocCalled).toBe(true);
      expect(putDocCalled).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('clears specific automation cache', () => {
      const code = `export default async function(d: any) { }`;
      compiler.compileWithCache(code, 'clear-1');
      compiler.clearCache('clear-1');

      // Should recompile (no cached version)
      const result = compiler.compileWithCache(code, 'clear-1');
      expect(result.code).toBeDefined();
    });

    it('clears all caches when no id provided', () => {
      const code = `export default async function(d: any) { }`;
      compiler.compileWithCache(code, 'clear-all-1');
      compiler.compileWithCache(code, 'clear-all-2');
      compiler.clearCache();

      // Both should recompile
      const result1 = compiler.compileWithCache(code, 'clear-all-1');
      const result2 = compiler.compileWithCache(code, 'clear-all-2');
      expect(result1.code).toBeDefined();
      expect(result2.code).toBeDefined();
    });
  });

  describe('getTypeDefinitions', () => {
    it('returns type definitions string', { timeout: 30000 }, () => {
      const types = compiler.getTypeDefinitions();
      expect(typeof types).toBe('string');
      expect(types.length).toBeGreaterThan(0);
    });

    it('caches type definitions', { timeout: 30000 }, () => {
      const types1 = compiler.getTypeDefinitions();
      const types2 = compiler.getTypeDefinitions();
      expect(types1).toBe(types2);
    });
  });
});
