# AI job pipelines: typed event triggers + unified node-function registry

Date: 2026-10-11
Status: Design for review (Cube). Scope and the three architectural forks below were settled in
chat before this was written; this document is the concrete shape for all three, grounded against
the real code, not a restatement of the conversation.

## The problem

Three related gaps, surfaced in order while fixing a smaller bug:

1. **Pipelines have no real auto-trigger mechanism of their own.** A pipeline runs two ways today:
   a human clicking Run (`POST /v1/ai-pipelines/:id/run`), or `apk-analyzer.ts`'s own
   `runAiPipeline` method (`apk-analyzer.ts:1017`) calling `startPipelineRun` directly, with a
   **hardcoded** `triggerNodeId: 'trigger-full'` and `input: { versionId }`. That second path only
   exists for this one pipeline, wired by name inside apk-analyzer.ts — no other pipeline, present
   or future, can hook into "an APK finished analysing" without someone editing apk-analyzer.ts
   itself to add another hardcoded call. That's exactly the coupling `apk-analyzer.ts` already
   avoids for **plugins**: it separately emits `hookBus.emit('apk:analyzed', {...})`
   (`apk-analyzer.ts:709`) specifically "so plugins ... can run their own post-analysis work
   without core depending on them" (the code's own comment). Pipelines don't get that same
   decoupling.
2. **A Trigger's known-function picker didn't say what it actually required.** Separately fixed
   today (commits `aa6cc46`..`ee7770e`): picking `apk-analysis/apk-context` from "Starts from"
   used to leave Run Parameters/Output Schema empty, so nothing on screen said the function needed
   a `versionId`. Fixed by giving `registerTrigger` a declared `{ inputSchema, outputSchema }`
   contract and having the picker fill both in. Mid-fix, Cube reframed the ask: a Trigger should
   also be fireable from a **typed internal event**, not only a manually-invoked function — a
   second, genuinely different *source* for a Trigger's data, modeled on how Home Assistant
   triggers work (an event with a known shape, not a form someone fills in).
3. **Three near-identical, divergent "registered function" patterns.** Chasing (2) across Sink,
   Trigger and Transform found three different shapes for what should be one concept: Sink
   (`nodes/sink.ts:23`) has a bare `usesSection` boolean and no schema; Trigger (as of today) has a
   real `{ description, inputSchema, outputSchema }` contract; Transform (`nodes/transform.ts`) has
   neither a description nor a schema — `registerTransform(name, fn)` is two arguments. Each
   `XxxBody` component in `SidePanel.tsx` hand-rolls its own near-identical known-function
   dropdown + "Custom (registered in code)…" escape hatch + `forceCustom` local-state workaround
   (the bug fixed in `98d8900` existed in two of these three copies).

## What already exists — verified in code, nothing below invents new infrastructure for this

- **`HookBus`** (`packages/plugin-sdk/src/types/hooks.ts`): `define(name, schema?)` /
  `on(name, handler)` / `off` / `emit(name, ...args)`. One shared instance
  (`pluginManager.getHookBus()`), already wired into `apk-tracker.ts`, `apk-analyzer.ts`,
  `automation-runner.ts`, `device-manager.ts`, `capture-session-manager.ts`, and every plugin via
  `ctx.hooks` (`plugin-context.ts:96`).
- **Two real events already fire today:**
  - `apk:analyzed` (`apk-analyzer.ts:709`) — payload `{ apkVersionId: number, packageName: string,
    apkPath: string, dbPath: string, outputDir: string, versionLabel: string }`.
  - `apk:version-detected` (`apk-tracker.ts:265`) — payload `{ trackedAppId: number, packageName:
    string, appName: string | null, source: string, versionName: string, previousVersion: string |
    null, analysed: boolean }`.
  - Nothing else calls `hookBus.emit` anywhere in `backend/` today. (Cube's second example,
    `couchbase.document-updated`, doesn't exist as a real emit site — no Couchbase watcher wired
    to HookBus. Illustrative, not implemented; not something this design fabricates a schema for.)
- **`HookBus.define(name, schema?: Record<string, string>)`** already exists
  (`hook-bus-impl.ts:14`) specifically to declare a hook's shape, and `getDefinedHooks()`
  (`hook-bus-impl.ts:50`) already exists to list them — **but nothing in the codebase calls
  `define()` or `getDefinedHooks()` anywhere.** This is dead, purpose-built scaffolding for exactly
  the "typed event catalog" this design needs. Reusing it (with one signature change, below) means
  the typed-event catalog isn't new infrastructure — it's turning on a feature that was already
  built and never wired up.
