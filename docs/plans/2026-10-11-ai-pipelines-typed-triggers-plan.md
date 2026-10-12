# AI job pipelines: typed event triggers + unified node-function registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Trigger node can fire from a typed internal HookBus event (not only a manually-invoked function), and Sink/Trigger/Transform's three divergent "registered function" patterns collapse onto one shared contract.

**Architecture:** `HookBus.define`'s dead, already-built schema-declaration feature becomes the typed event catalog (no new registry). `TriggerConfig` gains a `source: 'function' | 'event'` discriminant — same NodeKind, same picker, two sources. A new `HookTriggerDispatcher` subscribes published event-sourced Triggers to HookBus and calls the existing `startPipelineRun` on fire. Sink/Trigger/Transform's hand-rolled registries move onto one generic `createFunctionRegistry<Fn>()` factory, exported names unchanged.

**Tech Stack:** TypeScript, Express, Drizzle/better-sqlite3, React, @xyflow/react, Vitest, Playwright — all already in place, no new dependencies.

**Spec:** `docs/specs/2026-10-11-ai-pipelines-typed-triggers-design.md`

## Global Constraints

- `HookBus.define`'s signature changes from `(name: string, schema?: Record<string, string>) => void` to `(name: string, schema: SchemaField[], description: string) => void` — safe, zero existing callers (verified: `grep -rn "\.define(" backend/ packages/plugin-sdk/src` finds no real call site).
- Every existing exported registry name stays stable through the function-registry merge: `SINK_REGISTRY`, `SINK_DESCRIPTIONS`, `SINK_USES_SECTION`, `TRIGGER_REGISTRY`, `TRIGGER_DESCRIPTIONS`, `TRIGGER_SCHEMAS`. No import-site churn in `apk-analysis-pipeline.ts`, any `nodes/*.test.ts`, or `backend/index.ts`.
- `TriggerConfig.source: 'function' | 'event'`. Every reader (`runTrigger`, `graph-validator.ts`, `SidePanel.tsx`'s `TriggerBody`, `Canvas.tsx`) treats a missing `source` as `'function'` — `config.source ?? 'function'` — no migration script for existing graph JSON.
- `apk-analysis/apk-context`'s real contract (name, 7-field `outputSchema`, `{versionId: apk-version}` `inputSchema`) is load-bearing production data — do not change its values, only where they're declared.
- `StartPipelineRunOptions.triggeredBy` widens from `'manual' | 'apk-analysis-complete'` to `'manual' | 'event'`. Every reference updates: `run-executor.ts:17`, `db/schema.ts:821` (comment only), `apk-analyzer.ts:1043` (the real call site), and the 4 test literal occurrences across `run-executor.test.ts` (3×) and `apk-analyzer.test.ts` (1×).
- Non-goals — do not do these as part of this plan: no `AiToolRegistry` bridge; no migrating `trigger-full`/`trigger-rescan` to `source: 'event'` (their hook payload's `apkVersionId` field doesn't match `apk-analysis/apk-context`'s expected `versionId` — out of scope, see spec); no fabricated `couchbase.*` event.
- `packages/plugin-sdk` is a separate workspace package backend/frontend import from its built `dist/` output, not its `src/` directly (confirmed: root `tsconfig.json`'s `paths` point at `./packages/plugin-sdk/dist/...`). Any task touching `packages/plugin-sdk/src/**` must run `npm run build -w @darkrideapp/plugin-sdk` from the repo root before backend/frontend code can see the change — included explicitly in Task 1's steps.

## Review Focus

1. An event-sourced Trigger's side panel must actually hide the Run button and run form, not just add a message next to a still-clickable Run button that does nothing meaningful. Covered in Task 12's tests.
2. Switching a Trigger's "Starts from" between a function and an event must fully clear the fields that don't apply to the new mode — a stale `eventName` surviving a switch back to `source: 'function'`, or a stale `expandFn`/`inputSchema` surviving a switch to `source: 'event'`, must not round-trip through a save. Covered in Task 12's tests.
3. `HookTriggerDispatcher.refresh()` called twice (e.g. two publishes in a row) must not double-subscribe the same event name — `HookBusImpl.on` dedupes by handler *reference* via a `Set`, which only works if `refresh()` reuses one handler per event name across calls rather than creating a fresh closure each time. Covered in Task 9's tests.
4. Un-publishing the only pipeline version bound to an event name (a newer version published without that binding, or the version demoted back to draft) must make the dispatcher actually call `hookBus.off` for that name — tested in the "drops a stale subscription" direction, not just "adds a new one." Covered in Task 9's tests.
5. `createFunctionRegistry`'s `register()` called twice with the same name must keep today's silent last-write-wins behavter (plain object assignment) — the merge must not introduce a new throw-on-duplicate behavior nothing in the existing code expects or tests for. Covered in Task 2's tests.

---

### Task 1: `HookBus.define` carries a real schema, and gets wired at both real emit sites

**Files:**
- Modify: `packages/plugin-sdk/src/types/hooks.ts`
- Modify: `packages/plugin-sdk/src/hook-bus-impl.ts`
- Create: `packages/plugin-sdk/src/__tests__/hook-bus-impl.test.ts`
- Modify: `backend/services/apk-analyzer.ts` (`setHookBus`, around line 72)
- Modify: `backend/services/apk-tracker.ts` (`setHookBus`, around line 247)
- Modify: `backend/services/apk-analyzer.test.ts` (add a schema-declaration assertion)
- Modify: `backend/services/apk-tracker.test.ts` (add a schema-declaration assertion)

**Interfaces:**
- Consumes: nothing from an earlier task (this is the foundation).
- Produces: `HookBus.define(name: string, schema: SchemaField[], description: string): void` and `HookBusImpl.getDefinedHooks(): HookDefinition[]` where `HookDefinition = { name: string; schema: SchemaField[]; description: string }`. Task 10 (the REST endpoint) and Task 9 (the dispatcher) both read `getDefinedHooks()`.

Note: `SchemaField` isn't defined in `packages/plugin-sdk` today — it's `backend/services/ai-jobs/types.ts:61`. `packages/plugin-sdk` is a separate package backend code imports, not the other way around, so it can't import from `backend/`. Define the same shape locally in `hooks.ts` (not importable from ai-jobs) — it's a two-line, dependency-free structural type, not worth a shared-package indirection for.

- [ ] **Step 1: Write the failing test for the new `define`/`getDefinedHooks` behavior**

```ts
// packages/plugin-sdk/src/__tests__/hook-bus-impl.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HookBusImpl } from '../hook-bus-impl';

describe('HookBusImpl.define / getDefinedHooks', () => {
  it('records a hook definition with its schema and description', () => {
    const bus = new HookBusImpl();
    bus.define('apk:analyzed', [
      { field: 'apkVersionId', type: 'number', description: "The analyzed APK version's id" },
    ], 'Fires once an APK version finishes its full analysis pipeline.');

    expect(bus.getDefinedHooks()).toEqual([
      {
        name: 'apk:analyzed',
        schema: [{ field: 'apkVersionId', type: 'number', description: "The analyzed APK version's id" }],
        description: 'Fires once an APK version finishes its full analysis pipeline.',
      },
    ]);
  });

  it('returns every defined hook, in declaration order, across multiple define calls', () => {
    const bus = new HookBusImpl();
    bus.define('a', [], 'first');
    bus.define('b', [], 'second');
    expect(bus.getDefinedHooks().map(d => d.name)).toEqual(['a', 'b']);
  });

  it('getDefinedHooks returns a fresh array each call — a caller mutating the result cannot corrupt internal state', () => {
    const bus = new HookBusImpl();
    bus.define('a', [], 'x');
    const first = bus.getDefinedHooks();
    first.push({ name: 'fake', schema: [], description: 'injected' });
    expect(bus.getDefinedHooks()).toHaveLength(1);
  });

  it('define does not affect on/off/emit — a defined-but-unsubscribed hook firing calls no handlers and does not throw', () => {
    const bus = new HookBusImpl();
    bus.define('apk:analyzed', [], 'x');
    expect(() => bus.emit('apk:analyzed', { apkVersionId: 1 })).not.toThrow();
  });

  it('on/off/emit are unaffected by this change — a subscribed handler still receives emitted args', () => {
    const bus = new HookBusImpl();
    const handler = vi.fn();
    bus.on('apk:analyzed', handler);
    bus.emit('apk:analyzed', { apkVersionId: 42 });
    expect(handler).toHaveBeenCalledWith({ apkVersionId: 42 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails on the type error / missing behavior**

Run: `cd packages/plugin-sdk && npx vitest run src/__tests__/hook-bus-impl.test.ts`
Expected: FAIL — `bus.define('apk:analyzed', [...], '...')` doesn't typecheck against the current two-argument signature, and `getDefinedHooks()`'s current return shape (`{name, schema?: Record<string,string>}[]`, no `description`) doesn't match the assertions.

- [ ] **Step 3: Change the `HookBus` interface**

```ts
// packages/plugin-sdk/src/types/hooks.ts
export interface SchemaField { field: string; type: string; description: string }

export interface HookBus {
  define(name: string, schema: SchemaField[], description: string): void;
  on(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  off(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  emit(name: string, ...args: any[]): void;
}
```

- [ ] **Step 4: Update `HookBusImpl`**

```ts
// packages/plugin-sdk/src/hook-bus-impl.ts
import type { HookBus, SchemaField } from './types/hooks';

interface HookDefinition {
  name: string;
  schema: SchemaField[];
  description: string;
}

type HookHandler = (...args: any[]) => void | Promise<void>;

export class HookBusImpl implements HookBus {
  private handlers = new Map<string, Set<HookHandler>>();
  private definitions: HookDefinition[] = [];

  define(name: string, schema: SchemaField[], description: string): void {
    this.definitions.push({ name, schema, description });
  }

  on(name: string, handler: HookHandler): void {
    if (!this.handlers.has(name)) {
      this.handlers.set(name, new Set());
    }
    this.handlers.get(name)!.add(handler);
  }

  off(name: string, handler: HookHandler): void {
    this.handlers.get(name)?.delete(handler);
  }

  emit(name: string, ...args: any[]): void {
    const handlers = this.handlers.get(name);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        const result = handler(...args);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err) => {
            console.error(`[hook-bus] Hook handler error for "${name}" (async):`, err);
          });
        }
      } catch (err) {
        console.error(`[hook-bus] Hook handler error for "${name}":`, err);
      }
    }
  }

  getDefinedHooks(): HookDefinition[] {
    return [...this.definitions];
  }
}
```

(Only `define`'s body and the `HookDefinition` shape change; `on`/`off`/`emit`/`getDefinedHooks`'s own copy-on-read are unchanged from today.)

- [ ] **Step 5: Export `SchemaField` from the package root, build, run the new test**

```ts
// packages/plugin-sdk/src/index.ts — add alongside the existing HookBusImpl export
export type { HookBus, SchemaField } from './types/hooks';
```

Run: `cd packages/plugin-sdk && npm run build && npx vitest run src/__tests__/hook-bus-impl.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 6: Declare `apk:analyzed`'s real schema in `apk-analyzer.ts`'s `setHookBus`**

