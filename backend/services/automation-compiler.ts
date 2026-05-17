import ts from 'typescript';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLoggers } from '../logs';
import type { DeviceAPI } from '../../shared/types/automation';
import { executeInSandbox, type SandboxHandle } from './automation-sandbox';

const { log, error } = createLoggers('automation-compiler');

interface CacheEntry {
  hash: string;
  compiled: string;
  timestamp: number;
}

export class AutomationCompiler {
  private compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    strict: true,
    esModuleInterop: true,
  };

  private compilationCache = new Map<string, CacheEntry>();
  private typeDefCache: string | null = null;

  compileWithCache(
    sourceCode: string,
    automationId: string,
  ): { code: string; diagnostics: ts.Diagnostic[] } {
    const hash = createHash('sha256').update(sourceCode).digest('hex');
    const cached = this.compilationCache.get(automationId);

    if (cached && cached.hash === hash) {
      return { code: cached.compiled, diagnostics: [] };
    }

    const result = ts.transpileModule(sourceCode, {
      compilerOptions: this.compilerOptions,
      reportDiagnostics: true,
    });

    this.compilationCache.set(automationId, {
      hash,
      compiled: result.outputText,
      timestamp: Date.now(),
    });

    log(`Compiled automation ${automationId} (${sourceCode.length} chars)`);

    return {
      code: result.outputText,
      diagnostics: result.diagnostics || [],
    };
  }

  async execute(
    compiledCode: string,
    deviceAPI: DeviceAPI,
    context?: Record<string, any>,
  ): Promise<void>;
  async execute(
    compiledCode: string,
    deviceAPI: DeviceAPI,
    context: Record<string, any>,
    options: { keepAlive: true; signal?: AbortSignal },
  ): Promise<SandboxHandle>;
  async execute(
    compiledCode: string,
    deviceAPI: DeviceAPI,
    context: Record<string, any>,
    options: { keepAlive?: false; signal?: AbortSignal },
  ): Promise<void>;
  async execute(
    compiledCode: string,
    deviceAPI: DeviceAPI,
    context: Record<string, any> = {},
    options: { keepAlive?: boolean; signal?: AbortSignal } = {},
  ): Promise<SandboxHandle | void> {
    if (options.keepAlive) {
      return executeInSandbox(compiledCode, deviceAPI, context, { keepAlive: true, signal: options.signal });
    }
    await executeInSandbox(compiledCode, deviceAPI, context, { signal: options.signal });
  }

  getTypeDefinitions(): string {
    if (this.typeDefCache) {
      return this.typeDefCache;
    }

    try {
      const sourceFile = resolve(__dirname, '../../shared/types/automation.ts');
      const program = ts.createProgram([sourceFile], {
        declaration: true,
        emitDeclarationOnly: true,
        strict: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      });

      let dtsOutput = '';
      program.emit(undefined, (fileName, data) => {
        if (fileName.endsWith('.d.ts')) {
          dtsOutput += data;
        }
      });

      if (dtsOutput) {
        this.typeDefCache = this.makeGlobal(dtsOutput);
        return this.typeDefCache;
      }
    } catch (err: any) {
      error(`Failed to generate type definitions: ${err.message}`);
    }

    // Fallback: read source .ts or pre-compiled .d.ts (production build)
    for (const ext of ['automation.ts', 'automation.d.ts']) {
      try {
        const file = resolve(__dirname, '../../shared/types/', ext);
        this.typeDefCache = this.makeGlobal(readFileSync(file, 'utf-8'));
        return this.typeDefCache;
      } catch {
        // try next
      }
    }
    return '';
  }

  /**
   * Strip `export` keywords from type definitions so all types are declared
   * globally in Monaco's editor context. Automation scripts reference DeviceAPI
   * etc. without imports.
   */
  private makeGlobal(dts: string): string {
    const globals = dts
      .replace(/^export declare /gm, 'declare ')
      .replace(/^export interface /gm, 'interface ')
      .replace(/^export type /gm, 'type ')
      .replace(/^export enum /gm, 'enum ')
      .replace(/^export /gm, '');

    // Declare globals so scripts can use them without import.
    // Note: Monaco doesn't have @types/node, so crypto methods must be declared explicitly.
    const extraDecls = `
interface HashObject {
  update(data: string | Buffer): HashObject;
  digest(encoding: 'hex' | 'base64' | 'latin1'): string;
  digest(): Buffer;
}
interface HmacObject {
  update(data: string | Buffer): HmacObject;
  digest(encoding: 'hex' | 'base64' | 'latin1'): string;
  digest(): Buffer;
}
declare const crypto: {
  createHash(algorithm: string): HashObject;
  createHmac(algorithm: string, key: string | Buffer): HmacObject;
  randomBytes(size: number): Buffer;
  randomUUID(): string;
  randomInt(max: number): number;
  randomInt(min: number, max: number): number;
};
declare module 'crypto' {
  function createHash(algorithm: string): HashObject;
  function createHmac(algorithm: string, key: string | Buffer): HmacObject;
  function randomBytes(size: number): Buffer;
  function randomUUID(): string;
  function randomInt(max: number): number;
  function randomInt(min: number, max: number): number;
}
declare class URL {
  constructor(input: string, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}
declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | [string, string][]);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  toString(): string;
  forEach(callback: (value: string, key: string) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
}
declare class TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  readonly encoding: string;
  constructor(label?: string);
  decode(input?: ArrayBuffer | Uint8Array): string;
}

/**
 * Server-side HTTP helpers. Available in every automation, with or without
 * a device. Requests originate from the DarkRide server.
 *
 * setProxy / setTlsProfile state is scoped to the current automation run —
 * each automation gets its own HttpAPI instance.
 */
declare const http: HttpAPI;
`;

    return globals + extraDecls;
  }

  clearCache(automationId?: string): void {
    if (automationId) {
      this.compilationCache.delete(automationId);
    } else {
      this.compilationCache.clear();
    }
  }
}