- **`startPipelineRun`** (`run-executor.ts:61`) is already the one shared entrypoint for starting a
  run, explicitly built — per its own doc comment — "so a REST-triggered run and an auto-triggered
  run can never race." Its `triggeredBy` field is typed `'manual' | 'apk-analysis-complete'`
  (`run-executor.ts:17`, mirrored in `db/schema.ts:821`); `'apk-analysis-complete'` is the literal
  `apk-analyzer.ts:1043` passes today. This design generalizes that one hardcoded literal into a
  real `'event'` case driven by whichever hook actually fired — see Non-goals for why
  `apk-analyzer.ts`'s existing hardcoded call isn't deleted as *part of* this change.
- **A separate, much bigger typed-function catalog already exists for AI tool-calling**:
  `AiToolRegistry` / `ai-tool-definitions.ts` — 90 registrations, JSON-Schema `inputSchema` (the
  shape Anthropic's tool-use API requires), `requiredScope`, `allowUnattended`, page `context`.
  Real, live, production. **Not touched by this design** — see Non-goals.

## Scope

**In scope:**
1. `TriggerConfig` gains a `source: 'function' | 'event'` discriminant — same `Trigger` NodeKind,
   same "Starts from" picker, two option-groups instead of one list.
2. The typed event catalog, built on `HookBus.define`/`getDefinedHooks` (signature change below),
   not a new parallel registry.
3. One shared node-function-registry factory, used by Sink, Trigger (function-mode) and Transform —
   collapses three hand-rolled registries into one, and gives Sink/Transform a real description +
   schema for the first time.
4. A new `HookTriggerDispatcher` service that subscribes published event-sourced Triggers to
   HookBus and starts their runs.
5. Frontend: the "Starts from" picker gains an event option-group; the three hand-rolled
   known-function pickers in `SidePanel.tsx` collapse onto one shared component.

**Out of scope (Non-goals, named explicitly so they aren't assumed later):**
- Bridging this with `AiToolRegistry` so the same declared capability is callable both by an AI
  agent's tool-use loop *and* as a deterministic graph node. Real idea, separate spec — the schema
  formats don't match (`SchemaField[]` here vs. JSON-Schema there, which the Claude API requires),
  and it means touching all 90 existing tool registrations' call sites for no gain this feature
  needs.
- Migrating `apk-analysis`'s `trigger-full` to `source: 'event'` and deleting `apk-analyzer.ts`'s
  `runAiPipeline` hardcoded call. Tempting — it's the exact case this design exists to generalize —
  but the hook's real payload field is `apkVersionId`, while `runAiPipeline`'s direct call passes
  `{ versionId }` and the registered expand function reads `rawInput.versionId`
  (`nodes/trigger.ts:21`). Reconciling that field-name mismatch (rename the hook payload? rename
  what the expand function reads? add a mapping step?) is a real decision with its own blast
  radius on the one pipeline actually in production use, and doesn't block shipping the mechanism
  itself. Flagged as the natural next step once this lands, not bundled into it.
- `couchbase.document-updated` or any other not-yet-real event. The catalog only ever contains
  events a real `hookBus.define()` call declares; nothing is pre-seeded speculatively.

## Design

### 1. `TriggerConfig` gains a source discriminant

```ts
export interface TriggerConfig {
  source: 'function' | 'event';
  /** Required when source === 'function'. Name of a pre-registered expand function. */
  expandFn?: string;
  /** Required when source === 'event'. Name of a hook declared via HookBus.define. */
  eventName?: string;
  /** Run parameters for a manual run — only meaningful when source === 'function'. An
   *  event-sourced Trigger has nothing to ask; the event's payload supplies everything. */
  inputSchema?: SchemaField[];
  outputSchema: SchemaField[];
}
```

`expandFn`/`eventName` go from required/non-existent to optional-and-mutually-exclusive. Every
other `NodeConfig` variant (`types.ts:72-79`) is untouched.

**Reading old data:** every already-published pipeline version's stored graph JSON predates
`source`. Every place that reads `TriggerConfig` (the generic Trigger executor below,
`graph-validator.ts`, `SidePanel.tsx`'s `TriggerBody`, `Canvas.tsx`) treats a missing `source` as
`'function'` — `config.source ?? 'function'` — so existing data needs no migration script. The two
real seeded nodes (`trigger-full`, `trigger-rescan` in `apk-analysis-pipeline.ts:65-66`) get
`source: 'function'` added explicitly in the source graph so the seed stays self-describing, even
though the default would cover them.

### 2. The typed event catalog — `HookBus.define`, not a new registry

`HookBus.define`'s `schema` param changes from `Record<string, string>` (type name only, never
used) to the same `SchemaField[]` shape ai-jobs already uses everywhere (`{ field, type,
description }[]`) — a safe signature change since nothing calls `define()` today:

```ts
// packages/plugin-sdk/src/types/hooks.ts
export interface HookBus {
  define(name: string, schema: SchemaField[], description: string): void;
  ...
}
```

Each emitting service declares its event's schema inside its own `setHookBus(bus)` method, right
after `this.hookBus = bus` (that's the one place each service's `HookBus` instance actually becomes
available) — not at the external call site that wires it. So the declared schema lives in the same
file as the `emit()` call it describes, and can never drift from the payload actually sent, same
discipline `TRIGGER_SCHEMAS` just added for expand functions:

```ts
// apk-analyzer.ts
setHookBus(bus: HookBus): void {
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

```ts
// apk-tracker.ts
setHookBus(bus: HookBus): void {
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

**Frontend access:** the editor can't import backend code, same reason the three `KNOWN_*_FNS`
constants are hand-duplicated. A small new read-only endpoint, `GET /v1/ai-pipelines/hook-catalog`,
returns `pluginManager.getHookBus().getDefinedHooks()` (name, schema, description) for the "Fires
automatically on:" option group to render from — avoiding a fourth hand-duplicated frontend
constant for something that's genuinely dynamic (plugins can call `define()` too, so the real set
of available events isn't knowable statically the way `apk-analysis/apk-context` is).

### 3. One shared node-function-registry factory

```ts
// backend/services/ai-jobs/nodes/function-registry.ts (new)
export interface RegisteredFunction<Fn> {
  name: string;
  fn: Fn;
  description: string;
  inputSchema?: SchemaField[];
  outputSchema?: SchemaField[];
}

export interface FunctionRegistry<Fn> {
  register(name: string, fn: Fn, description: string, schema?: { inputSchema?: SchemaField[]; outputSchema?: SchemaField[] }): void;
  get(name: string): Fn | undefined;
  list(): Array<Omit<RegisteredFunction<Fn>, 'fn'>>;
}

export function createFunctionRegistry<Fn>(): FunctionRegistry<Fn> { ... }
```

`nodes/sink.ts`, `nodes/trigger.ts` (function-mode only — event-mode has no `fn` to register, it
reads the HookBus catalog instead) and `nodes/transform.ts` each build one
`createFunctionRegistry<...>()` instance internally and keep their **existing exported names**
(`SINK_REGISTRY`, `TRIGGER_REGISTRY`, `TRIGGER_DESCRIPTIONS`, `TRIGGER_SCHEMAS`, a new
`TRANSFORM_DESCRIPTIONS`/`TRANSFORM_SCHEMAS`) as thin derived exports —
`export const SINK_REGISTRY = sinkRegistry` style — so every existing import site
(`apk-analysis-pipeline.ts`, every `nodes/*.test.ts`, `backend/index.ts`) is untouched. This is an
internal implementation merge, not a renamed public surface — the three files currently have
~15-20 lines of near-identical `Object.create(null)` + description-dict + schema-dict boilerplate
each; after this they have one `createFunctionRegistry()` call each plus their own function
bodies. `nodes/sink.ts`'s `usesSection` flag (not a schema concept, a UI-only "does this write
function read `config.section`" hint) stays as its own separate field, unrelated to this merge.

**`nodes/transform.ts` gains description + schema for the first time** — currently
`registerTransform(name, fn)` with no third argument at all (`transform.ts:7`). This is purely
additive: existing calls (if any are registered beyond test fixtures — checked, `transform.ts`
today registers nothing in production code) gain a required third/fourth argument, and
`SidePanel.tsx`'s `TransformBody` ("edits fn and discloses that nothing is registered," per its
own existing test name) gets the same known-function picker Sink and Trigger already have, instead
of a bare freetext field.

### 4. The generic Trigger executor moves out of apk-analysis-pipeline.ts

Today, `Trigger:` inside `buildApkAnalysisExecutors()` (`apk-analysis-pipeline.ts:97`) does
`TRIGGER_REGISTRY[config.expandFn]`, which is **already** job-kind-agnostic — `TRIGGER_REGISTRY` is
a single global map, not scoped per job kind (confirmed: `registerAiPipelineEndpoints` is wired
with exactly one global `executors` bag in `backend/index.ts:830`, for every pipeline regardless of
`job_kind`). There's no reason this logic lives in an "apk-analysis-specific" file. It moves to
`pipeline-runner.ts` (or a new `nodes/trigger-executor.ts`, imported by `pipeline-runner.ts`) as
the one real `Trigger` executor every job kind shares, with the new branch:

```ts
async function runTrigger(config: TriggerConfig, rawInput: Record<string, unknown>, ctx: ExecutionCtx): Promise<Record<string, unknown>> {
  if ((config.source ?? 'function') === 'event') {
    // The event payload already IS the expanded output — nothing to call.
    return rawInput;
  }
  const expand = TRIGGER_REGISTRY[config.expandFn!];
  if (!expand) throw new Error(`Unknown trigger expander "${config.expandFn}"`);
  return expand(rawInput, ctx);
}
```

`buildApkAnalysisExecutors()` drops its own `Trigger:` entry and uses this shared one. No change to
`NodeExecutors`'s shape (`pipeline-runner.ts:12`) — `Trigger` is still `(config, rawInput, ctx) =>
Promise<Record<string, unknown>>`; only what's inside it changes.

### 5. `HookTriggerDispatcher` — the new dispatcher service

```ts
// backend/services/ai-jobs/hook-trigger-dispatcher.ts (new)
export class HookTriggerDispatcher {
  constructor(deps: {
    db: AppDatabase;
    executors: NodeExecutors;
    buildCtx: (eventPayload: Record<string, unknown>) => ExecutionCtx;
  });
  attach(hookBus: HookBus): void;  // subscribe to every event name currently bound by a published Trigger
  refresh(): void;                  // re-scan published versions; add new subscriptions, drop stale ones
}
```

`refresh()` queries `aiPipelineVersions` where `status = 'published'`, parses each `graph`, collects
every `{ kind: 'Trigger', source: 'event', eventName }` node, and groups by `eventName`. For each
event name not yet subscribed, calls `hookBus.on(eventName, handler)`; for each previously-
subscribed name no longer used by any published version, calls `hookBus.off`. The handler itself
re-reads the current binding set at fire time (not closed over at subscribe time), so it always
reflects whatever was most recently published:

```ts
function handler(payload: Record<string, unknown>) {
  for (const binding of currentBindingsFor(eventName)) {
    startPipelineRun({
      db, pipelineVersionId: binding.versionId, graph: binding.graph,
      triggerNodeId: binding.triggerNodeId, input: payload,
      triggeredBy: 'event', executors, buildCtx: () => buildCtx(payload),
      onSettled: (result, crashError) => { /* log + broadcast, same shape apk-analyzer.ts's onSettled uses */ },
    });
  }
}
```

**Wiring** (`backend/index.ts`): instantiated with the same `executors`/`buildCtx` factored out for
`registerAiPipelineEndpoints` (currently rebuilt inline at `backend/index.ts:828-832` — pulled into
named consts both share). `dispatcher.attach(pluginManager.getHookBus())` goes right next to the
existing `.setHookBus(...)` block (`backend/index.ts:1226-1230`). `dispatcher.refresh()` runs once
at boot (covers a published version that existed before this feature shipped) and again whenever a
pipeline is published — `registerAiPipelineEndpoints` gains an optional `onPublish?: () => void`
its publish handler (`ai-pipelines.ts`) calls after a successful publish; `backend/index.ts` wires
it to `dispatcher.refresh`. Same dependency-injection shape already used for the
`getPipelinesEnabled` callback that was in this same file until today's earlier fix.

**`StartPipelineRunOptions.triggeredBy`** (`run-executor.ts:17`) widens from `'manual' |
'apk-analysis-complete'` to `'manual' | 'event'` — the one literal `apk-analyzer.ts:1043` passes
today is a special case of "automatic," not a thing worth its own type-level name once "automatic"
has a real general meaning. `apk-analyzer.ts`'s existing call keeps working by passing `'event'`
instead (the specific hook name, if useful for display, is already recoverable from the node's own
`config.eventName` — `triggeredBy` only needs to distinguish human-initiated from not). `db/schema.ts:821`'s column comment updates to match.

### 6. Frontend: one shared known-function/known-event picker

`SidePanel.tsx` currently hand-rolls the same pattern three times: a `KNOWN_*` array, an
`isKnownFn`/`forceCustom` pair of local state, a `<select>` + conditional custom `<input>`. Extract
one component:

```tsx
function KnownOptionPicker<T extends { value: string; description: string }>({
  id, label, options, value, onPick, onCustomType, help, customPlaceholder,
}: { ...}): JSX.Element
```

`TriggerBody`'s "Starts from" becomes two `<optgroup>`s inside the same `<select>` — "Starts
manually from:" (today's `KNOWN_TRIGGER_EXPAND_FNS`, unchanged) and "Fires automatically on:" (the
new event catalog, fetched from `GET /v1/ai-pipelines/hook-catalog`). Picking an event sets
`{ source: 'event', eventName, expandFn: undefined, inputSchema: undefined, outputSchema:
<event's schema> }`; picking a function sets `{ source: 'function', expandFn, eventName: undefined,
inputSchema: <fn's inputSchema>, outputSchema: <fn's outputSchema> }` — same overwrite-on-pick rule
already shipped today for function selection, extended to the new source. `TriggerRunSection`
(`SidePanel.tsx:316`) renders its existing form only when `source === 'function'`; when `source ===
'event'`, it shows `Fires automatically when "<eventName>" happens — no manual Run needed.` and
hides the Run button entirely (nothing to click; the dispatcher is what starts these runs).
`SinkBody` and `TransformBody` switch to the same shared picker component, unchanged behavior.

## Validation (`graph-validator.ts`)

One addition: a Trigger node must declare exactly one of `expandFn` (when `source === 'function'`)
or `eventName` (when `source === 'event'`), never both, never neither. Everything else in
`graph-validator.ts` (root-ness, cross-Trigger output-schema consistency, zone partitioning) is
unchanged — an event-sourced Trigger is still a Trigger for every structural rule that already
exists.

## Data flow — event-fired run, end to end

1. `apk-analyzer.ts` finishes analysing a version, calls `this.hookBus.emit('apk:analyzed', {
   apkVersionId, packageName, apkPath, dbPath, outputDir, versionLabel })` — unchanged, already
   happens today.
2. `HookTriggerDispatcher`'s subscribed handler for `'apk:analyzed'` fires, looks up every
   currently-published Trigger bound to that event name.
3. For each, `startPipelineRun({ ..., triggerNodeId, input: <the hook payload>, triggeredBy:
   'event', ... })` — the same function the REST endpoint calls.
4. `runPipeline` calls `executors.Trigger(config, input, ctx)`; the generic executor (§4) sees
   `source === 'event'` and returns `input` unchanged as the Trigger's output — no registry lookup.
5. Everything downstream (`{{trigger.field}}` templates, memoization, Report/Sink) is identical to
   a manually-run Trigger; it never knows whether its input came from a Run click or a hook fire.

## Open questions

1. Multiple Triggers across different pipelines bound to the same event name: run them
   concurrently or sequentially? Nothing in `startPipelineRun`'s existing concurrency guard
   (keyed on `pipelineVersionId`, `run-executor.ts:51-55`) prevents concurrent firing across
   *different* pipeline versions — leaning toward "concurrent, no new guard," since that's already
   true of two different pipelines today; flag if that's wrong.
2. Should `GET /v1/ai-pipelines/hook-catalog` be scoped to only hooks a given job kind's pipelines
   plausibly care about, or always return the full catalog? Leaning toward always-full — the
   catalog is small today (two entries) and job-kind scoping is a filter the UI can add later
   without a contract change.
3. `HookTriggerDispatcher`'s `onSettled` failure handling (what gets logged/broadcast when an
   event-fired run fails, with no human watching a side panel) isn't designed above — needs the
   same thought `apk-analyzer.ts`'s own `onSettled` got (`recordAiFailure`/notification), scoped
   generically instead of APK-specific. Proposing: log via `createLoggers('ai-jobs-hook-dispatch')`
   and leave broadcast/notification as explicit future work rather than guessing a generic shape
   now.