```ts
// backend/services/apk-analyzer.ts — replace the existing setHookBus method
setHookBus(bus: import('@darkrideapp/plugin-sdk').HookBus): void {
  this.hookBus = bus;
  this.hookBus.define('apk:analyzed', [
    { field: 'apkVersionId', type: 'number', description: "The analyzed APK version's id" },
    { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
    { field: 'apkPath', type: 'string', description: 'Local path to the analyzed APK file' },
    { field: 'dbPath', type: 'string', description: 'Path to the analysis SQLite database' },
    { field: 'outputDir', type: 'string', description: "Directory holding this analysis run's output" },
    { field: 'versionLabel', type: 'string', description: 'Human-readable "v<code> (<name>)" label' },
  ], 'Fires once an APK version finishes its full analysis pipeline.');
}
```

- [ ] **Step 7: Declare `apk:version-detected`'s real schema in `apk-tracker.ts`'s `setHookBus`**

```ts
// backend/services/apk-tracker.ts — replace the existing setHookBus method
setHookBus(bus: import('@darkrideapp/plugin-sdk').HookBus): void {
  this.hookBus = bus;
  this.hookBus.define('apk:version-detected', [
    { field: 'trackedAppId', type: 'number', description: 'The tracked app this version belongs to' },
    { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
    { field: 'appName', type: 'string', description: 'Display name, if known' },
    { field: 'source', type: 'string', description: 'Where this version was found' },
    { field: 'versionName', type: 'string', description: 'Human version string' },
    { field: 'previousVersion', type: 'string', description: 'The prior tracked version, if any' },
    { field: 'analysed', type: 'boolean', description: 'Whether this version has already been analysed' },
  ], 'Fires when a new or changed APK version is detected for a tracked app.');
}
```

- [ ] **Step 8: Add one assertion to each service's existing test file**

Find the existing test that constructs the service and calls `setHookBus` (both files already do this for their current `on`/`emit` tests — add alongside, don't duplicate setup). In `apk-analyzer.test.ts`:

```ts
it('declares apk:analyzed\'s real schema when a HookBus is wired', () => {
  const bus = { define: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn() };
  (service as any).setHookBus(bus);
  expect(bus.define).toHaveBeenCalledWith(
    'apk:analyzed',
    expect.arrayContaining([expect.objectContaining({ field: 'apkVersionId', type: 'number' })]),
    expect.any(String),
  );
});
```

In `apk-tracker.test.ts`, the same shape for `'apk:version-detected'`/`trackedAppId`.

- [ ] **Step 4 repeat: Run full affected suite**

Run: `cd /home/cube/projects/darkride && npx vitest run backend/services/apk-analyzer.test.ts backend/services/apk-tracker.test.ts && cd packages/plugin-sdk && npx vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/cube/projects/darkride
npm run build -w @darkrideapp/plugin-sdk
git add packages/plugin-sdk/src backend/services/apk-analyzer.ts backend/services/apk-tracker.ts backend/services/apk-analyzer.test.ts backend/services/apk-tracker.test.ts
git commit -m "feat(hooks): HookBus.define carries a real typed schema, declared at both real emit sites"
```

---

### Task 2: `createFunctionRegistry` factory + migrate Sink onto it

**Files:**
- Create: `backend/services/ai-jobs/nodes/function-registry.ts`
- Create: `backend/services/ai-jobs/nodes/function-registry.test.ts`
- Modify: `backend/services/ai-jobs/nodes/sink.ts`

**Interfaces:**
- Consumes: `SchemaField` from `backend/services/ai-jobs/types.ts` (already exists).
- Produces: `createFunctionRegistry<Fn>(): FunctionRegistry<Fn>` with `{ register(name, fn, description, schema?), get(name), list() }`, used by Task 2 (Sink), Task 3 (Trigger), Task 4 (Transform).

- [ ] **Step 1: Write the failing test for the generic factory**

```ts
// backend/services/ai-jobs/nodes/function-registry.test.ts
import { describe, it, expect } from 'vitest';
import { createFunctionRegistry } from './function-registry';

describe('createFunctionRegistry', () => {
  it('registers a function and returns it from get()', () => {
    const registry = createFunctionRegistry<() => number>();
    registry.register('answer', () => 42, 'Returns 42.');
    expect(registry.get('answer')?.()).toBe(42);
  });

  it('get() returns undefined for an unregistered name', () => {
    const registry = createFunctionRegistry<() => number>();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('list() returns name, description and schema, never the function itself', () => {
    const registry = createFunctionRegistry<() => number>();
    registry.register('answer', () => 42, 'Returns 42.', {
      outputSchema: [{ field: 'value', type: 'number', description: 'The answer' }],
    });
    const [entry] = registry.list();
    expect(entry).toEqual({
      name: 'answer', description: 'Returns 42.',
      inputSchema: undefined,
      outputSchema: [{ field: 'value', type: 'number', description: 'The answer' }],
    });
    expect('fn' in entry).toBe(false);
  });

  it('registering twice with the same name overwrites — last write wins, no throw (matches today\'s hand-rolled registries)', () => {
    const registry = createFunctionRegistry<() => string>();
    registry.register('x', () => 'first', 'first desc');
    registry.register('x', () => 'second', 'second desc');
    expect(registry.get('x')?.()).toBe('second');
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].description).toBe('second desc');
  });

  it('does not resolve an inherited Object.prototype key as a registered function', () => {
    const registry = createFunctionRegistry<() => number>();
    expect(registry.get('constructor')).toBeUndefined();
  });

  it('two independent registries never share state', () => {
    const a = createFunctionRegistry<() => number>();
    const b = createFunctionRegistry<() => number>();
    a.register('x', () => 1, 'a');
    expect(b.get('x')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/function-registry.test.ts`
Expected: FAIL — `./function-registry` doesn't exist yet.

- [ ] **Step 3: Implement the factory**

```ts
// backend/services/ai-jobs/nodes/function-registry.ts
import type { SchemaField } from '../types';

export interface RegisteredFunctionInfo {
  name: string;
  description: string;
  inputSchema?: SchemaField[];
  outputSchema?: SchemaField[];
}

export interface FunctionRegistry<Fn> {
  register(name: string, fn: Fn, description: string, schema?: { inputSchema?: SchemaField[]; outputSchema?: SchemaField[] }): void;
  get(name: string): Fn | undefined;
  list(): RegisteredFunctionInfo[];
}

/**
 * Shared implementation behind every node kind's "registered function" catalog (Sink's write
 * functions, Trigger's expand functions, Transform's reshape functions) — previously three
 * near-identical hand-rolled `Object.create(null)` maps, one per nodes/*.ts file. `Object.create
 * (null)` (not `{}` or `Map`, to match what every caller already relies on for the "no
 * Object.prototype key resolves" guarantee) keyed by name, in insertion order for `list()`.
 */
export function createFunctionRegistry<Fn>(): FunctionRegistry<Fn> {
  const fns: Record<string, Fn> = Object.create(null);
  const info: Record<string, RegisteredFunctionInfo> = Object.create(null);
  const order: string[] = [];

  return {
    register(name, fn, description, schema) {
      if (!(name in fns)) order.push(name);
      fns[name] = fn;
      info[name] = { name, description, inputSchema: schema?.inputSchema, outputSchema: schema?.outputSchema };
    },
    get(name) {
      return fns[name];
    },
    list() {
      return order.map(name => info[name]);
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/function-registry.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Migrate `nodes/sink.ts` onto it, keeping every existing export name stable**

```ts
// backend/services/ai-jobs/nodes/sink.ts
import type { SinkConfig } from '../types';
import type { AppDatabase } from '../../../db/index';
import { patchNoteSection } from '../../apk-notes';
import { createFunctionRegistry } from './function-registry';

export interface SinkCtx {
  db: AppDatabase;
  versionId: number;
}

export type SinkWriteFn = (config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx) => Promise<void>;

const registry = createFunctionRegistry<SinkWriteFn>();
/** Direct map access, same shape as before the merge — every existing import site reads this as a plain Record. */
export const SINK_REGISTRY: Record<string, SinkWriteFn> = new Proxy({} as Record<string, SinkWriteFn>, {
  get: (_t, name: string) => registry.get(name),
});
export const SINK_DESCRIPTIONS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_t, name: string) => registry.list().find(e => e.name === name)?.description,
});
/** Whether a write function reads `config.section` — governs whether the editor shows that field. Not a schema concept (it's a UI-only hint), kept as its own separate map, unrelated to the registry merge. */
export const SINK_USES_SECTION: Record<string, boolean> = Object.create(null);

export function registerSink(name: string, fn: SinkWriteFn, description: string, usesSection = false): void {
  registry.register(name, fn, description);
  SINK_USES_SECTION[name] = usesSection;
}

export async function runSink(config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx): Promise<void> {
  const fn = registry.get(config.writeFn);
  if (!fn) throw new Error(`Unknown sink "${config.writeFn}"`);
  await fn(config, input, ctx);
}

registerSink('apk-analysis/write-full-document', async (config, input, ctx) => {
  const source = config.from
    ? (input[config.from] as { markdown?: string; sections?: Array<{ title: string; body: string }> } | undefined)
    : undefined;
  if (!source?.sections) return;
  for (const section of source.sections) {
    patchNoteSection(ctx.db, ctx.versionId, section.title, section.body);
  }
}, "Writes every section from the connected Report into this APK version's analysis notes.");

registerSink('apk-analysis/write-section', async (config, input, ctx) => {
  const source = config.from ? (input[config.from] as { text?: string } | undefined) : undefined;
  patchNoteSection(ctx.db, ctx.versionId, config.section ?? 'Untitled', source?.text ?? '');
}, "Writes the connected step's output into one named section of this APK version's analysis notes.", true);
```

Note on the `Proxy`: `SINK_REGISTRY`/`SINK_DESCRIPTIONS` are read via bracket lookup (`SINK_REGISTRY[config.writeFn]`) at every existing call site (`runSink` above, and any test doing `SINK_REGISTRY['apk-analysis/write-full-document']`) — a `Proxy` with a `get` trap is the only way to keep that exact external shape (`Record<string, SinkWriteFn>`, plain bracket access, no method call) while the real storage lives inside `registry`'s closure. `Object.keys`/`for...in` on these proxies isn't used anywhere today (checked: no `Object.keys(SINK_REGISTRY)` or `for (const k in SINK_REGISTRY)` in the codebase) — the `get` trap alone covers every real usage.

- [ ] **Step 6: Run the full existing Sink + registry test files to confirm zero behavior change**

Run: `npx vitest run backend/services/ai-jobs/nodes/sink.test.ts backend/services/ai-jobs/nodes/function-registry.test.ts`
Expected: PASS, all tests unchanged in content, still green — this step is a refactor, no test file edits in this step.

- [ ] **Step 7: Commit**

```bash
git add backend/services/ai-jobs/nodes/function-registry.ts backend/services/ai-jobs/nodes/function-registry.test.ts backend/services/ai-jobs/nodes/sink.ts
git commit -m "refactor(ai-jobs): shared createFunctionRegistry factory, Sink migrated onto it"
```

---

### Task 3: Migrate Trigger's function-mode onto `createFunctionRegistry`

**Files:**
- Modify: `backend/services/ai-jobs/nodes/trigger.ts`

**Interfaces:**
- Consumes: `createFunctionRegistry` (Task 2).
- Produces: `TRIGGER_REGISTRY`, `TRIGGER_DESCRIPTIONS`, `TRIGGER_SCHEMAS` — same names, same external shape as today.

- [ ] **Step 1: Confirm the existing test file already covers everything this touches (no new test needed for this step — it's a pure internal refactor of already-tested exports)**

Run: `npx vitest run backend/services/ai-jobs/nodes/trigger.test.ts`
Expected: PASS (baseline, before the refactor) — 6/6, confirming current coverage of `TRIGGER_REGISTRY`, `TRIGGER_DESCRIPTIONS`, `TRIGGER_SCHEMAS` before touching their implementation.

- [ ] **Step 2: Migrate `nodes/trigger.ts`'s registry internals**

```ts
// backend/services/ai-jobs/nodes/trigger.ts — registry section only, the registerTrigger call for
// 'apk-analysis/apk-context' below this is UNCHANGED, not reproduced here
import { eq } from 'drizzle-orm';
import { apkVersions, trackedApps } from '../../../db/schema';
import type { AppDatabase } from '../../../db/index';
import type { SchemaField } from '../types';
import { createFunctionRegistry } from './function-registry';

export interface TriggerCtx {
  db: AppDatabase;
}

export type TriggerExpander = (rawInput: Record<string, unknown>, ctx: TriggerCtx) => Promise<Record<string, unknown>>;

const registry = createFunctionRegistry<TriggerExpander>();
export const TRIGGER_REGISTRY: Record<string, TriggerExpander> = new Proxy({} as Record<string, TriggerExpander>, {
  get: (_t, name: string) => registry.get(name),
});
export const TRIGGER_DESCRIPTIONS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_t, name: string) => registry.list().find(e => e.name === name)?.description,
});
export const TRIGGER_SCHEMAS: Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }> =
  new Proxy({} as Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }>, {
    get: (_t, name: string) => {
      const entry = registry.list().find(e => e.name === name);
      return entry && { inputSchema: entry.inputSchema ?? [], outputSchema: entry.outputSchema ?? [] };
    },
  });

export function registerTrigger(
  name: string, fn: TriggerExpander, description: string,
  schema: { inputSchema: SchemaField[]; outputSchema: SchemaField[] },
): void {
  registry.register(name, fn, description, schema);
}
```

(The `registerTrigger('apk-analysis/apk-context', ...)` call below this block, and everything inside it, is untouched — same function body, same description string, same schema object literal as today.)

- [ ] **Step 3: Run the existing test file — zero changes expected**

Run: `npx vitest run backend/services/ai-jobs/nodes/trigger.test.ts`
Expected: PASS, 6/6, unchanged.

- [ ] **Step 4: Commit**

```bash
git add backend/services/ai-jobs/nodes/trigger.ts
git commit -m "refactor(ai-jobs): Trigger's function-mode registry migrated onto createFunctionRegistry"
```

---

### Task 4: Migrate Transform onto `createFunctionRegistry` — gains description + schema for the first time

**Files:**
- Modify: `backend/services/ai-jobs/nodes/transform.ts`
- Modify: `backend/services/ai-jobs/nodes/transform.test.ts`

**Interfaces:**
- Consumes: `createFunctionRegistry` (Task 2).
- Produces: `TRANSFORM_REGISTRY` (unchanged name/shape), new `TRANSFORM_DESCRIPTIONS`, `TRANSFORM_SCHEMAS` (Task 11's frontend picker reads these the same way it reads Sink/Trigger's).

- [ ] **Step 1: Read the current test file to see what's covered today**

Run: `npx vitest run backend/services/ai-jobs/nodes/transform.test.ts`
Expected: PASS (baseline) — confirms today's `registerTransform(name, fn)` two-argument tests pass before changing the signature.

- [ ] **Step 2: Write the new failing tests for description/schema**

Add to `backend/services/ai-jobs/nodes/transform.test.ts` (alongside the existing tests, which will need their `registerTransform` calls updated in Step 4 once the signature requires a description):

```ts
it('describes every registered transform function', () => {
  expect(TRANSFORM_DESCRIPTIONS['test/double']).toBe('Doubles every numeric field.');
});

it('declares a schema for a registered transform function', () => {
  expect(TRANSFORM_SCHEMAS['test/double']).toEqual({
    inputSchema: [{ field: 'value', type: 'number', description: 'Input number' }],
    outputSchema: [{ field: 'value', type: 'number', description: 'Doubled result' }],
  });
});
```

(Add `import { TRANSFORM_DESCRIPTIONS, TRANSFORM_SCHEMAS } from './transform';` to the test file's existing import line.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/transform.test.ts`
Expected: FAIL — `TRANSFORM_DESCRIPTIONS`/`TRANSFORM_SCHEMAS` don't exist yet.

- [ ] **Step 4: Implement**

```ts
// backend/services/ai-jobs/nodes/transform.ts
import type { TransformConfig } from '../types';
import type { SchemaField } from '../types';
import { createFunctionRegistry } from './function-registry';

export type TransformFn = (input: Record<string, unknown>) => Record<string, unknown>;

const registry = createFunctionRegistry<TransformFn>();
export const TRANSFORM_REGISTRY: Record<string, TransformFn> = new Proxy({} as Record<string, TransformFn>, {
  get: (_t, name: string) => registry.get(name),
});
export const TRANSFORM_DESCRIPTIONS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_t, name: string) => registry.list().find(e => e.name === name)?.description,
});
export const TRANSFORM_SCHEMAS: Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }> =
  new Proxy({} as Record<string, { inputSchema: SchemaField[]; outputSchema: SchemaField[] }>, {
    get: (_t, name: string) => {
      const entry = registry.list().find(e => e.name === name);
      return entry && { inputSchema: entry.inputSchema ?? [], outputSchema: entry.outputSchema ?? [] };
    },
  });

export function registerTransform(
  name: string, fn: TransformFn, description: string,
  schema: { inputSchema: SchemaField[]; outputSchema: SchemaField[] },
): void {
  registry.register(name, fn, description, schema);
}

export function runTransform(config: TransformConfig, input: Record<string, unknown>): Record<string, unknown> {
  const fn = registry.get(config.fn);
  if (!fn) throw new Error(`Unknown transform "${config.fn}"`);
  return fn(input);
}
```

- [ ] **Step 5: Update the test file's existing `registerTransform` calls to the new 4-argument signature**

The existing tests in `transform.test.ts` call `registerTransform('test/double', fn)` with two arguments to set up fixtures — update every such call site in that file to the new signature, e.g.:

```ts
registerTransform('test/double', (input) => ({ value: (input.value as number) * 2 }),
  'Doubles every numeric field.',
  { inputSchema: [{ field: 'value', type: 'number', description: 'Input number' }],
    outputSchema: [{ field: 'value', type: 'number', description: 'Doubled result' }] });
```

(Match whatever the existing fixture's actual transform logic does — do not change its behavior, only add the two new required arguments.)

- [ ] **Step 6: Run full file**

Run: `npx vitest run backend/services/ai-jobs/nodes/transform.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 7: Commit**

```bash
git add backend/services/ai-jobs/nodes/transform.ts backend/services/ai-jobs/nodes/transform.test.ts
git commit -m "feat(ai-jobs): Transform functions gain a real description + schema, via createFunctionRegistry"
```

---

### Task 5: `TriggerConfig` gains `source`/`eventName`; graph-validator enforces exactly one

**Files:**
- Modify: `backend/services/ai-jobs/types.ts`
- Modify: `backend/services/ai-jobs/graph-validator.ts`
- Modify: `backend/services/ai-jobs/graph-validator.test.ts`
- Modify: `backend/services/ai-jobs/apk-analysis-pipeline.ts` (add `source: 'function'` to the two seeded Trigger nodes)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TriggerConfig.source`/`eventName`, consumed by Task 6 (`runTrigger`), Task 12 (frontend `TriggerBody`).

- [ ] **Step 1: Write the failing validator test**

Add to `backend/services/ai-jobs/graph-validator.test.ts`:

```ts
it('rejects a Trigger that declares neither expandFn nor eventName', () => {
  const graph: PipelineGraph = {
    nodes: [{ id: 't', config: { kind: 'Trigger', source: 'function', outputSchema: [] } }],
    edges: [],
  };
  const errors = validateGraph(graph);
  expect(errors).toContainEqual(expect.objectContaining({ nodeId: 't', message: expect.stringContaining('exactly one of') }));
});

it('rejects a Trigger that declares both expandFn and eventName', () => {
  const graph: PipelineGraph = {
    nodes: [{ id: 't', config: { kind: 'Trigger', source: 'function', expandFn: 'x', eventName: 'y', outputSchema: [] } }],
    edges: [],
  };
  const errors = validateGraph(graph);
  expect(errors).toContainEqual(expect.objectContaining({ nodeId: 't', message: expect.stringContaining('exactly one of') }));
});

it('accepts a function-sourced Trigger with only expandFn', () => {
  const graph: PipelineGraph = {
    nodes: [{ id: 't', config: { kind: 'Trigger', source: 'function', expandFn: 'x', outputSchema: [] } }],
    edges: [],
  };
  expect(validateGraph(graph)).toEqual([]);
});

it('accepts an event-sourced Trigger with only eventName', () => {
  const graph: PipelineGraph = {
    nodes: [{ id: 't', config: { kind: 'Trigger', source: 'event', eventName: 'apk:analyzed', outputSchema: [] } }],
    edges: [],
  };
  expect(validateGraph(graph)).toEqual([]);
});

it('treats a Trigger with no declared source as function-sourced, for graphs saved before this field existed', () => {
  const graph: PipelineGraph = {
    nodes: [{ id: 't', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } as any }],
    edges: [],
  };
  expect(validateGraph(graph)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/graph-validator.test.ts`
Expected: FAIL — `source`/`eventName` don't exist on `TriggerConfig` yet (TS error) and the new rule isn't implemented.

- [ ] **Step 3: Update `TriggerConfig`**

```ts
// backend/services/ai-jobs/types.ts
export interface TriggerConfig {
  source: 'function' | 'event';
  /** Required when source === 'function'. Name of a pre-registered expand function. */
  expandFn?: string;
  /** Required when source === 'event'. Name of a hook declared via HookBus.define. */
  eventName?: string;
  /** What the run caller must supply to start this Trigger — only meaningful when
   *  source === 'function'. An event-sourced Trigger has nothing to ask; the event's payload
   *  supplies everything. Drives the generic run form; a type the UI doesn't recognize falls
   *  back to a plain text field. */
  inputSchema?: SchemaField[];
  /** Declared output schema, shared across every Trigger in one pipeline (validator-enforced). */
  outputSchema: SchemaField[];
}
```

- [ ] **Step 4: Add the validation rule to `graph-validator.ts`**

Insert right after the existing output-schema-match loop (after the `for (let i = 1; i < triggers.length; i++) { ... }` block, before the "Trigger must be an independent root" edge check):

```ts
for (const t of triggers) {
  const config = t.config as { source?: 'function' | 'event'; expandFn?: string; eventName?: string };
  const source = config.source ?? 'function';
  const hasFn = !!config.expandFn;
  const hasEvent = !!config.eventName;
  if (source === 'function' ? hasEvent : hasFn) {
    errors.push({ nodeId: t.id, message: `Trigger "${t.id}" must declare exactly one of expandFn or eventName, matching its source.` });
  } else if (source === 'function' ? !hasFn : !hasEvent) {
    errors.push({ nodeId: t.id, message: `Trigger "${t.id}" must declare exactly one of expandFn or eventName, matching its source.` });
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/graph-validator.test.ts`
Expected: PASS, including all pre-existing tests in the file (unchanged) plus the 5 new ones.

- [ ] **Step 6: Add `source: 'function'` to the two real seeded Trigger nodes**

```ts
// backend/services/ai-jobs/apk-analysis-pipeline.ts — ASTERIX_PATTERN_GRAPH, Trigger nodes only
{ id: 'trigger-full', label: 'Full Analysis', config: { kind: 'Trigger', source: 'function', expandFn: 'apk-analysis/apk-context', inputSchema: APK_TRIGGER_INPUT_SCHEMA, outputSchema: APK_CONTEXT_SCHEMA } },
{ id: 'trigger-rescan', label: 'Quick Rescan', config: { kind: 'Trigger', source: 'function', expandFn: 'apk-analysis/apk-context', inputSchema: APK_TRIGGER_INPUT_SCHEMA, outputSchema: APK_CONTEXT_SCHEMA } },
```

- [ ] **Step 7: Run the full apk-analysis-pipeline test file**

Run: `npx vitest run backend/services/ai-jobs/apk-analysis-pipeline.test.ts`
Expected: PASS — `validateGraph(ASTERIX_PATTERN_GRAPH)` still returns `[]` (both Triggers now explicitly declare `source: 'function'` with `expandFn` set, satisfying the new rule).

- [ ] **Step 8: Commit**

```bash
git add backend/services/ai-jobs/types.ts backend/services/ai-jobs/graph-validator.ts backend/services/ai-jobs/graph-validator.test.ts backend/services/ai-jobs/apk-analysis-pipeline.ts
git commit -m "feat(ai-jobs): TriggerConfig gains source/eventName; graph-validator enforces exactly one"
```

---

### Task 6: `runTrigger` — one generic executor for both sources, shared by every job kind

**Files:**
- Modify: `backend/services/ai-jobs/nodes/trigger.ts` (add `runTrigger`)
- Modify: `backend/services/ai-jobs/nodes/trigger.test.ts`
- Modify: `backend/services/ai-jobs/apk-analysis-pipeline.ts` (drop its inline `Trigger:` executor, use the shared one)
- Modify: `backend/services/ai-jobs/apk-analysis-pipeline.test.ts` (if it asserts on the executors bag's shape — verify, update if needed)

**Interfaces:**
- Consumes: `TriggerConfig.source` (Task 5), `TRIGGER_REGISTRY` (Task 3).
- Produces: `runTrigger(config, rawInput, ctx): Promise<Record<string, unknown>>`, the value every job kind's `executors.Trigger` is built from — `buildApkAnalysisExecutors()` (Task 6) and `HookTriggerDispatcher` (Task 9) both use it indirectly via the shared `executors` bag.

- [ ] **Step 1: Write the failing test**

Add to `backend/services/ai-jobs/nodes/trigger.test.ts`:

```ts
import { runTrigger } from './trigger';

describe('runTrigger', () => {
  it('function-sourced: looks up TRIGGER_REGISTRY by expandFn and calls it', async () => {
    const db = makeDb();
    db.insert(schema.trackedApps).values({ id: 1, packageName: 'x', appName: 'X', createdAt: new Date() }).run();
    db.insert(schema.apkVersions).values({
      id: 1, trackedAppId: 1, versionCode: 1, versionName: '1', filename: 'x.apk', fileSize: 1,
      source: 'device', downloadedAt: new Date(),
    }).run();
    const result = await runTrigger(
      { kind: 'Trigger', source: 'function', expandFn: 'apk-analysis/apk-context', outputSchema: [] } as any,
      { versionId: 1 }, { db },
    );
    expect(result.appName).toBe('X');
  });

  it('function-sourced with an unregistered expandFn throws "Unknown trigger expander"', async () => {
    const db = makeDb();
    await expect(runTrigger(
      { kind: 'Trigger', source: 'function', expandFn: 'nope', outputSchema: [] } as any, {}, { db },
    )).rejects.toThrow(/Unknown trigger expander/);
  });

  it('event-sourced: returns the raw input unchanged, with no registry lookup', async () => {
    const db = makeDb();
    const payload = { apkVersionId: 42, packageName: 'x' };
    const result = await runTrigger(
      { kind: 'Trigger', source: 'event', eventName: 'apk:analyzed', outputSchema: [] } as any, payload, { db },
    );
    expect(result).toBe(payload); // returns the same reference — no copy, no transform, nothing to call
  });

  it('a missing source defaults to function-mode, for graphs saved before this field existed', async () => {
    const db = makeDb();
    db.insert(schema.trackedApps).values({ id: 1, packageName: 'x', appName: 'X', createdAt: new Date() }).run();
    db.insert(schema.apkVersions).values({
      id: 1, trackedAppId: 1, versionCode: 1, versionName: '1', filename: 'x.apk', fileSize: 1,
      source: 'device', downloadedAt: new Date(),
    }).run();
    const result = await runTrigger(
      { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: [] } as any, { versionId: 1 }, { db },
    );
    expect(result.appName).toBe('X');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/trigger.test.ts`
Expected: FAIL — `runTrigger` doesn't exist yet.

- [ ] **Step 3: Implement `runTrigger` in `nodes/trigger.ts`**

Add at the end of the file (after the existing `registerTrigger('apk-analysis/apk-context', ...)` call):

```ts
export async function runTrigger(
  config: { source?: 'function' | 'event'; expandFn?: string; eventName?: string },
  rawInput: Record<string, unknown>,
  ctx: TriggerCtx,
): Promise<Record<string, unknown>> {
  const source = config.source ?? 'function';
  if (source === 'event') {
    // The event payload already IS the expanded output — nothing to call.
    return rawInput;
  }
  const expand = registry.get(config.expandFn!);
  if (!expand) throw new Error(`Unknown trigger expander "${config.expandFn}"`);
  return expand(rawInput, ctx);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/trigger.test.ts`
Expected: PASS, 10/10 (6 pre-existing + 4 new).

- [ ] **Step 5: Replace `apk-analysis-pipeline.ts`'s inline `Trigger:` executor**

```ts
// backend/services/ai-jobs/apk-analysis-pipeline.ts
import { runTrigger } from './nodes/trigger';
// (TRIGGER_REGISTRY import can be dropped from this file if nothing else here uses it — check
// before removing; it's still used if anything else in the file references TRIGGER_REGISTRY
// directly, otherwise remove the now-unused import.)

export function buildApkAnalysisExecutors(): NodeExecutors {
  return {
    Trigger: (config, rawInput, ctx) => runTrigger(config, rawInput, { db: (ctx as { db: AppDatabase }).db }),
    // ...AgentCall, Transform, Branch, Report, ForEach, Sink entries below are UNCHANGED
  };
}
```

- [ ] **Step 6: Run the full ai-jobs backend suite**

Run: `npx vitest run backend/services/ai-jobs`
Expected: PASS — in particular `apk-analysis-pipeline.test.ts`'s existing run-through test (the one that calls `runPipeline(ASTERIX_PATTERN_GRAPH, 'trigger-full', { versionId: 431 }, executors, ctx)`) still passes unchanged, proving the swap is behaviorally identical for the real production pipeline.

- [ ] **Step 7: Commit**

```bash
git add backend/services/ai-jobs/nodes/trigger.ts backend/services/ai-jobs/nodes/trigger.test.ts backend/services/ai-jobs/apk-analysis-pipeline.ts
git commit -m "refactor(ai-jobs): runTrigger is one generic function+event executor, shared by every job kind"
```

---

### Task 7: Widen `triggeredBy` from the apk-analysis-specific literal to a general 'event'

**Files:**
- Modify: `backend/services/ai-jobs/run-executor.ts`
- Modify: `backend/services/ai-jobs/run-executor.test.ts`
- Modify: `backend/db/schema.ts` (comment only)
- Modify: `backend/services/apk-analyzer.ts` (the one real call site, `runAiPipeline`)
- Modify: `backend/services/apk-analyzer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `StartPipelineRunOptions.triggeredBy: 'manual' | 'event'`, consumed by Task 9's `HookTriggerDispatcher`.

- [ ] **Step 1: Update the 3 literal occurrences in `run-executor.test.ts`**

In `backend/services/ai-jobs/run-executor.test.ts`, change `triggeredBy: 'apk-analysis-complete'` to `triggeredBy: 'event'` at all 3 occurrences (lines ~119, ~133, ~141 as of this plan's writing — grep to confirm exact current lines before editing: `grep -n "apk-analysis-complete" backend/services/ai-jobs/run-executor.test.ts`).

- [ ] **Step 2: Run to verify it fails (type error)**

Run: `npx vitest run backend/services/ai-jobs/run-executor.test.ts`
Expected: FAIL — `'event'` isn't assignable to the current `'manual' | 'apk-analysis-complete'` type.

- [ ] **Step 3: Widen the type**

```ts
// backend/services/ai-jobs/run-executor.ts
export interface StartPipelineRunOptions {
  // ...unchanged fields above...
  triggeredBy: 'manual' | 'event';
  // ...unchanged fields below...
}
```

- [ ] **Step 4: Update the schema comment**

```ts
// backend/db/schema.ts — aiPipelineRuns table, triggeredBy column
triggeredBy: text('triggered_by').notNull(), // 'manual' | 'event'
```

- [ ] **Step 5: Run to verify `run-executor.test.ts` passes**

Run: `npx vitest run backend/services/ai-jobs/run-executor.test.ts`
Expected: PASS, unchanged test count, all green.

- [ ] **Step 6: Update `apk-analyzer.ts`'s real call site**

```ts
// backend/services/apk-analyzer.ts, inside runAiPipeline
const started = startPipelineRun({
  // ...unchanged fields...
  triggeredBy: 'event',
  // ...unchanged fields...
});
```

- [ ] **Step 7: Update `apk-analyzer.test.ts`'s one assertion**

Change `triggeredBy: 'apk-analysis-complete'` to `triggeredBy: 'event'` in the `toMatchObject` assertion around line 1403 (grep to confirm current line before editing).

- [ ] **Step 8: Run the full affected suite**

Run: `npx vitest run backend/services/ai-jobs/run-executor.test.ts backend/services/apk-analyzer.test.ts`
Expected: PASS, all green, zero remaining references to `'apk-analysis-complete'` anywhere (verify: `grep -rn "apk-analysis-complete" backend/` returns nothing).

- [ ] **Step 9: Commit**

```bash
git add backend/services/ai-jobs/run-executor.ts backend/services/ai-jobs/run-executor.test.ts backend/db/schema.ts backend/services/apk-analyzer.ts backend/services/apk-analyzer.test.ts
git commit -m "refactor(ai-jobs): triggeredBy widens from the one hardcoded apk-analysis literal to general 'event'"
```

---

### Task 8: `HookTriggerDispatcher` — subscribes published event-sourced Triggers to HookBus

**Files:**
- Create: `backend/services/ai-jobs/hook-trigger-dispatcher.ts`
- Create: `backend/services/ai-jobs/hook-trigger-dispatcher.test.ts`

**Interfaces:**
- Consumes: `HookBus` (Task 1), `TriggerConfig.source`/`eventName` (Task 5), `startPipelineRun` (existing, `triggeredBy: 'event'` from Task 7), `NodeExecutors`/`ExecutionCtx` (existing).
- Produces: `HookTriggerDispatcher` class with `attach(hookBus)`/`refresh()`, wired into `backend/index.ts` in Task 10.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/services/ai-jobs/hook-trigger-dispatcher.test.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { HookTriggerDispatcher } from './hook-trigger-dispatcher';
import type { NodeExecutors } from './pipeline-runner';
import * as runExecutorModule from './run-executor';

function makeDb(): AppDatabase {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE ai_pipelines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, job_kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ai_pipeline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pipeline_id INTEGER NOT NULL, version INTEGER NOT NULL,
      graph TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as AppDatabase;
}

function seedPublished(db: AppDatabase, pipelineId: number, versionId: number, graph: unknown) {
  db.insert(schema.aiPipelines).values({ id: pipelineId, name: 'p', jobKind: 'k', createdAt: new Date() }).run();
  db.insert(schema.aiPipelineVersions).values({
    id: versionId, pipelineId, version: 1, graph: graph as any, status: 'published', createdAt: new Date(),
  }).run();
}

function fakeHookBus() {
  const handlers = new Map<string, Set<(...a: any[]) => void>>();
  return {
    define: vi.fn(), off: vi.fn((name: string, h: any) => handlers.get(name)?.delete(h)),
    on: vi.fn((name: string, h: any) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(h);
    }),
    emit: vi.fn((name: string, payload: any) => {
      for (const h of handlers.get(name) ?? []) h(payload);
    }),
    _handlerCount: (name: string) => handlers.get(name)?.size ?? 0,
  };
}

const eventTriggerGraph = (eventName: string) => ({
  nodes: [{ id: 't', config: { kind: 'Trigger', source: 'event', eventName, outputSchema: [] } }],
  edges: [],
});

describe('HookTriggerDispatcher', () => {
  let startSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    startSpy = vi.spyOn(runExecutorModule, 'startPipelineRun').mockReturnValue({ ok: true, runId: 1 });
  });

  it('subscribes to an event name used by a published event-sourced Trigger', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    expect(bus.on).toHaveBeenCalledWith('apk:analyzed', expect.any(Function));
  });

  it('firing the subscribed event starts a run with the payload as input', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: (p) => ({ payload: p }) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();

    bus.emit('apk:analyzed', { apkVersionId: 42 });

    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
      pipelineVersionId: 1, triggerNodeId: 't', input: { apkVersionId: 42 }, triggeredBy: 'event',
    }));
  });

  it('does not double-subscribe when refresh() is called twice with no graph changes', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    dispatcher.refresh();
    expect(bus._handlerCount('apk:analyzed')).toBe(1);
  });

  it('drops a subscription once no published version uses that event name anymore', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    expect(bus._handlerCount('apk:analyzed')).toBe(1);

    // Demote the published version back to draft — simulates a re-publish that no longer binds this event.
    db.update(schema.aiPipelineVersions).set({ status: 'draft' }).run();
    dispatcher.refresh();

    expect(bus.off).toHaveBeenCalledWith('apk:analyzed', expect.any(Function));
    expect(bus._handlerCount('apk:analyzed')).toBe(0);
  });

  it('ignores function-sourced Triggers entirely — never subscribes to anything for them', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, {
      nodes: [{ id: 't', config: { kind: 'Trigger', source: 'function', expandFn: 'x', outputSchema: [] } }],
      edges: [],
    });
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    expect(bus.on).not.toHaveBeenCalled();
  });

  it('fires every published Trigger bound to the same event name, across different pipelines', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    seedPublished(db, 2, 2, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();

    bus.emit('apk:analyzed', { apkVersionId: 1 });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ pipelineVersionId: 1 }));
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ pipelineVersionId: 2 }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/hook-trigger-dispatcher.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

```ts
// backend/services/ai-jobs/hook-trigger-dispatcher.ts
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index';
import { aiPipelineVersions } from '../../db/schema';
import type { NodeExecutors, ExecutionCtx } from './pipeline-runner';
import type { PipelineGraph } from './types';
import { startPipelineRun } from './run-executor';
import { createLoggers } from '../../logs';

const { log, error } = createLoggers('ai-jobs-hook-dispatch');

interface Binding {
  pipelineVersionId: number;
  graph: PipelineGraph;
  triggerNodeId: string;
}

type HookBusLike = {
  on(name: string, handler: (...args: any[]) => void): void;
  off(name: string, handler: (...args: any[]) => void): void;
};

/**
 * Subscribes every published pipeline version's event-sourced Trigger nodes to HookBus, and
 * starts a run (via the same `startPipelineRun` the REST /run endpoint and apk-analyzer.ts's own
 * auto-trigger path both use) whenever its bound event fires. See
 * docs/specs/2026-10-11-ai-pipelines-typed-triggers-design.md.
 */
export class HookTriggerDispatcher {
  private hookBus: HookBusLike | null = null;
  /** One handler per event name, reused across refresh() calls — HookBusImpl.on dedupes by
   *  handler reference via a Set, so refresh() must never create a fresh closure for an event
   *  name it's already subscribed to, or two refreshes would double-fire every bound run. */
  private handlersByEvent = new Map<string, (payload: Record<string, unknown>) => void>();

  constructor(private deps: {
    db: AppDatabase;
    executors: NodeExecutors;
    buildCtx: (eventPayload: Record<string, unknown>) => ExecutionCtx;
  }) {}

  attach(hookBus: HookBusLike): void {
    this.hookBus = hookBus;
  }

  /** Re-scans every published version's graph; subscribes newly-bound event names, unsubscribes ones no longer bound by anything published. */
  refresh(): void {
    if (!this.hookBus) return;
    const bindingsByEvent = this.collectBindings();

    for (const eventName of bindingsByEvent.keys()) {
      if (this.handlersByEvent.has(eventName)) continue;
      const handler = (payload: Record<string, unknown>) => this.handleFire(eventName, payload);
      this.handlersByEvent.set(eventName, handler);
      this.hookBus.on(eventName, handler);
    }

    for (const [eventName, handler] of [...this.handlersByEvent.entries()]) {
      if (bindingsByEvent.has(eventName)) continue;
      this.hookBus.off(eventName, handler);
      this.handlersByEvent.delete(eventName);
    }
  }

  private collectBindings(): Map<string, Binding[]> {
    const result = new Map<string, Binding[]>();
    const published = this.deps.db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.status, 'published')).all();
    for (const version of published) {
      const graph = version.graph as unknown as PipelineGraph;
      for (const node of graph.nodes) {
        const config = node.config as { kind: string; source?: string; eventName?: string };
        if (config.kind !== 'Trigger' || config.source !== 'event' || !config.eventName) continue;
        const list = result.get(config.eventName) ?? [];
        list.push({ pipelineVersionId: version.id, graph, triggerNodeId: node.id });
        result.set(config.eventName, list);
      }
    }
    return result;
  }

  private handleFire(eventName: string, payload: Record<string, unknown>): void {
    // Re-collect at fire time, not from a closure captured at subscribe time — always reflects
    // whatever was most recently published.
    const bindings = this.collectBindings().get(eventName) ?? [];
    for (const binding of bindings) {
      const started = startPipelineRun({
        db: this.deps.db,
        pipelineVersionId: binding.pipelineVersionId,
        graph: binding.graph,
        triggerNodeId: binding.triggerNodeId,
        input: payload,
        triggeredBy: 'event',
        executors: this.deps.executors,
        buildCtx: () => this.deps.buildCtx(payload),
        onSettled: (result, crashError) => {
          if (result.status === 'failed') {
            error(`Event-fired run for pipeline version ${binding.pipelineVersionId} ("${eventName}") failed: ${crashError ?? result.nodes.filter(n => n.status === 'failed').map(n => `${n.nodeId}: ${n.error}`).join('; ')}`);
          } else {
            log(`Event-fired run for pipeline version ${binding.pipelineVersionId} ("${eventName}") finished: ${result.status}`);
          }
        },
      });
      if (!started.ok) {
        error(`Could not start event-fired run for pipeline version ${binding.pipelineVersionId} ("${eventName}"): ${started.error}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/hook-trigger-dispatcher.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/hook-trigger-dispatcher.ts backend/services/ai-jobs/hook-trigger-dispatcher.test.ts
git commit -m "feat(ai-jobs): HookTriggerDispatcher subscribes published event Triggers to HookBus and starts their runs"
```

---

### Task 9: `GET /v1/ai-pipelines/hook-catalog` + `onPublish` callback

**Files:**
- Modify: `backend/api/ai-pipelines.ts`
- Modify: `backend/api/ai-pipelines.test.ts`

**Interfaces:**
- Consumes: `HookBusImpl.getDefinedHooks()` (Task 1).
- Produces: `GET /v1/ai-pipelines/hook-catalog` → `{ success: true, data: HookDefinition[] }`; `AiPipelineDeps.onPublish?: () => void` and `getHookCatalog?: () => HookDefinition[]`, wired in Task 10.

**`createApp`'s current signature** (`backend/api/ai-pipelines.test.ts:107-111`) is
`createApp(db, executors, scopes: string[] = [...], buildCtx: AiPipelineDeps['buildCtx'] = ...)` —
positional, no slot for the new optional deps. Rather than overload a 5-positional-argument
helper further, this task adds one more optional positional parameter, `extraDeps:
Partial<AiPipelineDeps> = {}`, merged last so it can override anything — every existing call site
(none of which pass a 5th argument) is unaffected.

- [ ] **Step 1: Write the failing tests**

Add to `backend/api/ai-pipelines.test.ts`:

```ts
describe('GET /v1/ai-pipelines/hook-catalog', () => {
  it('returns whatever the injected getHookCatalog provides', async () => {
    const db = makeDb();
    const catalog = [{ name: 'apk:analyzed', schema: [], description: 'x' }];
    const app = createApp(db, fakeExecutors(), undefined, undefined, { getHookCatalog: () => catalog });
    const res = await request(app).get('/v1/ai-pipelines/hook-catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(catalog);
  });

  it('returns an empty array when no getHookCatalog was injected', async () => {
    const db = makeDb();
    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines/hook-catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // Regression guard: GET /v1/ai-pipelines/:id is also registered and would greedily match
  // "hook-catalog" as :id if this route were registered after it — must hit the literal route,
  // never fall through to a 404 "No pipeline with id hook-catalog." from the :id handler.
  it('is reachable even though GET /v1/ai-pipelines/:id is also registered and could shadow it', async () => {
    const db = makeDb();
    const app = createApp(db, fakeExecutors(), undefined, undefined, { getHookCatalog: () => [] });
    const res = await request(app).get('/v1/ai-pipelines/hook-catalog');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });
});

describe('POST /v1/ai-pipelines/:id/publish — onPublish callback', () => {
  it('calls onPublish after a successful publish', async () => {
    const db = makeDb();
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'draft');
    const onPublish = vi.fn();
    const app = createApp(db, fakeExecutors(), undefined, undefined, { onPublish });
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/publish`);
    expect(res.status).toBe(200);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('does not call onPublish when publish fails validation', async () => {
    const db = makeDb();
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, { nodes: [], edges: [] }, 'draft'); // no Trigger — invalid
    const onPublish = vi.fn();
    const app = createApp(db, fakeExecutors(), undefined, undefined, { onPublish });
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/publish`);
    expect(res.status).toBe(400);
    expect(onPublish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/api/ai-pipelines.test.ts`
Expected: FAIL — `createApp` doesn't accept a 5th argument yet (TS error), the new endpoint 404s, `onPublish` is never called.

- [ ] **Step 3: Give `createApp` the new optional 5th parameter**

```ts
// backend/api/ai-pipelines.test.ts
function createApp(
  db: Db,
  executors: NodeExecutors,
  scopes: string[] = ['core.apk:read', 'core.apk:manage'],
  buildCtx: AiPipelineDeps['buildCtx'] = (_identity, _input): ExecutionCtx => ({}),
  extraDeps: Partial<AiPipelineDeps> = {},
) {
  clearEndpoints();
  const deps: AiPipelineDeps = { db, executors, buildCtx, ...extraDeps };
  registerAiPipelineEndpoints(deps);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).authUser = { userId: 1, effectiveScopes: new Set(scopes) };
    next();
  });
  app.use(getApiRouter());
  return app;
}
```

- [ ] **Step 4: Implement the endpoint in `backend/api/ai-pipelines.ts`**

```ts
// backend/api/ai-pipelines.ts
export interface AiPipelineDeps {
  db: AppDatabase;
  executors: NodeExecutors;
  buildCtx: (identity: { type: 'core-service' } | { type: 'user'; userId: number }, input: Record<string, unknown>) => ExecutionCtx;
  /** Returns the current typed-event catalog (HookBusImpl.getDefinedHooks()) — optional so tests
   *  that don't care about event triggers don't need to inject one. */
  getHookCatalog?: () => Array<{ name: string; schema: unknown[]; description: string }>;
  /** Called once, after a publish actually succeeds — wired to HookTriggerDispatcher.refresh in
   *  backend/index.ts, so a newly published event binding takes effect immediately. */
  onPublish?: () => void;
}

export function registerAiPipelineEndpoints(deps: AiPipelineDeps): void {
  const { db, getHookCatalog, onPublish } = deps;

  registerEndpoint('GET', '/v1/ai-pipelines', (req, res) => {
    const rows = db.select().from(aiPipelines).all();
    res.json({ success: true, data: rows.map(row => rowWithGraph(db, row)) });
  }, { requires: ['core.apk:read'] });

  // Registered BEFORE the parameterized GET /v1/ai-pipelines/:id below — both the Express router
  // and handleWebSocketRestApi's manual dispatcher (api-service.ts) match routes in registration
  // order, so a literal path registered after a ':id' pattern that would also match it is
  // unreachable (':id' greedily matches "hook-catalog" as a param first). Order here is load-
  // bearing, not stylistic.
  registerEndpoint('GET', '/v1/ai-pipelines/hook-catalog', (req, res) => {
    res.json({ success: true, data: getHookCatalog?.() ?? [] });
  }, { requires: ['core.apk:read'] });

  registerEndpoint('GET', '/v1/ai-pipelines/:id', (req, res) => {
    const pipelineId = Number(req.params.id);
    const row = db.select().from(aiPipelines).where(eq(aiPipelines.id, pipelineId)).all()[0];
    if (!row) { res.status(404).json({ success: false, error: `No pipeline with id ${pipelineId}.` }); return; }
    res.json({ success: true, data: rowWithGraph(db, row) });
  }, { requires: ['core.apk:read'] });

  // ...existing POST /v1/ai-pipelines, POST /v1/ai-pipelines/:id/versions unchanged, between here and publish...

  registerEndpoint('POST', '/v1/ai-pipelines/:id/publish', (req, res) => {
    const pipelineId = Number(req.params.id);
    const latest = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, pipelineId))
      .orderBy(aiPipelineVersions.version).all().pop();
    if (!latest) { res.status(404).json({ success: false, error: 'No version to publish' }); return; }

    const errors = validateGraph(latest.graph as PipelineGraph);
    if (errors.length > 0) { res.status(400).json({ success: false, error: 'Invalid graph', errors }); return; }

    db.update(aiPipelineVersions).set({ status: 'draft' })
      .where(and(eq(aiPipelineVersions.pipelineId, pipelineId), eq(aiPipelineVersions.status, 'published')))
      .run();
    db.update(aiPipelineVersions).set({ status: 'published' }).where(eq(aiPipelineVersions.id, latest.id)).run();
    onPublish?.();
    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  // ...existing POST /v1/ai-pipelines/:id/run, GET /v1/ai-pipelines/runs/:runId unchanged...
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/api/ai-pipelines.test.ts`
Expected: PASS, all pre-existing tests (22 as of this plan's writing) plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add backend/api/ai-pipelines.ts backend/api/ai-pipelines.test.ts
git commit -m "feat(ai-pipelines): GET /hook-catalog endpoint + onPublish callback for the dispatcher"
```

---

### Task 10: Wire `HookTriggerDispatcher` into `backend/index.ts`

**Files:**
- Modify: `backend/index.ts`

**Interfaces:**
- Consumes: `HookTriggerDispatcher` (Task 8), `onPublish`/`getHookCatalog` (Task 9), `pluginManager.getHookBus()` (existing).
- Produces: the feature actually turns on at boot — no new exported interface, this is pure composition-root wiring. No dedicated test file (this file has none today; verified via `find backend -maxdepth 1 -iname "index.test.ts"` returns nothing) — verified instead by Task 11's e2e case and a manual boot check in Step 3 below.

- [ ] **Step 1: Factor `executors`/`buildCtx` into named consts shared by the REST registration and the dispatcher**

```ts
// backend/index.ts — replace the existing registerAiPipelineEndpoints call (around line 828)
const aiPipelineExecutors = buildApkAnalysisExecutors();
const buildAiPipelineCtx = (identity: { type: 'core-service' } | { type: 'user'; userId: number }, input: Record<string, unknown>) =>
  buildApkAnalysisExecutionCtx({ db, aiFactory, identity, versionId: input.versionId as number });

const hookTriggerDispatcher = new HookTriggerDispatcher({
  db,
  executors: aiPipelineExecutors,
  // An event payload has no "identity" the way a manual run does — every event-fired run
  // executes as the apk-analyzer core-service identity, same as apk-analyzer.ts's own existing
  // auto-trigger path does today (buildApkAnalysisExecutionCtx's `identity` param).
  buildCtx: (payload) => buildApkAnalysisExecutionCtx({ db, aiFactory, identity: { type: 'core-service' }, versionId: payload.apkVersionId as number }),
});

registerAiPipelineEndpoints({
  db,
  executors: aiPipelineExecutors,
  buildCtx: buildAiPipelineCtx,
  getHookCatalog: () => pluginManager.getHookBus().getDefinedHooks(),
  onPublish: () => hookTriggerDispatcher.refresh(),
});
```

Note: `hookTriggerDispatcher`'s `buildCtx` hardcodes `payload.apkVersionId` — this is a known, deliberate limitation flagged in the spec's Non-goals (`buildApkAnalysisExecutionCtx` is `apk-analysis`-job-kind-specific, same as `aiPipelineExecutors` already is; a second job kind's event-sourced Trigger would need its own executors/buildCtx pair, exactly as a second job kind would already need its own `buildApkAnalysisExecutors`-equivalent today — not a regression this task introduces, the existing single-global-executors-bag limitation this codebase already has, documented in the spec's "What already exists" section).

- [ ] **Step 2: Wire `attach` and the boot-time `refresh`, right next to the existing `setHookBus` block**

```ts
// backend/index.ts — immediately after the existing block:
//   apkAnalyzer.setHookBus(pluginManager.getHookBus());
//   apkTracker.setHookBus(pluginManager.getHookBus());
//   deviceManager.setHookBus(pluginManager.getHookBus());
//   captureManager.setHookBus(pluginManager.getHookBus());
//   runner.setHookBus(pluginManager.getHookBus());
hookTriggerDispatcher.attach(pluginManager.getHookBus());
hookTriggerDispatcher.refresh(); // covers a published version that existed before this feature shipped
```

- [ ] **Step 3: Add the import**

```ts
// backend/index.ts — near the other ai-jobs imports
import { HookTriggerDispatcher } from './services/ai-jobs/hook-trigger-dispatcher';
```

- [ ] **Step 4: Typecheck**

`backend/index.ts` isn't covered by any single test file — a clean compile is the gate here, real boot verification happens in the plan's Final Verification section against the actual dev server.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add backend/index.ts
git commit -m "feat(ai-jobs): wire HookTriggerDispatcher into the boot sequence"
```

---

### Task 11: Frontend — shared `KnownOptionPicker`, extracted from Trigger/Sink's duplicated logic

**Files:**
- Create: `frontend/pages/ai-jobs/KnownOptionPicker.tsx`
- Create: `frontend/pages/ai-jobs/KnownOptionPicker.test.tsx`
- Modify: `frontend/pages/ai-jobs/SidePanel.tsx` (`TriggerBody`, `SinkBody` switch to it — behavior unchanged, this task is a pure refactor; `TransformBody`'s switch to it happens in Task 12, bundled with it gaining a real picker for the first time)
- Modify: `frontend/pages/ai-jobs/SidePanel.test.tsx` (existing Trigger/Sink picker tests should need zero behavioral changes — only update any test that asserted on DOM structure the extraction might incidentally change, e.g. a wrapping `<div>`; verify by running first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `<KnownOptionPicker>`, consumed by Task 12's event-option-group addition to `TriggerBody`, and by `TransformBody`.

- [ ] **Step 1: Write the failing test for the extracted component**

```tsx
// frontend/pages/ai-jobs/KnownOptionPicker.test.tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KnownOptionPicker } from './KnownOptionPicker';

const options = [
  { value: 'a', description: 'Option A' },
  { value: 'b', description: 'Option B' },
];

describe('KnownOptionPicker', () => {
  it('shows the known value selected, with its description', () => {
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="a" onPick={() => {}} onCustomType={() => {}} />);
    expect(screen.getByLabelText('Pick one')).toHaveValue('a');
    expect(screen.getByText('Option A')).toBeInTheDocument();
  });

  it('calls onPick with the picked value, not Custom\'s sentinel', () => {
    const onPick = vi.fn();
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="a" onPick={onPick} onCustomType={() => {}} />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: 'b' } });
    expect(onPick).toHaveBeenCalledWith('b');
  });

  it('selecting Custom calls onPick with an empty string and shows the custom text field', () => {
    const onPick = vi.fn();
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="a" onPick={onPick} onCustomType={() => {}} customPlaceholder="custom value" />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: '__custom__' } });
    expect(onPick).toHaveBeenCalledWith('');
    expect(screen.getByPlaceholderText('custom value')).toBeInTheDocument();
  });

  it('an unrecognized value shows as Custom with its own editable text field', () => {
    const onCustomType = vi.fn();
    render(<KnownOptionPicker id="p" label="Pick one" options={options} value="my-plugin/thing" onPick={() => {}} onCustomType={onCustomType} customPlaceholder="custom value" />);
    expect(screen.getByLabelText('Pick one')).toHaveValue('__custom__');
    const input = screen.getByPlaceholderText('custom value');
    expect(input).toHaveValue('my-plugin/thing');
    fireEvent.change(input, { target: { value: 'my-plugin/other' } });
    expect(onCustomType).toHaveBeenCalledWith('my-plugin/other');
  });

  it('switching to a different known value after being in Custom mode leaves Custom mode (regression guard for the empty-string-looks-known bug)', () => {
    const onPick = vi.fn();
    const { rerender } = render(<KnownOptionPicker id="p" label="Pick one" options={options} value="" onPick={onPick} onCustomType={() => {}} customPlaceholder="custom value" />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: '__custom__' } });
    rerender(<KnownOptionPicker id="p" label="Pick one" options={options} value="" onPick={onPick} onCustomType={() => {}} customPlaceholder="custom value" />);
    expect(screen.getByPlaceholderText('custom value')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: 'a' } });
    expect(onPick).toHaveBeenLastCalledWith('a');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/ai-jobs/KnownOptionPicker.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement, generalizing `TriggerBody`'s existing `forceCustom` logic**

```tsx
// frontend/pages/ai-jobs/KnownOptionPicker.tsx
import React, { useState } from 'react';

const CUSTOM = '__custom__';

export interface KnownOption { value: string; description: string }

/**
 * Shared "pick a registered function/event, or type a custom one" control — the same pattern
 * previously hand-rolled three times (Trigger's expand functions, Sink's write functions, and
 * now Trigger's event sources / Transform's functions). `forceCustom` fixes the bug from commit
 * 98d8900: selecting Custom saves an empty value, which is ambiguous with "nothing chosen yet"
 * — local state remembers the explicit choice independent of the current value.
 */
export function KnownOptionPicker({ id, label, options, value, onPick, onCustomType, help, customPlaceholder = 'custom value' }: {
  id: string;
  label: string;
  options: KnownOption[];
  value: string;
  onPick: (value: string) => void;
  onCustomType: (value: string) => void;
  help?: string;
  customPlaceholder?: string;
}) {
  const known = options.find(o => o.value === value);
  const [forceCustom, setForceCustom] = useState(false);
  const isKnown = !forceCustom && (value === '' || known !== undefined);

  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="form-select" value={isKnown ? value : CUSTOM}
        onChange={(e) => {
          const isCustom = e.target.value === CUSTOM;
          setForceCustom(isCustom);
          onPick(isCustom ? '' : e.target.value);
        }}>
        <option value="">— choose —</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
        <option value={CUSTOM}>Custom (registered in code)…</option>
      </select>
      {!isKnown && (
        <input className="form-input" value={value} placeholder={customPlaceholder} onChange={(e) => onCustomType(e.target.value)} />
      )}
      {(known || help) && <div className="form-help">{known ? known.description : help}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/ai-jobs/KnownOptionPicker.test.tsx`
Expected: PASS, 5/5.

- [ ] **Step 5: Switch `TriggerBody`'s "Starts from" to use it**

```tsx
// frontend/pages/ai-jobs/SidePanel.tsx — inside TriggerBody, replace the "Starts from" form-group
<KnownOptionPicker
  id="trigger-expand-fn" label="Starts from"
  options={KNOWN_TRIGGER_EXPAND_FNS}
  value={expandFn}
  onPick={(picked) => {
    if (picked === '') { onSave(node.id, { expandFn: '' }); return; }
    const chosen = KNOWN_TRIGGER_EXPAND_FNS.find(f => f.value === picked)!;
    onSave(node.id, { expandFn: chosen.value, inputSchema: chosen.inputSchema, outputSchema: chosen.outputSchema });
  }}
  onCustomType={(typed) => onSave(node.id, { expandFn: typed })}
  help="Name of a function registered in backend/services/ai-jobs/nodes/trigger.ts."
  customPlaceholder="custom expand function name"
/>
```

(Remove `TriggerBody`'s own now-unused `known`/`forceCustom`/`isKnownFn` local declarations and the inline `<select>`/custom-`<input>` JSX this replaces — the schema-populate-on-pick logic moves into the `onPick` callback above, same behavior as today.)

- [ ] **Step 6: Switch `SinkBody`'s "Write function" to use it**

```tsx
// frontend/pages/ai-jobs/SidePanel.tsx — inside SinkBody, replace the "Write function" form-group
<KnownOptionPicker
  id="sink-write-fn" label="Write function"
  options={KNOWN_SINK_WRITE_FNS}
  value={writeFn}
  onPick={(picked) => onSave(node.id, { writeFn: picked })}
  onCustomType={(typed) => onSave(node.id, { writeFn: typed })}
  help="Name of a function registered in backend/services/ai-jobs/nodes/sink.ts."
  customPlaceholder="custom writeFn name"
/>
```

(`SinkBody`'s `known?.usesSection`-driven Section-title field, right below this, is unchanged — still reads `KNOWN_SINK_WRITE_FNS.find(f => f.value === writeFn)` directly for that one lookup, since `usesSection` isn't part of `KnownOptionPicker`'s generic contract.)

- [ ] **Step 7: Run the full SidePanel test file, fixing any DOM-structure-only breakage**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/ai-jobs/SidePanel.test.tsx`
Expected: PASS. If any pre-existing test fails only because of an incidental DOM change (e.g. a wrapping element), fix the test's selector, not the component — the behavior these tests assert (value shown, description shown, Custom escape hatch, onSave payloads) must not change in this task.

- [ ] **Step 8: Commit**

```bash
git add frontend/pages/ai-jobs/KnownOptionPicker.tsx frontend/pages/ai-jobs/KnownOptionPicker.test.tsx frontend/pages/ai-jobs/SidePanel.tsx frontend/pages/ai-jobs/SidePanel.test.tsx
git commit -m "refactor(ai-jobs): extract KnownOptionPicker, used by Trigger's Starts-from and Sink's Write-function"
```

---

### Task 12: Frontend — Trigger gains "Fires automatically on:", Transform gains a real picker

**Files:**
- Modify: `frontend/pages/ai-jobs/AiJobsWorkspace.tsx` (fetch the hook catalog, thread to `SidePanel`)
- Modify: `frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx`
- Modify: `frontend/pages/ai-jobs/SidePanel.tsx` (`TriggerBody` source-aware rendering; `TransformBody` gains `KNOWN_TRANSFORM_FNS` + picker)
- Modify: `frontend/pages/ai-jobs/SidePanel.test.tsx`

**Interfaces:**
- Consumes: `KnownOptionPicker` (Task 11), `GET /v1/ai-pipelines/hook-catalog` (Task 9).
- Produces: nothing further downstream — this is the UI-facing deliverable.

- [ ] **Step 1: Write the failing `AiJobsWorkspace` test for the catalog fetch**

Add to `frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx`, following the existing `recentVersions`-fetch test's pattern in the same file:

```ts
it('fetches the hook catalog on load and passes it to the selected node\'s side panel', async () => {
  const ws = createMockWs({
    pipelineVersion: mockPipelineVersion(),
    routes: {
      'GET /v1/ai-pipelines/hook-catalog': () => ({
        success: true,
        data: [{ name: 'apk:analyzed', schema: [{ field: 'apkVersionId', type: 'number', description: 'x' }], description: 'Fires once analysis finishes.' }],
      }),
    },
  });
  render(<AiJobsWorkspace pipelineId={1} />, { wrapper: withProviders(ws) });
  await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Full Analysis'));
  await screen.findByRole('dialog', { name: 'trigger-full details' });
  fireEvent.click(screen.getByLabelText('Starts from'));
  expect(screen.getByRole('option', { name: 'apk:analyzed' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx -t "hook catalog"`
Expected: FAIL — nothing fetches or threads the catalog yet.

- [ ] **Step 3: Add the fetch to `AiJobsWorkspace.tsx`, mirroring `recentVersions`**

```tsx
// frontend/pages/ai-jobs/AiJobsWorkspace.tsx
interface HookCatalogEntry { name: string; schema: Array<{ field: string; type: string; description: string }>; description: string }
// ...
const [hookCatalog, setHookCatalog] = useState<HookCatalogEntry[]>([]);
// ...inside the existing load useEffect, alongside the recentVersions fetch:
sendRestApi('GET', '/v1/ai-pipelines/hook-catalog').then((res: any) => {
  if (cancelled) return;
  setHookCatalog(res.body?.data ?? []);
});
// ...and on the <SidePanel> element:
hookCatalog={hookCatalog}
```

- [ ] **Step 4: Thread `hookCatalog` through `SidePanel` to `TriggerBody`**

```tsx
// frontend/pages/ai-jobs/SidePanel.tsx
export function SidePanel({ node, graph, triggerSchema, onClose, onSave, onDeleteNode, onRename, recentVersions, onRun, runStatus, hookCatalog }: {
  // ...existing props...
  hookCatalog?: Array<{ name: string; schema: SchemaField[]; description: string }>;
}) {
  // ...
  ) : node.config.kind === 'Trigger' ? (
    <TriggerBody node={node} onSave={onSave} recentVersions={recentVersions ?? []} onRun={onRun} hookCatalog={hookCatalog ?? []} />
  ) : (
  // ...
```

- [ ] **Step 5: Run to verify Step 1's test passes once `TriggerBody` renders the event option group (Step 6 below)**

(Deferred — Step 1's test needs Step 6's `TriggerBody` change to actually pass; run it again after Step 6.)

- [ ] **Step 6: `TriggerBody` — event option group, source-aware Run section**

```tsx
// frontend/pages/ai-jobs/SidePanel.tsx
function TriggerBody({ node, onSave, recentVersions, onRun, hookCatalog }: {
  node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void;
  recentVersions: RecentVersion[]; onRun?: (input: Record<string, unknown>, reuseUnchanged: boolean) => Promise<unknown>;
  hookCatalog: Array<{ name: string; schema: SchemaField[]; description: string }>;
}) {
  const source: 'function' | 'event' = node.config.source ?? 'function';
  const expandFn: string = node.config.expandFn ?? '';
  const eventName: string = node.config.eventName ?? '';
  const inputSchema: SchemaField[] = node.config.inputSchema ?? [];
  const outputSchema: SchemaField[] = node.config.outputSchema;

  const functionOptions = KNOWN_TRIGGER_EXPAND_FNS.map(f => ({ value: f.value, description: f.description }));
  const eventOptions = hookCatalog.map(h => ({ value: h.name, description: h.description }));
  // One combined <select> covering both groups — KnownOptionPicker doesn't natively support
  // <optgroup>, so this renders its own two-section select directly rather than stretching the
  // shared component's contract for one caller's grouping need.
  const pickedValue = source === 'event' ? eventName : expandFn;
  const known = functionOptions.find(f => f.value === pickedValue) ?? eventOptions.find(e => e.value === pickedValue);
  const [forceCustom, setForceCustom] = useState(false);
  const isKnown = !forceCustom && (pickedValue === '' || known !== undefined);

  function pickFunction(value: string) {
    setForceCustom(false);
    if (value === '') { onSave(node.id, { source: 'function', expandFn: '', eventName: undefined }); return; }
    const fn = KNOWN_TRIGGER_EXPAND_FNS.find(f => f.value === value)!;
    onSave(node.id, { source: 'function', expandFn: fn.value, eventName: undefined, inputSchema: fn.inputSchema, outputSchema: fn.outputSchema });
  }

  function pickEvent(value: string) {
    setForceCustom(false);
    const hook = hookCatalog.find(h => h.name === value)!;
    onSave(node.id, { source: 'event', eventName: hook.name, expandFn: undefined, inputSchema: undefined, outputSchema: hook.schema });
  }

  return (
    <>
      <div className="form-group">
        <label htmlFor="trigger-expand-fn">Starts from</label>
        <select id="trigger-expand-fn" className="form-select" value={isKnown ? pickedValue : '__custom__'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__custom__') { setForceCustom(true); onSave(node.id, { source: 'function', expandFn: '', eventName: undefined }); return; }
            if (functionOptions.some(f => f.value === v)) { pickFunction(v); return; }
            pickEvent(v);
          }}>
          <option value="">— choose —</option>
          <optgroup label="Starts manually from:">
            {functionOptions.map(f => <option key={f.value} value={f.value}>{f.value}</option>)}
          </optgroup>
          <optgroup label="Fires automatically on:">
            {eventOptions.map(e => <option key={e.value} value={e.value}>{e.value}</option>)}
          </optgroup>
          <option value="__custom__">Custom (registered in code)…</option>
        </select>
        {!isKnown && (
          <input className="form-input" value={expandFn} placeholder="custom expand function name"
            onChange={(e) => onSave(node.id, { source: 'function', expandFn: e.target.value, eventName: undefined })} />
        )}
        <div className="form-help">
          {known ? known.description : 'A registered function (see nodes/trigger.ts) or a typed event this Trigger fires on.'}
        </div>
      </div>
      <SchemaFieldListEditor
        label="Run parameters" fieldNoun="parameter" testId="trigger-input-field-row" typeOptions={RUN_PARAM_TYPES}
        help="A Trigger has no incoming wire on the canvas — these are the values the Run form below asks for each time someone runs it, not data from another node."
        fields={inputSchema} onChange={(next) => onSave(node.id, { inputSchema: next })}
      />
      <SchemaFieldListEditor
        label="Output schema" fieldNoun="output field" testId="schema-field-row" typeOptions={OUTPUT_FIELD_TYPES}
        help="What this Trigger hands downstream nodes, as {{trigger.field}}."
        fields={outputSchema} onChange={(next) => onSave(node.id, { outputSchema: next })}
      />
      {source === 'event' ? (
        <div className="form-group ai-jobs-run-section">
          <label>Run</label>
          <div className="form-help">Fires automatically when "{eventName}" happens — no manual Run needed.</div>
        </div>
      ) : (
        onRun && <TriggerRunSection inputSchema={inputSchema} recentVersions={recentVersions} onRun={onRun} />
      )}
    </>
  );
}
```

- [ ] **Step 7: Write the new SidePanel tests for event-mode**

Add to `frontend/pages/ai-jobs/SidePanel.test.tsx`'s Trigger describe block:

```ts
it('lists the hook catalog under "Fires automatically on:" alongside known functions', () => {
  const hookCatalog = [{ name: 'apk:analyzed', schema: [{ field: 'apkVersionId', type: 'number', description: 'x' }], description: 'Fires once analysis finishes.' }];
  render(<SidePanel node={triggerNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} hookCatalog={hookCatalog} />);
  expect(screen.getByRole('option', { name: 'apk:analyzed' })).toBeInTheDocument();
});

it('picking an event sets source: event, clears expandFn, and fills outputSchema from the event\'s schema', () => {
  const onSave = vi.fn();
  const hookCatalog = [{ name: 'apk:analyzed', schema: [{ field: 'apkVersionId', type: 'number', description: 'x' }], description: 'Fires once analysis finishes.' }];
  render(<SidePanel node={triggerNode} graph={graph} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} hookCatalog={hookCatalog} />);
  fireEvent.change(screen.getByLabelText(/starts from/i), { target: { value: 'apk:analyzed' } });
  expect(onSave).toHaveBeenCalledWith('trigger-full', {
    source: 'event', eventName: 'apk:analyzed', expandFn: undefined, inputSchema: undefined,
    outputSchema: [{ field: 'apkVersionId', type: 'number', description: 'x' }],
  });
});

it('an event-sourced Trigger shows "fires automatically" and no Run button', () => {
  const eventNode = { id: 'trigger-full', config: { kind: 'Trigger' as const, source: 'event' as const, eventName: 'apk:analyzed', outputSchema: [] } };
  render(<SidePanel node={eventNode} graph={{ nodes: [eventNode], edges: [] }} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} onRun={vi.fn()} hookCatalog={[]} />);
  expect(screen.getByText(/fires automatically when "apk:analyzed"/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
});

it('picking a function after being event-sourced clears eventName', () => {
  const onSave = vi.fn();
  const eventNode = { id: 'trigger-full', config: { kind: 'Trigger' as const, source: 'event' as const, eventName: 'apk:analyzed', outputSchema: [] } };
  render(<SidePanel node={eventNode} graph={{ nodes: [eventNode], edges: [] }} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} hookCatalog={[]} />);
  fireEvent.change(screen.getByLabelText(/starts from/i), { target: { value: 'apk-analysis/apk-context' } });
  expect(onSave).toHaveBeenCalledWith('trigger-full', expect.objectContaining({ source: 'function', eventName: undefined }));
});
```

- [ ] **Step 8: Run both suites to verify everything passes**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/ai-jobs/SidePanel.test.tsx frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx`
Expected: PASS, all tests including every pre-existing Trigger test (unchanged behavior for function-mode) plus the new ones.

- [ ] **Step 9: `TransformBody` gains a real picker, mirroring `SinkBody`**

```tsx
// frontend/pages/ai-jobs/SidePanel.tsx
// Duplicated from backend/services/ai-jobs/nodes/transform.ts's TRANSFORM_DESCRIPTIONS/TRANSFORM_SCHEMAS
// — the frontend can't import that module at runtime. Empty until a real Transform function is
// registered in code; the picker then shows only the Custom escape hatch, same as before this task.
const KNOWN_TRANSFORM_FNS: Array<{ value: string; description: string; inputSchema: SchemaField[]; outputSchema: SchemaField[] }> = [];

function TransformBody({ node, onSave }: { node: NodeLike; onSave: (nodeId: string, patch: Record<string, unknown>) => void }) {
  const fn: string = node.config.fn;
  return (
    <KnownOptionPicker
      id="transform-fn" label="Transform function"
      options={KNOWN_TRANSFORM_FNS.map(f => ({ value: f.value, description: f.description }))}
      value={fn}
      onPick={(picked) => {
        if (picked === '') { onSave(node.id, { fn: '' }); return; }
        const chosen = KNOWN_TRANSFORM_FNS.find(f => f.value === picked)!;
        onSave(node.id, { fn: chosen.value });
      }}
      onCustomType={(typed) => onSave(node.id, { fn: typed })}
      help="No Transform functions are registered in this codebase yet — see backend/services/ai-jobs/nodes/transform.ts. A run through this node fails with &quot;Unknown transform&quot; until one is registered in code."
      customPlaceholder="e.g. my-plugin/my-transform"
    />
  );
}
```

- [ ] **Step 10: Update the one existing TransformBody test to match (it currently asserts on the old freetext-only markup)**

Find the existing test (`'Transform: edits fn and discloses that nothing is registered'`, per the earlier session's SidePanel test inventory) and update its assertions to the new `KnownOptionPicker`-based markup — same user-visible behavior (empty options list, Custom-only, same help text), different DOM structure (now a `<select>` + conditional `<input>` instead of a bare `<input>`).

- [ ] **Step 11: Run the full frontend ai-jobs suite**

Run: `npx vitest run --config vitest.config.frontend.ts frontend/pages/ai-jobs`
Expected: PASS, every file green.

- [ ] **Step 12: Commit**

```bash
git add frontend/pages/ai-jobs/AiJobsWorkspace.tsx frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx frontend/pages/ai-jobs/SidePanel.tsx frontend/pages/ai-jobs/SidePanel.test.tsx
git commit -m "feat(ai-jobs): Trigger's Starts-from gains a typed event option group; Transform gets a real picker"
```

---

### Task 13: e2e — selecting an event trigger in the real editor

**Files:**
- Modify: `tests/e2e/ai-pipelines.spec.ts`

**Interfaces:**
- Consumes: everything above, against the real dev/e2e server.
- Produces: nothing further — terminal task.

- [ ] **Step 1: Write the e2e case**

Add to `tests/e2e/ai-pipelines.spec.ts`'s `test.describe('AI job pipelines', ...)` block:

```ts
test('picking a typed event as a Trigger\'s source fills its output schema and removes the Run form', async ({ page }) => {
  await loginAsAdmin(page);
  await waitForBackend(page.request);
  await page.goto('/ui/pipelines');
  await expect(page.getByTestId('pipelines-table')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '+ New Pipeline' }).click();
  await page.getByLabel('New pipeline name').fill('E2E Event Trigger Pipeline');
  await page.getByLabel('New pipeline job kind').fill('e2e-event-trigger');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);

  await page.getByRole('button', { name: '+ Add node' }).click();
  await page.getByRole('option', { name: /^Trigger/ }).click();
  const triggerPanel = page.getByRole('dialog');
  await expect(triggerPanel).toBeVisible();

  await triggerPanel.getByLabel('Starts from').selectOption('apk:analyzed');

  // Output schema auto-filled from the real, boot-registered apk:analyzed event schema — proves
  // the hook-catalog endpoint, not a mock, actually served this.
  const outputRows = triggerPanel.getByTestId('schema-field-row');
  await expect(outputRows.first().getByPlaceholder('name')).toHaveValue('apkVersionId');

  // No Run form for an event-sourced Trigger — nothing to click, the dispatcher starts these.
  await expect(triggerPanel.getByText(/fires automatically when "apk:analyzed"/i)).toBeVisible();
  await expect(triggerPanel.getByRole('button', { name: /^run$/i })).toHaveCount(0);
});
```

- [ ] **Step 2: Run it against the real e2e server**

Run: `npx playwright test tests/e2e/ai-pipelines.spec.ts -g "typed event" --reporter=line`
Expected: PASS. If it fails on the first run, check for the documented first-run warm-up flakiness (rerun once with `--retries=2`) before treating a failure as a real regression.

- [ ] **Step 3: Run the full file to confirm no regression in the other cases**

Run: `npx playwright test tests/e2e/ai-pipelines.spec.ts --reporter=line`
Expected: PASS, all cases (the pre-existing ones plus this new one).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/ai-pipelines.spec.ts
git commit -m "test(e2e): selecting a typed event as a Trigger's source, against the real hook catalog"
```

---

## Final verification (after Task 13)

- [ ] Full backend suite: `npx vitest run`
- [ ] Full frontend suite: `npm run test:frontend`
- [ ] Full e2e file: `npx playwright test tests/e2e/ai-pipelines.spec.ts --reporter=line`
- [ ] Throwaway tsc check over every touched frontend file (same pattern used earlier this session — frontend is never type-checked by the main build)
- [ ] `grep -rn "apk-analysis-complete" backend/` returns nothing
- [ ] `grep -rn "\.define(" backend/ packages/plugin-sdk/src | grep -v test` shows exactly the two real `setHookBus` call sites from Task 1
- [ ] Live browser check against the dev server (restart required — this plan touches `packages/plugin-sdk`, which `tsx watch` does not rebuild automatically): select an event trigger on a real test pipeline, confirm the schema fills in and the Run form disappears, matching Task 13's e2e assertions.
