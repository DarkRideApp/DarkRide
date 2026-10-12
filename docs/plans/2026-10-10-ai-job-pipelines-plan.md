# AI Job Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apk-analyzer.ts`'s single long-lived AI agent run (one system prompt, one write-tier escalation, whole-run blast radius on any refusal) with a typed graph of small scoped nodes, a generic executor, and a visual editor — ship the Astérix pipeline (7 `AgentCall`s → `Report` → `Sink`, two disjoint `Trigger` zones) as the first thing built on it.

**Architecture:** Three layers — a node primitive library (`backend/services/ai-jobs/nodes/`, pure `(input, ctx) => output` functions), a pipeline definition + executor (`backend/services/ai-jobs/pipeline-runner.ts`, versioned graph rows + topological walk with skip propagation, envelope nodes, multi-trigger zones, opt-in memoization), and a visual editor (`frontend/pages/ai-jobs/`, `@xyflow/react`). Backend phases (A–E below) are independently testable and shippable before the frontend (F) exists — the REST API and gate tests don't need a UI to verify.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3), Express (REST-over-WebSocket via `api-service.ts`), vitest, React 19, `@xyflow/react`, Playwright.

**Spec:** `docs/specs/2026-10-10-ai-job-pipelines-design.md` — this plan implements it task-by-task; read both together. Code in this plan matches the spec's node contracts, executor semantics, data model, and the `Report` node's design exactly; where this plan needs a concrete choice the spec left as a pure interface, that choice is called out inline.

## Global Constraints

- Node 24, TypeScript throughout — match existing file conventions (see any file under `backend/services/` for the house style: `createLoggers(name)` for logging, named exports, no default exports).
- Drizzle schema changes always ship as a migration file under `migrations/` (project root, not `backend/db/migrations/`) with a matching `migrations/meta/_journal.json` entry, `--> statement-breakpoint` between every statement in a multi-statement `.sql` file, and a `when` value strictly greater than the **max** `when` across every existing journal entry (currently `1791494784563` — verify at execution time, it will have moved).
- Every new backend module ships a co-located `.test.ts` in the same commit (gate tests: mocked dependencies, deterministic, <2s, no live model calls).
- Drizzle unit tests use `new Database(':memory:')` + raw SQL `sqlite.exec()` to create tables per test, then `drizzle(sqlite, { schema })` — never import migration files into tests (they pull in plugin schema that may not be installed).
- REST endpoints register via `registerEndpoint(method, path, handler, { requires: [...] })` from `backend/api/api-service.ts`; scopes come from `backend/services/ai-tool-definitions.ts`'s existing `patch_analysis_section`/`write_analysis_notes`/`read_analysis_notes` scopes (`core.apk:manage` / `core.apk:read`) — reuse them exactly, don't invent new scope strings.
- `AgentCall` nodes call through `BoundAgent.handleMessage` (`backend/services/ai-agent-factory.ts`), never raw `ai-agent.ts` — that's where call-logging and identity resolution live.
- Frontend: TDD still applies (component tests with `@testing-library/react`), and every user-facing flow gets a Playwright e2e spec per `feedback_e2e_testing_mandatory` (project memory) — no exceptions.
- Commit after every task, per CLAUDE.md's "After every task — commit, push, restart." Push happens once per work session, not necessarily after each individual commit, unless told otherwise.
- `tsc` does not check `frontend/` (project memory: `frontend_not_typechecked.md`) — frontend tasks still need a throwaway `tsc` pass before calling the task done, same as the plugins-workspace precedent.

## Review Focus

- **A `Trigger`'s raw input is missing a required field** (`{}` instead of `{ versionId }`) — the `apk-analysis` `Trigger`'s expand function must throw a clear error, not silently produce an `ApkContext` with `undefined` fields that only breaks three nodes downstream. (Task 4)
- **A template references a node that's `inactive` this run**, not just a typo'd path — `{{some-node.field}}` where `some-node` exists in the graph but isn't in the fired `Trigger`'s reachable zone. Resolution must fail the same way as an unknown path, not return `undefined`. (Task 3)
- **Publishing a pipeline version where two `Trigger`s declare different output schemas**, or where a node is reachable from more than one `Trigger` — the graph validator must reject this at publish time, not surface as a confusing runtime failure on whichever `Trigger` fires second. (Task 11)
- **A `Sink` write fails because its target no longer exists** (e.g. the tracked APK version was deleted mid-run) — `patchNoteSection`/`setNote` throwing on a missing `apkVersions` row must become an ordinary `failed` node-run, not an unhandled rejection that takes down the whole executor process. (Task 10)
- **Two runs of the same pipeline version fire concurrently** (double-click Run, or a manual run overlapping an auto-triggered one) — genuinely unaddressed by the spec, which only covers same-run parallel `Sink` writes. The cheap, decisive fix: reject a second run for a pipeline version that already has a `running` row, rather than leaving the race unaddressed. (Task 19)

---

## Phase A: Data model

### Task 1: Schema + migration for the four pipeline tables

**Files:**
- Modify: `backend/db/schema.ts` (append after the last table — check the end of the file for the current last export before inserting, so the diff is a clean append)
- Create: `migrations/0102_ai_pipelines.sql` (verify this is actually the next free number — `ls migrations/*.sql | wc -l` was 85 and the journal's last `idx` was 101 at spec time; recompute both at execution time)
- Modify: `migrations/meta/_journal.json`
- Test: `backend/db/schema.test.ts` (create if it doesn't exist; if it does, append to it)

**Interfaces:**
- Produces: `aiPipelines`, `aiPipelineVersions`, `aiPipelineRuns`, `aiPipelineNodeRuns` (Drizzle table objects, imported by every later backend task as `import { aiPipelines, aiPipelineVersions, aiPipelineRuns, aiPipelineNodeRuns } from '../db/schema'` relative to `backend/services/ai-jobs/`).

- [ ] **Step 1: Write the failing test**

```ts
// backend/db/schema.test.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as schema from './schema';

describe('ai_pipelines tables', () => {
  it('cascades deletes from aiPipelines through to aiPipelineNodeRuns', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE ai_pipelines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        job_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE ai_pipeline_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        graph TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        UNIQUE(pipeline_id, version)
      );
      CREATE TABLE ai_pipeline_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_version_id INTEGER NOT NULL REFERENCES ai_pipeline_versions(id) ON DELETE CASCADE,
        trigger_node_id TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        input TEXT,
        reuse_unchanged INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE ai_pipeline_node_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES ai_pipeline_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        input_hash TEXT,
        was_memoized INTEGER NOT NULL DEFAULT 0,
        output TEXT,
        error TEXT,
        model_used TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);
    const db = drizzle(sqlite, { schema });

    const now = new Date();
    db.insert(schema.aiPipelines).values({ id: 1, name: 'Astérix', jobKind: 'apk-analysis', createdAt: now }).run();
    db.insert(schema.aiPipelineVersions).values({ id: 1, pipelineId: 1, version: 1, graph: { nodes: [], edges: [] }, status: 'published', createdAt: now }).run();
    db.insert(schema.aiPipelineRuns).values({ id: 1, pipelineVersionId: 1, triggerNodeId: 'trigger', triggeredBy: 'manual', status: 'running', startedAt: now }).run();
    db.insert(schema.aiPipelineNodeRuns).values({ id: 1, runId: 1, nodeId: 'agent-overview', status: 'ok', startedAt: now }).run();

    db.delete(schema.aiPipelines).where(eq(schema.aiPipelines.id, 1)).run();

    expect(db.select().from(schema.aiPipelineNodeRuns).all()).toHaveLength(0);
  });
});
```

Add `import { eq } from 'drizzle-orm';` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/db/schema.test.ts`
Expected: FAIL — `schema.aiPipelines` is undefined (not exported yet).

- [ ] **Step 3: Write the schema additions**

Append to `backend/db/schema.ts`:

```ts
export const aiPipelines = sqliteTable('ai_pipelines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  jobKind: text('job_kind').notNull(), // 'apk-analysis' | future kinds
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const aiPipelineVersions = sqliteTable('ai_pipeline_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineId: integer('pipeline_id').notNull().references(() => aiPipelines.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  // Deliberately the generic shape, not Task 2's real PipelineGraph — backend/db/schema.ts is
  // more foundational than feature code under ai-jobs/ and shouldn't import from it (consumers
  // like Task 19's REST handler cast `as PipelineGraph`, which is the intended, acceptable
  // layering here, not a gap to close by reaching schema.ts into a higher-level module).
  graph: text('graph', { mode: 'json' }).$type<{ nodes: unknown[]; edges: unknown[] }>().notNull(),
  status: text('status', { enum: ['draft', 'published'] }).notNull().default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  uniqueVersion: unique().on(t.pipelineId, t.version),
}));

export const aiPipelineRuns = sqliteTable('ai_pipeline_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineVersionId: integer('pipeline_version_id').notNull().references(() => aiPipelineVersions.id, { onDelete: 'cascade' }),
  triggerNodeId: text('trigger_node_id').notNull(),
  triggeredBy: text('triggered_by').notNull(), // 'manual' | 'apk-analysis-complete'
  input: text('input', { mode: 'json' }).$type<Record<string, unknown>>(),
  reuseUnchanged: integer('reuse_unchanged', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ['running', 'ok', 'failed', 'partial'] }).notNull().default('running'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});

export const aiPipelineNodeRuns = sqliteTable('ai_pipeline_node_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => aiPipelineRuns.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  status: text('status', { enum: ['ok', 'failed', 'skipped', 'inactive'] }).notNull(),
  input: text('input', { mode: 'json' }).$type<Record<string, unknown>>(),
  inputHash: text('input_hash'),
  wasMemoized: integer('was_memoized', { mode: 'boolean' }).notNull().default(false),
  output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
  error: text('error'),
  modelUsed: text('model_used'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});
```

Confirm `unique` is already imported at the top of `schema.ts` (it's used elsewhere, e.g. `aiPipelineVersions`'s own precedent tables) — if not, add it to the `drizzle-orm/sqlite-core` import line.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Write the migration file**

Create `migrations/0102_ai_pipelines.sql` (recheck the number is free first):

```sql
CREATE TABLE IF NOT EXISTS ai_pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_pipeline_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  UNIQUE(pipeline_id, version)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_version_id INTEGER NOT NULL REFERENCES ai_pipeline_versions(id) ON DELETE CASCADE,
  trigger_node_id TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  input TEXT,
  reuse_unchanged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_pipeline_node_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ai_pipeline_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  input_hash TEXT,
  was_memoized INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  error TEXT,
  model_used TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_pipeline_node_runs_run_idx ON ai_pipeline_node_runs(run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_pipeline_node_runs_memo_idx ON ai_pipeline_node_runs(node_id, input_hash);
```

Append to `migrations/meta/_journal.json`'s `entries` array (compute `when` as `max(existing whens) + 1`, do not hardcode the literal below without checking — it's illustrative of the shape, not a value to copy blindly):

```json
{
  "idx": 102,
  "version": "7",
  "when": 1791700000000,
  "tag": "0102_ai_pipelines",
  "breakpoints": true
}
```

- [ ] **Step 6: Verify the migration applies cleanly**

Run the project's normal dev-server startup against a scratch copy of the dev DB (never the real one) and confirm no migration error in the log, then confirm the four tables exist:

```bash
sqlite3 /path/to/scratch-copy.db ".tables" | grep ai_pipeline
```

Expected: `ai_pipelines  ai_pipeline_node_runs  ai_pipeline_runs  ai_pipeline_versions`

- [ ] **Step 7: Commit**

```bash
git add backend/db/schema.ts backend/db/schema.test.ts migrations/0102_ai_pipelines.sql migrations/meta/_journal.json
git commit -m "feat(ai-jobs): add ai_pipelines/versions/runs/node_runs schema + migration"
```

---

## Phase B: Node primitives

Each node kind is a pure function `(input, ctx) => output` plus a thin adapter the executor calls. `ctx` carries whatever a node needs beyond its input (the `BoundAgent` for `AgentCall`, the `db` for `Sink`, etc.) so each node file stays independently testable with a fake `ctx`.

### Task 2: Shared types

**Files:**
- Create: `backend/services/ai-jobs/types.ts`
- Test: `backend/services/ai-jobs/types.test.ts`

**Interfaces:**
- Produces: `PipelineNode`, `PipelineEdge`, `PipelineGraph`, `NodeRunStatus`, `RunStatus`, `Envelope<T>`, `NodeKind`, `AgentCallConfig`, `TransformConfig`, `BranchConfig`, `ReportConfig`, `ForEachConfig`, `SinkConfig`, `TriggerConfig` — every later task imports from here, so get the shapes right once.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/types.test.ts
import { describe, it, expect } from 'vitest';
import { isEnvelopeOk } from './types';
import type { Envelope } from './types';

describe('Envelope', () => {
  it('isEnvelopeOk narrows to the ok variant', () => {
    const ok: Envelope<{ n: number }> = { status: 'ok', output: { n: 1 } };
    const failed: Envelope<{ n: number }> = { status: 'failed', error: 'boom' };
    expect(isEnvelopeOk(ok)).toBe(true);
    expect(isEnvelopeOk(failed)).toBe(false);
    if (isEnvelopeOk(ok)) {
      expect(ok.output.n).toBe(1); // type-level: output must be accessible here
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/types.test.ts`
Expected: FAIL — module `./types` does not exist.

- [ ] **Step 3: Write the types**

```ts
// backend/services/ai-jobs/types.ts

export type NodeKind = 'Trigger' | 'AgentCall' | 'Transform' | 'Branch' | 'Report' | 'ForEach' | 'Sink';

export type NodeRunStatus = 'ok' | 'failed' | 'skipped' | 'inactive';
export type RunStatus = 'running' | 'ok' | 'failed' | 'partial';

/** What an envelope node (Branch, Report) receives per predecessor instead of a bare value. */
export type Envelope<T = unknown> =
  | { status: 'ok'; output: T }
  | { status: 'failed'; error: string }
  | { status: 'skipped' | 'inactive' };

export function isEnvelopeOk<T>(e: Envelope<T>): e is { status: 'ok'; output: T } {
  return e.status === 'ok';
}

export interface AgentCallConfig {
  tier: string;
  instructionTemplate: string;
  toolAllowlist: string[];
}

export interface TransformConfig {
  /** Name of a pre-registered function — see nodes/transform.ts's registry. Never freeform code. */
  fn: string;
}

export interface BranchConfig {
  /** Name of a pre-registered predicate function — see nodes/branch.ts's registry. */
  predicate: string;
  /** Edge labels this Branch can route to; must match outgoing edge labels in the graph. */
  edges: string[];
}

export interface ReportSection {
  title: string;
  /** Source node id — must be a direct incoming edge's source. */
  from: string;
}

export interface ReportConfig {
  sections: ReportSection[];
}

export interface ForEachConfig {
  /** Name of a pre-registered per-item function. */
  itemFn: string;
}

export interface SinkConfig {
  /** Name of a pre-registered write function — see nodes/sink.ts's registry. */
  writeFn: string;
  /** Which incoming predecessor's output to read the payload from — same convention as
   *  Report's sections[].from. The executor wraps every node's input by source-node-id, even
   *  with exactly one incoming edge (see Tasks 13-17), so a write function can never read a
   *  field straight off the generic `input` bag; this says which key to unwrap first. */
  from?: string;
  /** Static section title — only meaningful for the 'apk-analysis/write-section' writeFn. */
  section?: string;
}

export interface TriggerConfig {
  /** Name of a pre-registered expand function — see nodes/trigger.ts's registry. */
  expandFn: string;
  /** Declared output schema, shared across every Trigger in one pipeline (validator-enforced). */
  outputSchema: Array<{ field: string; type: string; description: string }>;
}

export type NodeConfig =
  | ({ kind: 'Trigger' } & TriggerConfig)
  | ({ kind: 'AgentCall' } & AgentCallConfig)
  | ({ kind: 'Transform' } & TransformConfig)
  | ({ kind: 'Branch' } & BranchConfig)
  | ({ kind: 'Report' } & ReportConfig)
  | ({ kind: 'ForEach' } & ForEachConfig)
  | ({ kind: 'Sink' } & SinkConfig);

export interface PipelineNode {
  id: string;
  config: NodeConfig;
}

export interface PipelineEdge {
  from: string;
  to: string;
  /** Only meaningful for a Branch's outgoing edges; omitted elsewhere. */
  label?: string;
}

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/types.ts backend/services/ai-jobs/types.test.ts
git commit -m "feat(ai-jobs): add shared pipeline/node types"
```

### Task 3: Template resolution

**Files:**
- Create: `backend/services/ai-jobs/template.ts`
- Test: `backend/services/ai-jobs/template.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure string function).
- Produces: `resolveTemplate(template: string, scope: Record<string, unknown>): string` — throws `TemplateResolutionError` on any unresolved `{{...}}`. Used by Task 5 (`AgentCall`) to resolve `instructionTemplate` before calling `handleMessage`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/template.test.ts
import { describe, it, expect } from 'vitest';
import { resolveTemplate, TemplateResolutionError } from './template';

describe('resolveTemplate', () => {
  it('substitutes a dotted path from scope', () => {
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(resolveTemplate('Analyze {{trigger.appName}}.', scope)).toBe('Analyze Parc Astérix.');
  });

  it('substitutes multiple placeholders, including from a non-trigger source', () => {
    const scope = { trigger: { versionName: '6.10.1' }, 'agent-overview': { summary: 'React Native app' } };
    expect(resolveTemplate('{{agent-overview.summary}} (v{{trigger.versionName}})', scope))
      .toBe('React Native app (v6.10.1)');
  });

  it('throws on an unresolved path instead of leaving literal braces', () => {
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(() => resolveTemplate('{{trigger.appNmae}}', scope)).toThrow(TemplateResolutionError);
  });

  it('throws when the source key exists but the field does not', () => {
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(() => resolveTemplate('{{trigger.versionCode}}', scope)).toThrow(TemplateResolutionError);
  });

  it('throws referencing a node that is inactive this run, same as an unknown path', () => {
    // inactive nodes are simply absent from scope — the executor never adds them
    const scope = { trigger: { appName: 'Parc Astérix' } };
    expect(() => resolveTemplate('{{agent-diff.summary}}', scope)).toThrow(TemplateResolutionError);
  });

  it('does not evaluate expressions — a non-identifier path is a literal miss, not an error about syntax', () => {
    const scope = { trigger: { fileSizeBytes: 150088871 } };
    expect(() => resolveTemplate('{{trigger.fileSizeBytes / 1024}}', scope)).toThrow(TemplateResolutionError);
  });

  it('passes through text with no placeholders unchanged', () => {
    expect(resolveTemplate('No variables here.', {})).toBe('No variables here.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/template.test.ts`
Expected: FAIL — module `./template` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/template.ts

export class TemplateResolutionError extends Error {
  constructor(public readonly path: string) {
    super(`Unresolved template path "{{${path}}}" — the node fails rather than sending literal braces to the model.`);
    this.name = 'TemplateResolutionError';
  }
}

const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\}\}/g;

/**
 * Dotted-path-only substitution: {{source.field}} → scope[source][field]. Never an expression —
 * a path with anything but identifiers and dots (e.g. "trigger.fileSizeBytes / 1024") simply
 * never matches PLACEHOLDER_RE as a whole, so the literal "{{...}}" is left in the template and
 * then fails the generic "still has braces after substitution" check below. Fails loud: an
 * unresolved placeholder throws, it never survives into what gets sent to a model.
 */
export function resolveTemplate(template: string, scope: Record<string, unknown>): string {
  const resolved = template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const [source, ...fieldParts] = path.split('.');
    if (fieldParts.length === 0) throw new TemplateResolutionError(path);
    let value: unknown = scope[source];
    for (const part of fieldParts) {
      if (value === null || typeof value !== 'object') throw new TemplateResolutionError(path);
      value = (value as Record<string, unknown>)[part];
    }
    if (value === undefined || value === null) throw new TemplateResolutionError(path);
    return String(value);
  });
  // A malformed placeholder (e.g. an expression) never matched PLACEHOLDER_RE, so it's still
  // sitting in `resolved` verbatim — catch it here rather than silently shipping it to a model.
  const stillBraced = resolved.match(/\{\{[^}]*\}\}/);
  if (stillBraced) throw new TemplateResolutionError(stillBraced[0].slice(2, -2));
  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/template.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/template.ts backend/services/ai-jobs/template.test.ts
git commit -m "feat(ai-jobs): add dotted-path template resolution, fail-loud on a miss"
```

### Task 4: Trigger node + the `apk-analysis` `ApkContext` expander

**Files:**
- Create: `backend/services/ai-jobs/nodes/trigger.ts`
- Test: `backend/services/ai-jobs/nodes/trigger.test.ts`

**Interfaces:**
- Consumes: nothing from earlier node tasks.
- Produces: `TRIGGER_REGISTRY: Record<string, TriggerExpander>` where `type TriggerExpander = (rawInput: Record<string, unknown>, ctx: TriggerCtx) => Promise<Record<string, unknown>>`; `registerTrigger(name, fn)`; the `'apk-analysis/apk-context'` entry registered by this task. `TriggerCtx` carries `{ db: AppDatabase }`. The executor (Task 12+) looks up `config.expandFn` in `TRIGGER_REGISTRY`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/trigger.test.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../db/schema';
import { TRIGGER_REGISTRY } from './trigger';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tracked_apps (id INTEGER PRIMARY KEY, package_name TEXT NOT NULL, app_name TEXT, auto_analyse INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE apk_versions (id INTEGER PRIMARY KEY, tracked_app_id INTEGER NOT NULL, version_code INTEGER NOT NULL, version_name TEXT, filename TEXT NOT NULL, file_size INTEGER, device_id TEXT, source TEXT DEFAULT 'device', downloaded_at INTEGER NOT NULL);
  `);
  return drizzle(sqlite, { schema });
}

describe('apk-analysis/apk-context trigger', () => {
  it('expands { versionId } into the full ApkContext struct', async () => {
    const db = makeDb();
    db.insert(schema.trackedApps).values({ id: 17, packageName: 'fr.parcasterix.appli.android', appName: 'Parc Astérix', createdAt: new Date() }).run();
    db.insert(schema.apkVersions).values({
      id: 431, trackedAppId: 17, versionCode: 1791383868, versionName: '6.10.1',
      filename: 'x.apk', fileSize: 150088871, source: 'device', downloadedAt: new Date('2026-10-09T22:16:21Z'),
    }).run();

    const expand = TRIGGER_REGISTRY['apk-analysis/apk-context'];
    const result = await expand({ versionId: 431 }, { db });

    expect(result).toEqual({
      appName: 'Parc Astérix',
      packageName: 'fr.parcasterix.appli.android',
      versionName: '6.10.1',
      versionCode: 1791383868,
      fileSizeBytes: 150088871,
      downloadedAt: '2026-10-09T22:16:21.000Z',
      source: 'device',
    });
  });

  it('throws on missing versionId rather than producing a half-populated context', async () => {
    const db = makeDb();
    const expand = TRIGGER_REGISTRY['apk-analysis/apk-context'];
    await expect(expand({}, { db })).rejects.toThrow(/versionId/);
  });

  it('throws when versionId does not resolve to a real apk_versions row', async () => {
    const db = makeDb();
    const expand = TRIGGER_REGISTRY['apk-analysis/apk-context'];
    await expect(expand({ versionId: 999 }, { db })).rejects.toThrow(/999/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/trigger.test.ts`
Expected: FAIL — module `./trigger` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/nodes/trigger.ts
import { eq } from 'drizzle-orm';
import { apkVersions, trackedApps } from '../../../db/schema';
import type { AppDatabase } from '../../../db/index';

export interface TriggerCtx {
  db: AppDatabase;
}

export type TriggerExpander = (rawInput: Record<string, unknown>, ctx: TriggerCtx) => Promise<Record<string, unknown>>;

export const TRIGGER_REGISTRY: Record<string, TriggerExpander> = {};

export function registerTrigger(name: string, fn: TriggerExpander): void {
  TRIGGER_REGISTRY[name] = fn;
}

registerTrigger('apk-analysis/apk-context', async (rawInput, ctx) => {
  const versionId = rawInput.versionId;
  if (typeof versionId !== 'number') {
    throw new Error(`apk-analysis/apk-context Trigger requires a numeric "versionId" in its input, got ${JSON.stringify(rawInput)}`);
  }
  const row = ctx.db
    .select({
      appName: trackedApps.appName,
      packageName: trackedApps.packageName,
      versionName: apkVersions.versionName,
      versionCode: apkVersions.versionCode,
      fileSizeBytes: apkVersions.fileSize,
      downloadedAt: apkVersions.downloadedAt,
      source: apkVersions.source,
    })
    .from(apkVersions)
    .innerJoin(trackedApps, eq(apkVersions.trackedAppId, trackedApps.id))
    .where(eq(apkVersions.id, versionId))
    .all()[0];

  if (!row) throw new Error(`apk-analysis/apk-context Trigger: no apk_versions row for versionId ${versionId}`);

  return {
    appName: row.appName,
    packageName: row.packageName,
    versionName: row.versionName,
    versionCode: row.versionCode,
    fileSizeBytes: row.fileSizeBytes,
    downloadedAt: row.downloadedAt instanceof Date ? row.downloadedAt.toISOString() : row.downloadedAt,
    source: row.source,
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/trigger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/trigger.ts backend/services/ai-jobs/nodes/trigger.test.ts
git commit -m "feat(ai-jobs): add Trigger node kind + apk-analysis ApkContext expander"
```

### Task 5: Give `handleMessage` a real tool allowlist (new surface on `ai-agent.ts`, per the spec's own "not reuse" callout)

`HandleMessageParams` has no field for restricting tools today — `pageContext` resolves to every tool registered for that context via the tool registry, with no subset filtering. This task adds the filter; it's the one piece of this plan that touches `ai-agent.ts` itself rather than only adding files under `ai-jobs/`.

**Files:**
- Modify: `backend/services/ai-agent.ts` — find the exact call site first with `grep -n "getToolDefinitionsForUser\|getToolsForContext" backend/services/ai-agent.ts` (the spec's review pass cited `ai-tools.ts:131/143` for the registry side; the call site inside `ai-agent.ts` itself wasn't pinned to a line number anywhere in this plan's research — confirm it fresh, the file is large and under active development elsewhere).
- Test: `backend/services/ai-agent.test.ts` (existing file — add to it, don't replace)

**Interfaces:**
- Produces: `HandleMessageParams.toolAllowlist?: string[]` — when present, the resolved tool list for that call is `allTools.filter(t => toolAllowlist.includes(t.name))` instead of the full context list. Absent `toolAllowlist` keeps today's behavior byte-for-byte (every existing non-pipeline caller passes no `toolAllowlist` and must see zero change).

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/services/ai-agent.test.ts — adapt the mock-provider setup to match
// whatever harness the surrounding describe blocks in this file already use (it has one;
// do not build a second one — the live, working harness is describe('tiered execution — parseMissAttempt
// escalation', ...) (it exercises handleMessageWithIdentity against a real AiToolRegistry + mock-provider
// pattern); describe('tiered execution', ...) alone is describe.skip'd dead code — plan review caught that
// the earlier draft of this note pointed at the skipped block, re-verify the line number at execution time
// for the existing pattern and reuse its mock AI provider / toolRegistry fixtures).
describe('toolAllowlist', () => {
  it('restricts the resolved tool list to just the allowlisted names', async () => {
    // Arrange a toolRegistry with at least 3 tools registered for a test pageContext,
    // and a mock provider whose createStreamingRequest captures the `tools` argument
    // it was called with.
    const capturedTools: string[][] = [];
    // ...wire captureTools into the existing mock provider fixture's createStreamingRequest...

    await agent.handleMessage({
      conversationId: null,
      message: 'test',
      pageContext: 'apk-analysis',
      contextId: '1',
      mode: 'silent',
      maxTurns: 5,
      toolAllowlist: ['get_apk_overview', 'get_apk_strings'],
      onToken: () => {},
    });

    expect(capturedTools[0].sort()).toEqual(['get_apk_overview', 'get_apk_strings']);
  });

  it('keeps full-context behavior when toolAllowlist is omitted', async () => {
    const capturedTools: string[][] = [];
    // ...same capture wiring...
    await agent.handleMessage({
      conversationId: null, message: 'test', pageContext: 'apk-analysis',
      contextId: '1', mode: 'silent', maxTurns: 5, onToken: () => {},
    });
    expect(capturedTools[0].length).toBeGreaterThan(2); // the full apk-analysis tool set, unfiltered
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-agent.test.ts -t toolAllowlist`
Expected: FAIL — `toolAllowlist` is not a recognized property / the filter never happens, so the first test's captured tool list is the full unfiltered set.

- [ ] **Step 3: Add the field and the filter**

Add to `HandleMessageParams` (wherever it's declared in `ai-agent.ts`):

```ts
export interface HandleMessageParams {
  // ...existing fields, unchanged...
  /**
   * Restrict the resolved tool list to exactly these names. Added for AgentCall pipeline
   * nodes — never widens the context's tool set, only narrows it. Omitted: today's
   * behavior (every tool registered for pageContext), unchanged.
   */
  toolAllowlist?: string[];
}
```

At the real tool-resolution call site found in Step 1's grep, change:

```ts
const tools = toolRegistry.getToolDefinitionsForUser(pageContext, userScopes, unattended);
```

to:

```ts
let tools = toolRegistry.getToolDefinitionsForUser(pageContext, userScopes, unattended);
if (params.toolAllowlist) {
  const allowed = new Set(params.toolAllowlist);
  tools = tools.filter(t => allowed.has(t.name));
}
```

(Match the actual local variable names at the real call site — `tools`/`params` here are illustrative of the shape, not guaranteed identifiers; adapt to what's actually there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-agent.test.ts -t toolAllowlist`
Expected: PASS

- [ ] **Step 5: Run the full ai-agent test suite to confirm no regression**

Run: `npx vitest run backend/services/ai-agent.test.ts`
Expected: PASS — every pre-existing test, unchanged, since no caller passes `toolAllowlist` yet.

- [ ] **Step 6: Commit**

```bash
git add backend/services/ai-agent.ts backend/services/ai-agent.test.ts
git commit -m "feat(ai): add an optional toolAllowlist to handleMessage, narrows only"
```

### Task 6: AgentCall node

**Files:**
- Create: `backend/services/ai-jobs/nodes/agent-call.ts`
- Test: `backend/services/ai-jobs/nodes/agent-call.test.ts`

**Interfaces:**
- Consumes: `resolveTemplate` (Task 3), `HandleMessageParams.toolAllowlist` (Task 5), `AgentCallConfig` (Task 2).
- Produces: `runAgentCall(config: AgentCallConfig, input: Record<string, unknown>, ctx: AgentCallCtx): Promise<Record<string, unknown>>` where `AgentCallCtx = { agent: BoundAgent; contextId: string }`. Throws on template-resolution failure or on `handleMessage` returning `result.error`/`result.aborted`. The executor (Task 13) is responsible for creating the right `BoundAgent` (core-service vs. user identity, bound to `config.tier`) and catching this throw to mark the node `failed` — this function itself does not catch, it's the executor's job per the envelope-vs-plain-throw split already established for every other node kind.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/agent-call.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runAgentCall } from './agent-call';
import type { AgentCallConfig } from '../types';

function makeFakeAgent(handleMessageImpl: (p: any) => Promise<any>) {
  return { identity: { identityType: 'core-service' as const }, handleMessage: vi.fn(handleMessageImpl) };
}

describe('runAgentCall', () => {
  const config: AgentCallConfig = {
    tier: 'High',
    instructionTemplate: 'Analyze {{trigger.appName}} v{{trigger.versionName}}.',
    toolAllowlist: ['get_apk_overview'],
  };

  it('resolves the template against input and sends it as the message', async () => {
    const agent = makeFakeAgent(async () => ({ run: { requests: [] } }));
    await runAgentCall(config, { trigger: { appName: 'Parc Astérix', versionName: '6.10.1' } }, { agent: agent as any, contextId: '431' });

    expect(agent.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Analyze Parc Astérix v6.10.1.',
      toolAllowlist: ['get_apk_overview'],
      contextId: '431',
      mode: 'silent',
    }));
  });

  it('throws when the template cannot resolve, before ever calling handleMessage', async () => {
    const agent = makeFakeAgent(async () => ({ run: { requests: [] } }));
    await expect(
      runAgentCall({ ...config, instructionTemplate: '{{trigger.missingField}}' }, { trigger: { appName: 'x' } }, { agent: agent as any, contextId: '431' }),
    ).rejects.toThrow(/missingField/);
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('throws when handleMessage reports an error', async () => {
    const agent = makeFakeAgent(async () => ({ error: 'ModelRefusedError: cyber', run: { requests: [] } }));
    await expect(
      runAgentCall(config, { trigger: { appName: 'x', versionName: '1' } }, { agent: agent as any, contextId: '431' }),
    ).rejects.toThrow(/ModelRefusedError/);
  });

  it('accumulates streamed onToken chunks into the returned text — HandleMessageResult has no text field to read instead', async () => {
    const agent = makeFakeAgent(async (p: any) => {
      p.onToken('Summary: ');
      p.onToken('a React Native app.');
      return { run: { requests: [] } };
    });
    const result = await runAgentCall(config, { trigger: { appName: 'x', versionName: '1' } }, { agent: agent as any, contextId: '431' });
    expect(result).toEqual({ text: 'Summary: a React Native app.' });
  });

  it('supplies onToolStart and onToolResult — both are non-optional on HandleMessageParams', async () => {
    const agent = makeFakeAgent(async (p: any) => {
      expect(typeof p.onToolStart).toBe('function');
      expect(typeof p.onToolResult).toBe('function');
      p.onToolStart('id1', 'get_apk_overview', {}, 1, 49); // must not throw
      p.onToolResult('id1', 'get_apk_overview', '{}', 10); // must not throw
      return { run: { requests: [] } };
    });
    await runAgentCall(config, { trigger: { appName: 'x', versionName: '1' } }, { agent: agent as any, contextId: '431' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/agent-call.test.ts`
Expected: FAIL — module `./agent-call` does not exist.

- [ ] **Step 3: Write the implementation**

`HandleMessageResult` (`ai-agent.ts:96-106`, confirmed by plan review — grepped the whole repo, there is no `finalText` field anywhere in the codebase) has only `conversationId`, `usage`, `error`, `turnLimitReached`, `aborted`, `run`. No field carries the model's text. The only path the text ever reaches a caller is the streamed `onToken` callback — `runAgentCall` accumulates it itself rather than reading a result field that doesn't exist, which is what the first draft of this task did and would have silently returned an empty string from every real run.

```ts
// backend/services/ai-jobs/nodes/agent-call.ts
import { resolveTemplate } from '../template';
import type { AgentCallConfig } from '../types';
import type { BoundAgent } from '../../ai-agent-factory';

export interface AgentCallCtx {
  agent: BoundAgent;
  contextId: string;
}

const AI_ANALYSIS_MAX_TURNS = 50; // match apk-analyzer.ts's existing constant; import it instead of duplicating if it's exported

export async function runAgentCall(
  config: AgentCallConfig,
  input: Record<string, unknown>,
  ctx: AgentCallCtx,
): Promise<Record<string, unknown>> {
  const message = resolveTemplate(config.instructionTemplate, input); // throws TemplateResolutionError, left uncaught on purpose

  // HandleMessageResult has no text field — confirmed against ai-agent.ts:96-106 (only
  // conversationId/usage/error/turnLimitReached/aborted/run). The model's text only ever
  // reaches a caller through the streamed onToken callback; accumulate it here rather than
  // reading a field that doesn't exist (the first draft of this task did exactly that and
  // would have returned an empty string from every real run — caught in plan review).
  let text = '';
  const result = await ctx.agent.handleMessage({
    conversationId: null,
    message,
    pageContext: 'apk-analysis',
    contextId: ctx.contextId,
    mode: 'silent',
    maxTurns: AI_ANALYSIS_MAX_TURNS,
    toolAllowlist: config.toolAllowlist,
    onToken: (chunk) => { text += chunk; },
    // Non-optional on HandleMessageParams (ai-agent.ts:37-66) — every real caller supplies
    // them (apk-analyzer.ts:925-934); omitting them fails to compile and would throw at
    // runtime on the first tool use.
    onToolStart: () => {},
    onToolResult: () => {},
  });

  if (result.error) throw new Error(result.error);
  if (result.aborted) throw new Error('AgentCall aborted');

  return { text };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/agent-call.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/agent-call.ts backend/services/ai-jobs/nodes/agent-call.test.ts
git commit -m "feat(ai-jobs): add AgentCall node — scoped, read-only, single-tier"
```

### Task 7: Transform node

**Files:**
- Create: `backend/services/ai-jobs/nodes/transform.ts`
- Test: `backend/services/ai-jobs/nodes/transform.test.ts`

**Interfaces:**
- Produces: `TRANSFORM_REGISTRY: Record<string, TransformFn>` where `type TransformFn = (input: Record<string, unknown>) => Record<string, unknown>`; `registerTransform(name, fn)`; `runTransform(config: TransformConfig, input): Record<string, unknown>` — looks up `config.fn` in the registry, throws `Unknown transform "<name>"` if absent, otherwise calls it synchronously (no node in this plan's Astérix pipeline needs an async Transform, and the spec never requires one — keep it synchronous, simplest thing that's true).

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/transform.test.ts
import { describe, it, expect } from 'vitest';
import { registerTransform, runTransform } from './transform';

describe('runTransform', () => {
  registerTransform('test/double', (input) => ({ n: (input.n as number) * 2 }));

  it('runs the registered function by name', () => {
    expect(runTransform({ fn: 'test/double' }, { n: 5 })).toEqual({ n: 10 });
  });

  it('throws on an unregistered function name', () => {
    expect(() => runTransform({ fn: 'test/nope' }, {})).toThrow(/Unknown transform "test\/nope"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/transform.test.ts`
Expected: FAIL — module `./transform` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/nodes/transform.ts
import type { TransformConfig } from '../types';

export type TransformFn = (input: Record<string, unknown>) => Record<string, unknown>;

export const TRANSFORM_REGISTRY: Record<string, TransformFn> = {};

export function registerTransform(name: string, fn: TransformFn): void {
  TRANSFORM_REGISTRY[name] = fn;
}

export function runTransform(config: TransformConfig, input: Record<string, unknown>): Record<string, unknown> {
  const fn = TRANSFORM_REGISTRY[config.fn];
  if (!fn) throw new Error(`Unknown transform "${config.fn}"`);
  return fn(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/transform.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/transform.ts backend/services/ai-jobs/nodes/transform.test.ts
git commit -m "feat(ai-jobs): add Transform node — named registered deterministic functions"
```

### Task 8: Branch node (envelope node #1)

**Files:**
- Create: `backend/services/ai-jobs/nodes/branch.ts`
- Test: `backend/services/ai-jobs/nodes/branch.test.ts`

**Interfaces:**
- Consumes: `Envelope<T>` (Task 2).
- Produces: `BRANCH_REGISTRY: Record<string, BranchPredicate>` where `type BranchPredicate = (envelope: Envelope) => string` (returns the chosen edge label — must be one of `config.edges`); `registerBranchPredicate(name, fn)`; `runBranch(config: BranchConfig, envelope: Envelope): string`. The executor (Task 14) is what actually exempts `Branch` from skip propagation and builds the envelope — this function is the pure decision given one already-built envelope.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/branch.test.ts
import { describe, it, expect } from 'vitest';
import { registerBranchPredicate, runBranch } from './branch';
import type { Envelope } from '../types';

describe('runBranch', () => {
  registerBranchPredicate('test/ok-or-fallback', (e: Envelope) => (e.status === 'ok' ? 'primary' : 'fallback'));

  it('routes to the edge the predicate returns for an ok envelope', () => {
    const edge = runBranch({ predicate: 'test/ok-or-fallback', edges: ['primary', 'fallback'] }, { status: 'ok', output: {} });
    expect(edge).toBe('primary');
  });

  it('routes to the edge the predicate returns for a failed envelope', () => {
    const edge = runBranch({ predicate: 'test/ok-or-fallback', edges: ['primary', 'fallback'] }, { status: 'failed', error: 'boom' });
    expect(edge).toBe('fallback');
  });

  it('throws if the predicate returns an edge not declared in config.edges', () => {
    registerBranchPredicate('test/bogus', () => 'not-declared');
    expect(() => runBranch({ predicate: 'test/bogus', edges: ['primary', 'fallback'] }, { status: 'ok', output: {} }))
      .toThrow(/not-declared/);
  });

  it('throws on an unregistered predicate name', () => {
    expect(() => runBranch({ predicate: 'test/nope', edges: ['a'] }, { status: 'ok', output: {} })).toThrow(/Unknown branch predicate/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/branch.test.ts`
Expected: FAIL — module `./branch` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/nodes/branch.ts
import type { BranchConfig, Envelope } from '../types';

export type BranchPredicate = (envelope: Envelope) => string;

export const BRANCH_REGISTRY: Record<string, BranchPredicate> = {};

export function registerBranchPredicate(name: string, fn: BranchPredicate): void {
  BRANCH_REGISTRY[name] = fn;
}

export function runBranch(config: BranchConfig, envelope: Envelope): string {
  const predicate = BRANCH_REGISTRY[config.predicate];
  if (!predicate) throw new Error(`Unknown branch predicate "${config.predicate}"`);
  const edge = predicate(envelope);
  if (!config.edges.includes(edge)) {
    throw new Error(`Branch predicate "${config.predicate}" returned edge "${edge}", not declared in config.edges (${config.edges.join(', ')})`);
  }
  return edge;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/branch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/branch.ts backend/services/ai-jobs/nodes/branch.test.ts
git commit -m "feat(ai-jobs): add Branch node — envelope-based, exempt from skip rule"
```

### Task 9: Report node (envelope node #2) + the `apk-analysis` assembler

**Files:**
- Create: `backend/services/ai-jobs/nodes/report.ts`
- Test: `backend/services/ai-jobs/nodes/report.test.ts`

**Interfaces:**
- Consumes: `Envelope<T>`, `ReportConfig`, `ReportSection` (Task 2).
- Produces: `runReport(config: ReportConfig, envelopes: Record<string, Envelope<{ text: string }>>): { markdown: string }` — pure, synchronous, never throws for a `failed`/`skipped`/`inactive` envelope (that's the entire point — see Review Focus). Registered per job kind via `REPORT_ASSEMBLERS` the same shape as the other registries, so a future job can supply its own section-to-markdown formatting without touching this file; `apk-analysis`'s formatting (plain `## <title>\n<content>` blocks) is registered here as the default and is what the Astérix pipeline (Task 20) uses.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/report.test.ts
import { describe, it, expect } from 'vitest';
import { runReport } from './report';
import type { Envelope, ReportConfig } from '../types';

describe('runReport', () => {
  const config: ReportConfig = {
    sections: [
      { title: 'Overview', from: 'agent-overview' },
      { title: 'Wait Times', from: 'agent-wait-times' },
      { title: 'Bypass Script', from: 'agent-bypass' },
    ],
  };

  it('assembles every ok section in declared order', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'A React Native app.' } },
      'agent-wait-times': { status: 'ok', output: { text: 'No wait-time endpoints found.' } },
      'agent-bypass': { status: 'ok', output: { text: 'Frida script here.' } },
    };
    const result = runReport(config, envelopes);
    const overviewIdx = result.markdown.indexOf('## Overview');
    const waitIdx = result.markdown.indexOf('## Wait Times');
    const bypassIdx = result.markdown.indexOf('## Bypass Script');
    expect(overviewIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThan(overviewIdx);
    expect(bypassIdx).toBeGreaterThan(waitIdx);
    expect(result.markdown).toContain('A React Native app.');
  });

  it('substitutes an explicit placeholder for a failed section, never throws, never silently omits it', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'A React Native app.' } },
      'agent-wait-times': { status: 'ok', output: { text: 'No wait-time endpoints found.' } },
      'agent-bypass': { status: 'failed', error: 'ModelRefusedError: cyber' },
    };
    const result = runReport(config, envelopes);
    expect(result.markdown).toContain('## Bypass Script');
    expect(result.markdown).toContain('unavailable this run');
    expect(result.markdown).not.toContain('ModelRefusedError'); // the placeholder is honest, not a raw error dump into the doc
  });

  it('substitutes the same placeholder for a skipped or inactive section', () => {
    const envelopes: Record<string, Envelope<{ text: string }>> = {
      'agent-overview': { status: 'ok', output: { text: 'x' } },
      'agent-wait-times': { status: 'skipped' },
      'agent-bypass': { status: 'inactive' },
    };
    const result = runReport(config, envelopes);
    expect(result.markdown).toContain('## Wait Times');
    expect(result.markdown).toContain('## Bypass Script');
    expect((result.markdown.match(/unavailable this run/g) || []).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/report.test.ts`
Expected: FAIL — module `./report` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/nodes/report.ts
import type { Envelope, ReportConfig } from '../types';

export function runReport(
  config: ReportConfig,
  envelopes: Record<string, Envelope<{ text: string }>>,
): { markdown: string } {
  const blocks = config.sections.map((section) => {
    const envelope = envelopes[section.from];
    // Also check typeof envelope.output.text === 'string' alongside envelope.status === 'ok' —
    // found during Task 15's review, four rounds later: a Report section sourced directly from a
    // Branch node gets an 'ok' envelope whose output is {chosenEdge: '...'}, with no text field at
    // all. Without this guard, .trimEnd() throws on undefined, crashing the WHOLE report assembly
    // and taking every OTHER section's real content down with it — the exact opposite of what
    // this node exists to do, and a direct violation of this function's own "never throws"
    // contract stated in the doc comment above. Fixed as its own small, standalone follow-up
    // (backend/services/ai-jobs/nodes/report.ts), not by reopening this task.
    const body = envelope && envelope.status === 'ok' && typeof envelope.output.text === 'string'
      ? envelope.output.text.trimEnd()
      : `— ${section.title} unavailable this run. Its source node did not complete.`;
    return `## ${section.title}\n${body}`;
  });
  return { markdown: blocks.join('\n\n') + '\n' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/report.ts backend/services/ai-jobs/nodes/report.test.ts
git commit -m "feat(ai-jobs): add Report node — ordered, fault-tolerant document assembly"
```

### Task 10: ForEach node

**Files:**
- Create: `backend/services/ai-jobs/nodes/foreach.ts`
- Test: `backend/services/ai-jobs/nodes/foreach.test.ts`

**Interfaces:**
- Produces: `FOREACH_REGISTRY: Record<string, ForEachItemFn>` where `type ForEachItemFn = (item: unknown) => Promise<unknown>`; `registerForEachItemFn(name, fn)`; `runForEach(config: ForEachConfig, items: unknown[]): Promise<Array<{ status: 'ok'; output: unknown } | { status: 'failed'; error: string }>>` — per-item failure is data in the returned array, never thrown; the node's own promise only rejects if `items` itself isn't an array.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/foreach.test.ts
import { describe, it, expect } from 'vitest';
import { registerForEachItemFn, runForEach } from './foreach';

describe('runForEach', () => {
  registerForEachItemFn('test/maybe-fail', async (item) => {
    if ((item as number) % 3 === 0) throw new Error(`item ${item} is divisible by 3`);
    return (item as number) * 10;
  });

  it('collects all 10 results, ok and failed, never throws for a per-item failure', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10, two multiples of 3
    const results = await runForEach({ itemFn: 'test/maybe-fail' }, items);

    expect(results).toHaveLength(10);
    const failed = results.filter(r => r.status === 'failed');
    const ok = results.filter(r => r.status === 'ok');
    expect(failed).toHaveLength(2); // 3, 6, 9 are divisible... wait: 3,6,9 = 3 items
    expect(ok).toHaveLength(7);
  });

  it('rejects outright when the input list is malformed, not per-item', async () => {
    await expect(runForEach({ itemFn: 'test/maybe-fail' }, 'not an array' as any)).rejects.toThrow(/array/);
  });

  it('throws on an unregistered item function name before touching any item', async () => {
    await expect(runForEach({ itemFn: 'test/nope' }, [1, 2])).rejects.toThrow(/Unknown ForEach item function/);
  });
});
```

Fix the arithmetic before running: 1..10 divisible by 3 are 3, 6, 9 — three items, not two. Correct the test's `expect(failed).toHaveLength(2)` to `toHaveLength(3)` and `expect(ok).toHaveLength(7)` stays 7 (10 − 3).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/foreach.test.ts`
Expected: FAIL — module `./foreach` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/nodes/foreach.ts
import type { ForEachConfig } from '../types';

export type ForEachItemFn = (item: unknown) => Promise<unknown>;
export type ForEachItemResult = { status: 'ok'; output: unknown } | { status: 'failed'; error: string };

export const FOREACH_REGISTRY: Record<string, ForEachItemFn> = {};

export function registerForEachItemFn(name: string, fn: ForEachItemFn): void {
  FOREACH_REGISTRY[name] = fn;
}

export async function runForEach(config: ForEachConfig, items: unknown[]): Promise<ForEachItemResult[]> {
  if (!Array.isArray(items)) throw new Error('runForEach: items must be an array');
  const fn = FOREACH_REGISTRY[config.itemFn];
  if (!fn) throw new Error(`Unknown ForEach item function "${config.itemFn}"`);

  const settled = await Promise.allSettled(items.map(fn));
  return settled.map((s): ForEachItemResult =>
    s.status === 'fulfilled' ? { status: 'ok', output: s.value } : { status: 'failed', error: String(s.reason) },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/foreach.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/foreach.ts backend/services/ai-jobs/nodes/foreach.test.ts
git commit -m "feat(ai-jobs): add ForEach node — per-item failure is data, not node status"
```

### Task 11: Sink node + the two `apk-analysis` write functions

**Files:**
- Create: `backend/services/ai-jobs/nodes/sink.ts`
- Test: `backend/services/ai-jobs/nodes/sink.test.ts`

**Interfaces:**
- Consumes: `getNote`/`setNote`/`patchNoteSection` from `backend/services/apk-notes.ts` (existing, unmodified).
- Produces: `SINK_REGISTRY: Record<string, SinkWriteFn>` where `type SinkWriteFn = (config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx) => Promise<void>` (the `config` param is required — see the SDD pre-flight fix below and in Task 2: the executor wraps every node's input by source-node-id even for one incoming edge, so a write function needs `config.from`/`config.section` to know which key to unwrap, not just the raw `input`), `SinkCtx = { db: AppDatabase; versionId: number }`; `registerSink(name, fn)`; `runSink(config: SinkConfig, input, ctx): Promise<void>` — either completes or throws (Review Focus: a missing `apk_versions` row must surface as an ordinary thrown error here, which the executor then turns into a `failed` node-run, not an unhandled rejection). Registers `'apk-analysis/write-section'` (wraps `patchNoteSection`, used by Quick Rescan's single-section `Sink`) and `'apk-analysis/write-full-document'` (wraps `setNote`, used by the `Report`-fed `Sink`).

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/nodes/sink.test.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../db/schema';
import { runSink } from './sink';
import { getNote } from '../../apk-notes';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE tracked_apps (id INTEGER PRIMARY KEY, package_name TEXT NOT NULL, app_name TEXT, auto_analyse INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE apk_versions (id INTEGER PRIMARY KEY, tracked_app_id INTEGER NOT NULL, version_code INTEGER NOT NULL, version_name TEXT, filename TEXT NOT NULL, file_size INTEGER, device_id TEXT, source TEXT DEFAULT 'device', downloaded_at INTEGER NOT NULL);
    CREATE TABLE apk_notes (version_id INTEGER PRIMARY KEY REFERENCES apk_versions(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
  `);
  const db = drizzle(sqlite, { schema });
  db.insert(schema.trackedApps).values({ id: 1, packageName: 'x', createdAt: new Date() }).run();
  db.insert(schema.apkVersions).values({ id: 431, trackedAppId: 1, versionCode: 1, filename: 'x.apk', downloadedAt: new Date() }).run();
  return db;
}

// Every node's input is wrapped by source-node-id, even with exactly one incoming edge —
// Tasks 13-17 establish this for the whole executor (e.g. the linear-chain test's
// `{ trigger: { appName: 'x', versionId: 431 } }`). The plan's first draft of this task had
// write-full-document/write-section read `input.markdown`/`input.section` directly, which
// would read `undefined` through the real executor and write the literal string "undefined"
// into the note on every run — caught in the SDD pre-flight scan before this task was
// dispatched. config.from names which predecessor's output to unwrap first, same convention
// as Report's sections[].from; these tests use the real wrapped shape throughout.
describe('runSink', () => {
  it('apk-analysis/write-full-document writes the whole assembled document in one call', async () => {
    const db = makeDb();
    await runSink(
      { writeFn: 'apk-analysis/write-full-document', from: 'report' },
      { report: { markdown: '## Overview\nHello.\n' } },
      { db, versionId: 431 },
    );
    expect(getNote(db, 431)).toBe('## Overview\nHello.\n');
  });

  it('apk-analysis/write-section patches just one section, leaving others untouched', async () => {
    const db = makeDb();
    await runSink(
      { writeFn: 'apk-analysis/write-full-document', from: 'report' },
      { report: { markdown: '## Overview\nOld.\n\n## Diff Summary\nOld diff.\n' } },
      { db, versionId: 431 },
    );
    await runSink(
      { writeFn: 'apk-analysis/write-section', from: 'agent-diff', section: 'Diff Summary' },
      { 'agent-diff': { text: 'New diff.' } },
      { db, versionId: 431 },
    );
    const note = getNote(db, 431);
    expect(note).toContain('## Overview\nOld.');
    expect(note).toContain('## Diff Summary\nNew diff.');
  });

  it('throws (not an unhandled rejection) when the target version does not exist', async () => {
    const db = makeDb();
    await expect(
      runSink({ writeFn: 'apk-analysis/write-full-document', from: 'report' }, { report: { markdown: 'x' } }, { db, versionId: 999999 }),
    ).rejects.toThrow();
  });

  it('throws on an unregistered writeFn name', async () => {
    const db = makeDb();
    await expect(runSink({ writeFn: 'nope' }, {}, { db, versionId: 431 })).rejects.toThrow(/Unknown sink/);
  });

  it('write-full-document writes an empty string when "from" is omitted or its source produced nothing, never the literal text "undefined"', async () => {
    const db = makeDb();
    await runSink({ writeFn: 'apk-analysis/write-full-document' }, {}, { db, versionId: 431 });
    expect(getNote(db, 431)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/nodes/sink.test.ts`
Expected: FAIL — module `./sink` does not exist.

- [ ] **Step 3: Write the implementation**

The "version no longer exists" case: `setNote`/`patchNoteSection` both call `getNote` first (a plain `select`, returns `''` for a missing row — it does not throw) and then `insert`/`update` against `apk_notes.version_id` with a `REFERENCES apk_versions(id) ON DELETE CASCADE` foreign key. With `foreign_keys = ON` (the project default), an insert against a non-existent `apk_versions.id` throws a `FOREIGN KEY constraint failed` from better-sqlite3 — that's what Step 1's third test actually exercises; no extra existence check is needed in this file, just don't swallow what SQLite already throws.

```ts
// backend/services/ai-jobs/nodes/sink.ts
import type { SinkConfig } from '../types';
import type { AppDatabase } from '../../../db/index';
import { patchNoteSection, setNote } from '../../apk-notes';

export interface SinkCtx {
  db: AppDatabase;
  versionId: number;
}

// Every node's input is wrapped by source-node-id, even with exactly one incoming edge (see
// Tasks 13-17). A write function reading a field straight off `input` would read `undefined`
// through the real executor, not whatever a unit test calling runSink directly handed it —
// the config param lets a write function unwrap the right predecessor via config.from, the
// same convention Report's sections[].from uses.
export type SinkWriteFn = (config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx) => Promise<void>;

export const SINK_REGISTRY: Record<string, SinkWriteFn> = {};

export function registerSink(name: string, fn: SinkWriteFn): void {
  SINK_REGISTRY[name] = fn;
}

export async function runSink(config: SinkConfig, input: Record<string, unknown>, ctx: SinkCtx): Promise<void> {
  const fn = SINK_REGISTRY[config.writeFn];
  if (!fn) throw new Error(`Unknown sink "${config.writeFn}"`);
  await fn(config, input, ctx);
}

registerSink('apk-analysis/write-full-document', async (config, input, ctx) => {
  const source = config.from ? (input[config.from] as { markdown?: string } | undefined) : undefined;
  setNote(ctx.db, ctx.versionId, source?.markdown ?? '');
});

registerSink('apk-analysis/write-section', async (config, input, ctx) => {
  const source = config.from ? (input[config.from] as { text?: string } | undefined) : undefined;
  patchNoteSection(ctx.db, ctx.versionId, config.section ?? 'Untitled', source?.text ?? '');
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/nodes/sink.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/nodes/sink.ts backend/services/ai-jobs/nodes/sink.test.ts
git commit -m "feat(ai-jobs): add Sink node + apk-analysis write-section/write-full-document"
```

---

## Phase C: Graph validation + executor

### Task 12: Graph validator

**Files:**
- Create: `backend/services/ai-jobs/graph-validator.ts`
- Test: `backend/services/ai-jobs/graph-validator.test.ts`

**Interfaces:**
- Consumes: `PipelineGraph`, `PipelineNode`, `TriggerConfig` (Task 2).
- Produces: `validateGraph(graph: PipelineGraph): ValidationError[]` (empty array = valid) and `ValidationError = { nodeId?: string; message: string }`. Called at publish time (Task 18's REST endpoint) — a graph that fails validation is never saved as a `published` version.

Rules enforced (from the spec's Node primitives + Non-goals):
1. At least one `Trigger` node exists.
2. Every `Trigger` node declares the same `outputSchema` (compared by field name + type, order-independent).
3. Every non-`Trigger` node is reachable (forward, via edges) from exactly one `Trigger`. Zero reachable `Trigger`s or more than one is an error, named per offending node.
4. A `Branch` or `Report` node (envelope nodes) must have every one of its `from`/incoming-edge sources as a **direct** predecessor — this is already structurally guaranteed by "edges are direct connections," so this rule reduces to: a `Report`'s declared `sections[].from` must each correspond to an actual incoming edge into that `Report`, not a node two hops away. Validate that explicitly since `ReportConfig.sections` is authored data that could drift from the graph's real edges.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/graph-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateGraph } from './graph-validator';
import type { PipelineGraph } from './types';

const triggerSchema = [{ field: 'appName', type: 'string', description: 'x' }];

function node(id: string, config: PipelineGraph['nodes'][number]['config']) {
  return { id, config };
}

describe('validateGraph', () => {
  it('passes a minimal valid graph: one Trigger, one AgentCall, one Sink', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('trigger', { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('sink', { kind: 'Sink', writeFn: 'apk-analysis/write-section' }),
      ],
      edges: [{ from: 'trigger', to: 'agent' }, { from: 'agent', to: 'sink' }],
    };
    expect(validateGraph(graph)).toEqual([]);
  });

  it('rejects a graph with zero Trigger nodes', () => {
    const graph: PipelineGraph = { nodes: [node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] })], edges: [] };
    const errors = validateGraph(graph);
    expect(errors.some(e => /at least one Trigger/i.test(e.message))).toBe(true);
  });

  it('rejects two Triggers with different output schemas', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('t2', { kind: 'Trigger', expandFn: 'b', outputSchema: [{ field: 'different', type: 'string', description: 'x' }] }),
      ],
      edges: [],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => /same output schema/i.test(e.message))).toBe(true);
  });

  it('rejects a node reachable from two different Triggers', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('t2', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('shared', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      ],
      edges: [{ from: 't1', to: 'shared' }, { from: 't2', to: 'shared' }],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'shared' && /more than one Trigger/i.test(e.message))).toBe(true);
  });

  it('rejects a node reachable from zero Triggers (orphaned)', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('orphan', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      ],
      edges: [],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'orphan' && /not reachable from any Trigger/i.test(e.message))).toBe(true);
  });

  it('rejects a Report section whose "from" is not a direct incoming edge', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('report', { kind: 'Report', sections: [{ title: 'X', from: 'not-a-real-edge-source' }] }),
      ],
      edges: [{ from: 't1', to: 'agent' }, { from: 'agent', to: 'report' }],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'report' && /not-a-real-edge-source/.test(e.message))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/graph-validator.test.ts`
Expected: FAIL — module `./graph-validator` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/services/ai-jobs/graph-validator.ts
import type { PipelineGraph, PipelineNode } from './types';

export interface ValidationError {
  nodeId?: string;
  message: string;
}

function schemasMatch(a: PipelineNode['config'], b: PipelineNode['config']): boolean {
  if (a.kind !== 'Trigger' || b.kind !== 'Trigger') return true;
  const norm = (schema: typeof a.outputSchema) =>
    [...schema].sort((x, y) => x.field.localeCompare(y.field)).map(f => `${f.field}:${f.type}`).join(',');
  return norm(a.outputSchema) === norm(b.outputSchema);
}

export function validateGraph(graph: PipelineGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const triggers = graph.nodes.filter(n => n.config.kind === 'Trigger');

  if (triggers.length === 0) {
    errors.push({ message: 'A pipeline needs at least one Trigger node.' });
    return errors; // nothing else to check meaningfully without a root
  }

  // Found during Task 16's review (live-probed, not a hypothetical): a Trigger is specified as
  // "an independent root (zero incoming edges)," but nothing enforced it — a graph like
  // `t1 -> t2` passed validation with 0 errors, yet broke "exactly one Trigger fires per run" two
  // different ways (firing t1 also ran t2's executor; firing t2 made it see t1 as an inactive
  // parent and marked itself inactive, so nothing ran and the failure had no clear message).
  // Fixed as its own small, standalone follow-up to this file, not by reopening this task.
  for (const e of graph.edges) {
    const target = graph.nodes.find(n => n.id === e.to);
    if (target?.config.kind === 'Trigger') {
      errors.push({ nodeId: target.id, message: `Trigger "${target.id}" has an incoming edge from "${e.from}" — a Trigger must be an independent root with zero incoming edges.` });
    }
  }

  for (let i = 1; i < triggers.length; i++) {
    if (!schemasMatch(triggers[0].config, triggers[i].config)) {
      errors.push({
        nodeId: triggers[i].id,
        message: `Trigger "${triggers[i].id}" does not declare the same output schema as Trigger "${triggers[0].id}" — every Trigger in a pipeline must.`,
      });
    }
  }

  // Reachability: for each trigger, BFS forward over edges, recording which trigger(s) reach each node.
  const reachedBy = new Map<string, Set<string>>();
  for (const trigger of triggers) {
    const seen = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        if (edge.from !== current || seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
    for (const nodeId of seen) {
      if (nodeId === trigger.id) continue;
      if (!reachedBy.has(nodeId)) reachedBy.set(nodeId, new Set());
      reachedBy.get(nodeId)!.add(trigger.id);
    }
  }

  for (const n of graph.nodes) {
    if (n.config.kind === 'Trigger') continue;
    const reachers = reachedBy.get(n.id) ?? new Set();
    if (reachers.size === 0) {
      errors.push({ nodeId: n.id, message: `Node "${n.id}" is not reachable from any Trigger.` });
    } else if (reachers.size > 1) {
      errors.push({ nodeId: n.id, message: `Node "${n.id}" is reachable from more than one Trigger (${[...reachers].join(', ')}) — Triggers must partition the graph into disjoint zones.` });
    }
  }

  for (const n of graph.nodes) {
    if (n.config.kind !== 'Report') continue;
    const incomingSources = new Set(graph.edges.filter(e => e.to === n.id).map(e => e.from));
    for (const section of n.config.sections) {
      if (!incomingSources.has(section.from)) {
        errors.push({ nodeId: n.id, message: `Report "${n.id}" declares section "${section.title}" from "${section.from}", which is not a direct incoming edge into this Report.` });
      }
    }
  }

  // Same "authored data can drift from the graph" check Report gets above, for Branch's
  // declared config.edges against its real outgoing edge labels — plan review caught that this
  // was missing: a Branch with a declared edge that has no matching graph edge, or a graph edge
  // whose label isn't declared, was only ever caught at runtime if a run happened to exercise
  // that exact path, contradicting Review Focus item 3's own "catch this at publish time" goal.
  for (const n of graph.nodes) {
    if (n.config.kind !== 'Branch') continue;
    const outgoingLabels = new Set(
      graph.edges.filter(e => e.from === n.id).map(e => e.label).filter((l): l is string => !!l),
    );
    for (const declaredEdge of n.config.edges) {
      if (!outgoingLabels.has(declaredEdge)) {
        errors.push({ nodeId: n.id, message: `Branch "${n.id}" declares edge "${declaredEdge}" in its config, but no outgoing graph edge carries that label.` });
      }
    }
    for (const label of outgoingLabels) {
      if (!n.config.edges.includes(label)) {
        errors.push({ nodeId: n.id, message: `Branch "${n.id}" has an outgoing edge labeled "${label}" that isn't declared in its config.edges.` });
      }
    }
  }

  // Same drift-detection pattern as Report's sections[].from and Branch's declared edges —
  // a Sink's config.from, when present, must name a real incoming edge's source. Added
  // alongside the SDD pre-flight fix to SinkConfig (Task 2) and sink.ts (Task 11): without
  // this, a typo'd or stale `from` is only ever caught by a live run writing an empty section,
  // not at publish time.
  for (const n of graph.nodes) {
    if (n.config.kind !== 'Sink' || !n.config.from) continue;
    const incomingSources = new Set(graph.edges.filter(e => e.to === n.id).map(e => e.from));
    if (!incomingSources.has(n.config.from)) {
      errors.push({ nodeId: n.id, message: `Sink "${n.id}" declares from: "${n.config.from}", which is not a direct incoming edge into this Sink.` });
    }
  }

  return errors;
}
```

**Add this test** alongside the existing graph-validator tests:

```ts
it('rejects a Branch whose declared edges and real outgoing edge labels have drifted apart', () => {
  const graphMissingEdge: PipelineGraph = {
    nodes: [
      node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
      node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      node('branch', { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] }), // declares 'fallback'...
      node('sink', { kind: 'Sink', writeFn: 'x' }),
    ],
    edges: [
      { from: 't1', to: 'agent' }, { from: 'agent', to: 'branch' },
      { from: 'branch', to: 'sink', label: 'primary' }, // ...but no graph edge actually carries it
    ],
  };
  expect(validateGraph(graphMissingEdge).some(e => e.nodeId === 'branch' && /"fallback"/.test(e.message))).toBe(true);

  const graphExtraEdge: PipelineGraph = {
    nodes: [
      node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
      node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      node('branch', { kind: 'Branch', predicate: 'x', edges: ['primary'] }), // only declares 'primary'...
      node('sink1', { kind: 'Sink', writeFn: 'x' }),
      node('sink2', { kind: 'Sink', writeFn: 'x' }),
    ],
    edges: [
      { from: 't1', to: 'agent' }, { from: 'agent', to: 'branch' },
      { from: 'branch', to: 'sink1', label: 'primary' },
      { from: 'branch', to: 'sink2', label: 'undeclared' }, // ...but a second, undeclared outgoing edge exists
    ],
  };
  expect(validateGraph(graphExtraEdge).some(e => e.nodeId === 'branch' && /"undeclared"/.test(e.message))).toBe(true);
});

it('rejects a Sink whose declared "from" is not a direct incoming edge source', () => {
  const graph: PipelineGraph = {
    nodes: [
      node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
      node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      node('sink', { kind: 'Sink', writeFn: 'x', from: 'not-a-real-edge-source' }),
    ],
    edges: [{ from: 't1', to: 'agent' }, { from: 'agent', to: 'sink' }],
  };
  const errors = validateGraph(graph);
  expect(errors.some(e => e.nodeId === 'sink' && /not-a-real-edge-source/.test(e.message))).toBe(true);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/graph-validator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/graph-validator.ts backend/services/ai-jobs/graph-validator.test.ts
git commit -m "feat(ai-jobs): add graph validator — trigger-zone partition + schema + Report sections"
```

### Task 13: Executor — core data shapes + a linear chain, no skip/envelope/multi-trigger/memoization yet

This task and the four after it build `pipeline-runner.ts` incrementally — each adds one real behavior and every earlier task's tests must still pass unmodified at the end of every later task. The executor is deliberately decoupled from the concrete node implementations: it calls into an injected `NodeExecutors` map, so this file never imports `nodes/*.ts` directly, and the Astérix-specific wiring (Task 20) is the only place that connects the two.

**Files:**
- Create: `backend/services/ai-jobs/pipeline-runner.ts`
- Test: `backend/services/ai-jobs/pipeline-runner.test.ts`

**Interfaces:**
- Consumes: `PipelineGraph`, `NodeRunStatus`, `RunStatus`, `Envelope` (Task 2).
- Produces: `runPipeline(graph, triggerNodeId, rawInput, executors, ctx): Promise<RunResult>`, `NodeExecutors` (one function per `NodeKind`), `ExecutionCtx = Record<string, unknown>` (opaque bag the executor passes through unchanged — job-specific wiring lives in whatever's inside it, never in the executor). `RunResult = { status: RunStatus; nodes: NodeRunResult[] }`, `NodeRunResult = { nodeId: string; status: NodeRunStatus; output?: Record<string, unknown>; error?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/services/ai-jobs/pipeline-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from './pipeline-runner';
import type { PipelineGraph, NodeExecutors } from './pipeline-runner';

function fakeExecutors(overrides: Partial<NodeExecutors> = {}): NodeExecutors {
  return {
    Trigger: vi.fn(async (_c, rawInput) => ({ appName: 'x', ...rawInput })),
    AgentCall: vi.fn(async () => ({ text: 'ok' })),
    Transform: vi.fn(() => ({})),
    Branch: vi.fn(() => 'default'),
    Report: vi.fn(() => ({ markdown: '' })),
    ForEach: vi.fn(async () => []),
    Sink: vi.fn(async () => {}),
    ...overrides,
  };
}

const linearGraph: PipelineGraph = {
  nodes: [
    { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
    { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
    { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
  ],
  edges: [{ from: 'trigger', to: 'agent' }, { from: 'agent', to: 'sink' }],
};

describe('runPipeline — linear chain', () => {
  it('runs trigger, then agent, then sink, in order, every node ok', async () => {
    const executors = fakeExecutors();
    const result = await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {});

    expect(result.status).toBe('ok');
    expect(result.nodes.map(n => n.nodeId)).toEqual(['trigger', 'agent', 'sink']);
    expect(result.nodes.every(n => n.status === 'ok')).toBe(true);
    expect(executors.Trigger).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Trigger' }), { versionId: 431 }, {});
  });

  it('passes the Trigger output to the next node keyed as "trigger"', async () => {
    const seenInput: unknown[] = [];
    const executors = fakeExecutors({
      AgentCall: vi.fn(async (_c, input) => { seenInput.push(input); return { text: 'ok' }; }),
    });
    await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {});
    expect(seenInput[0]).toEqual({ trigger: { appName: 'x', versionId: 431 } });
  });

  it('marks the run failed when a node throws and nothing downstream runs', async () => {
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { throw new Error('boom'); }) });
    const result = await runPipeline(linearGraph, 'trigger', {}, executors, {});
    expect(result.status).toBe('failed');
    const agentResult = result.nodes.find(n => n.nodeId === 'agent')!;
    expect(agentResult.status).toBe('failed');
    expect(agentResult.error).toMatch(/boom/);
    expect(executors.Sink).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts`
Expected: FAIL — module `./pipeline-runner` does not exist.

- [ ] **Step 3: Write the minimal implementation**

This version only handles a graph where every node has at most one incoming edge and nothing branches — enough for the linear-chain test, deliberately incomplete everywhere else (fan-out/fan-in, skip, envelopes, multi-trigger, memoization are Tasks 14–17).

```ts
// backend/services/ai-jobs/pipeline-runner.ts
import type {
  PipelineGraph, PipelineNode, NodeConfig, NodeRunStatus, RunStatus, Envelope,
  TriggerConfig, AgentCallConfig, TransformConfig, BranchConfig, ReportConfig, ForEachConfig, SinkConfig,
} from './types';

export type ExecutionCtx = Record<string, unknown>;

export interface NodeExecutors {
  Trigger: (config: TriggerConfig, rawInput: Record<string, unknown>, ctx: ExecutionCtx) => Promise<Record<string, unknown>>;
  AgentCall: (config: AgentCallConfig, input: Record<string, unknown>, ctx: ExecutionCtx) => Promise<Record<string, unknown>>;
  Transform: (config: TransformConfig, input: Record<string, unknown>, ctx: ExecutionCtx) => Record<string, unknown>;
  Branch: (config: BranchConfig, envelope: Envelope, ctx: ExecutionCtx) => string;
  Report: (config: ReportConfig, envelopes: Record<string, Envelope>, ctx: ExecutionCtx) => Record<string, unknown>;
  ForEach: (config: ForEachConfig, items: unknown[], ctx: ExecutionCtx) => Promise<unknown[]>;
  Sink: (config: SinkConfig, input: Record<string, unknown>, ctx: ExecutionCtx) => Promise<void>;
}

export interface NodeRunResult {
  nodeId: string;
  status: NodeRunStatus;
  output?: Record<string, unknown>;
  error?: string;
}

export interface RunResult {
  status: RunStatus;
  nodes: NodeRunResult[];
}

export async function runPipeline(
  graph: PipelineGraph,
  triggerNodeId: string,
  rawInput: Record<string, unknown>,
  executors: NodeExecutors,
  ctx: ExecutionCtx,
): Promise<RunResult> {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const results = new Map<string, NodeRunResult>();
  const outputs = new Map<string, Record<string, unknown>>();

  // Topological order via Kahn's algorithm — stable for the linear-chain case this task covers;
  // Task 14 replaces the single-pass walk below with wave-based concurrent execution.
  const inDegree = new Map<string, number>();
  for (const n of graph.nodes) inDegree.set(n.id, 0);
  for (const e of graph.edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);

  const order: string[] = [];
  const queue = graph.nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  const degreeLeft = new Map(inDegree);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges) {
      if (e.from !== id) continue;
      degreeLeft.set(e.to, (degreeLeft.get(e.to) ?? 0) - 1);
      if (degreeLeft.get(e.to) === 0) queue.push(e.to);
    }
  }

  let aborted = false;
  for (const nodeId of order) {
    const node = byId.get(nodeId)!;
    const incoming = graph.edges.filter(e => e.to === nodeId).map(e => e.from);
    const parentFailed = incoming.some(p => results.get(p)?.status === 'failed');

    if (parentFailed) {
      results.set(nodeId, { nodeId, status: 'skipped' });
      continue;
    }
    if (aborted) continue;

    const input = buildInput(incoming, outputs);
    try {
      const output = await runOne(node.config, nodeId === triggerNodeId ? rawInput : input, executors, ctx);
      results.set(nodeId, { nodeId, status: 'ok', output });
      outputs.set(nodeId, output);
    } catch (err) {
      results.set(nodeId, { nodeId, status: 'failed', error: String(err instanceof Error ? err.message : err) });
    }
  }

  const statuses = [...results.values()];
  const runStatus: RunStatus = statuses.every(r => r.status === 'ok')
    ? 'ok'
    : statuses.some(r => r.status === 'ok')
      ? 'partial'
      : 'failed';

  return { status: runStatus, nodes: order.map(id => results.get(id)!) };
}

function buildInput(incoming: string[], outputs: Map<string, Record<string, unknown>>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const sourceId of incoming) {
    if (outputs.has(sourceId)) input[sourceId] = outputs.get(sourceId);
  }
  return input;
}

async function runOne(
  config: NodeConfig,
  input: Record<string, unknown>,
  executors: NodeExecutors,
  ctx: ExecutionCtx,
): Promise<Record<string, unknown>> {
  switch (config.kind) {
    case 'Trigger': return executors.Trigger(config, input, ctx);
    case 'AgentCall': return executors.AgentCall(config, input, ctx);
    case 'Transform': return executors.Transform(config, input, ctx);
    case 'Sink': await executors.Sink(config, input, ctx); return {};
    case 'ForEach': return { items: await executors.ForEach(config, (input.items as unknown[]) ?? [], ctx) };
    // Branch/Report are envelope nodes — Task 15 replaces these two cases; left unreachable
    // from the linear-chain test this task covers (no Branch/Report node in linearGraph).
    case 'Branch': throw new Error('Branch requires envelope wiring — see Task 15');
    case 'Report': throw new Error('Report requires envelope wiring — see Task 15');
  }
}
```

Also append the "trigger output keyed as trigger" expectation to `buildInput` for the specific case where the Trigger node itself is a predecessor — note the test expects `{ trigger: { appName: 'x', versionId: 431 } }`, i.e. the Trigger's own node id (`'trigger'`) is the key, same as any other predecessor; no special-casing needed since `outputs.set('trigger', ...)` already happened. Re-verify this falls out of the code above once it's typed in — if the second test fails because the key doesn't match, it means `buildInput` needs the Trigger's *id*, not the literal string `'trigger'`, which is what's written above already (the test graph happens to name its Trigger node `'trigger'`, so this is a coincidence worth noting, not a hardcoded special case to replicate).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/pipeline-runner.ts backend/services/ai-jobs/pipeline-runner.test.ts
git commit -m "feat(ai-jobs): executor skeleton — linear topological run"
```

### Task 14: Executor — concurrent waves + transitive skip propagation

**Files:**
- Modify: `backend/services/ai-jobs/pipeline-runner.ts`
- Modify: `backend/services/ai-jobs/pipeline-runner.test.ts` (add to it — every Task 13 test must still pass unmodified)

**Interfaces:** unchanged from Task 13 — this task only changes `runPipeline`'s internal scheduling, not its signature.

- [ ] **Step 1: Write the failing test**

```ts
// append to pipeline-runner.test.ts
describe('runPipeline — concurrency and transitive skip', () => {
  const fanOutGraph: PipelineGraph = {
    nodes: [
      { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'a1', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'a2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 's1', config: { kind: 'Sink', writeFn: 'x' } },
      { id: 's2', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [
      { from: 'trigger', to: 'a1' }, { from: 'trigger', to: 'a2' },
      { from: 'a1', to: 's1' }, { from: 'a2', to: 's2' },
    ],
  };

  it('runs independent branches concurrently, not sequentially', async () => {
    const order: string[] = [];
    const executors = fakeExecutors({
      AgentCall: vi.fn(async (_c, _i) => {
        order.push('agent-start');
        await new Promise(r => setTimeout(r, 10));
        order.push('agent-end');
        return { text: 'ok' };
      }),
    });
    await runPipeline(fanOutGraph, 'trigger', {}, executors, {});
    // Both agents start before either finishes — sequential execution would interleave start/end/start/end.
    expect(order).toEqual(['agent-start', 'agent-start', 'agent-end', 'agent-end']);
  });

  it('skip propagates transitively through a chain, not just one hop', async () => {
    const chain: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'a', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'transform', config: { kind: 'Transform', fn: 'x' } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [{ from: 'trigger', to: 'a' }, { from: 'a', to: 'transform' }, { from: 'transform', to: 'sink' }],
    };
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { throw new Error('boom'); }) });
    const result = await runPipeline(chain, 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'a')!.status).toBe('failed');
    expect(result.nodes.find(n => n.nodeId === 'transform')!.status).toBe('skipped');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('skipped'); // two hops from the failure
    expect(executors.Transform).not.toHaveBeenCalled();
    expect(executors.Sink).not.toHaveBeenCalled();
  });

  it('one failed branch does not stop the sibling branch from completing (partial-failure-continues)', async () => {
    const executors = fakeExecutors({
      AgentCall: vi.fn(async (_c, input) => {
        if ('a1' in (input as object) === false && Object.keys(input as object).includes('trigger')) {
          // both a1 and a2 receive {trigger: ...}; fail only when this is the second AgentCall invocation
        }
        return { text: 'ok' };
      }),
    });
    // Make a1 fail, a2 succeed, by giving each AgentCall a distinguishable config field.
    const graph: PipelineGraph = {
      ...fanOutGraph,
      nodes: fanOutGraph.nodes.map(n =>
        n.id === 'a1' ? { ...n, config: { ...n.config, instructionTemplate: 'FAIL' } as any } : n,
      ),
    };
    const agentCall = vi.fn(async (config: any) => {
      if (config.instructionTemplate === 'FAIL') throw new Error('boom');
      return { text: 'ok' };
    });
    const result = await runPipeline(graph, 'trigger', {}, fakeExecutors({ AgentCall: agentCall }), {});

    expect(result.status).toBe('partial');
    expect(result.nodes.find(n => n.nodeId === 'a1')!.status).toBe('failed');
    expect(result.nodes.find(n => n.nodeId === 's1')!.status).toBe('skipped');
    expect(result.nodes.find(n => n.nodeId === 'a2')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 's2')!.status).toBe('ok'); // sibling branch unaffected
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts -t concurrency`
Expected: FAIL — the first test fails because Task 13's sequential `for` loop processes nodes one at a time (`order` comes out `['agent-start','agent-end','agent-start','agent-end']`, not interleaved); the skip tests may already pass by accident (direct-parent-only skip happens to produce the right one-hop answer) but the two-hop transform→sink case fails since Task 13 never checks a *skipped* parent, only a *failed* one.

- [ ] **Step 3: Rewrite the scheduling loop for waves + fix transitive skip**

Replace the `for (const nodeId of order)` block in `runPipeline` (keep everything above it — the Kahn in-degree setup stays, it's still used to know when a node's dependencies are satisfied):

```ts
  const remaining = new Set(order);
  while (remaining.size > 0) {
    const ready = [...remaining].filter(id =>
      graph.edges.filter(e => e.to === id).every(e => results.has(e.from)),
    );
    if (ready.length === 0) break; // shouldn't happen for a validated DAG; defensive exit over an infinite loop

    await Promise.all(ready.map(async (nodeId) => {
      remaining.delete(nodeId);
      const node = byId.get(nodeId)!;
      const incoming = graph.edges.filter(e => e.to === nodeId).map(e => e.from);
      const parentUnavailable = incoming.some((p) => {
        const s = results.get(p)?.status;
        return s === 'failed' || s === 'skipped';
      });

      if (parentUnavailable) {
        results.set(nodeId, { nodeId, status: 'skipped' });
        return;
      }

      const input = buildInput(incoming, outputs);
      // The spec requires `trigger` to resolve for EVERY node, "not just its direct children"
      // (Node primitives) — buildInput only ever keys by source-node-id, so a direct child of
      // the fired Trigger gets its output under that Trigger's real id (e.g. 'trigger-full'),
      // never under the literal key 'trigger', and a non-direct descendant gets no trigger data
      // at all. Both cases are wrong; this line is the fix for both at once. Safe to always set:
      // the Trigger itself always completes in the first wave, so outputs.get(triggerNodeId) is
      // populated before any other node runs.
      input.trigger = outputs.get(triggerNodeId);
      try {
        const output = await runOne(node.config, nodeId === triggerNodeId ? rawInput : input, executors, ctx);
        results.set(nodeId, { nodeId, status: 'ok', output });
        outputs.set(nodeId, output);
      } catch (err) {
        results.set(nodeId, { nodeId, status: 'failed', error: String(err instanceof Error ? err.message : err) });
      }
    }));
  }
```

Delete the old `let aborted = false;` line and the sequential loop it belonged to — the wave loop above replaces it entirely. `order` (from Kahn's algorithm) is still used afterward, for `return { status: runStatus, nodes: order.map(id => results.get(id)!) }`, so keep computing it, just stop using it to drive execution order.

**Add this test** (plan review caught the bug this line fixes, and flagged that the existing linear-chain test can't catch it — its test graph happens to name its Trigger node literally `'trigger'`, which makes source-id keying and the special `trigger` key coincide by accident):

```ts
it('"trigger" resolves for a non-direct descendant, and for a Trigger not literally named "trigger"', async () => {
  const graph: PipelineGraph = {
    nodes: [
      { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'transform', config: { kind: 'Transform', fn: 'x' } }, // sits between the Trigger and the next AgentCall
      { id: 'agent2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
    ],
    edges: [
      { from: 'trigger-full', to: 'agent' }, { from: 'agent', to: 'transform' }, { from: 'transform', to: 'agent2' },
    ],
  };
  const seenInputs: Record<string, unknown>[] = [];
  const executors = fakeExecutors({ AgentCall: vi.fn(async (_c, input) => { seenInputs.push(input); return { text: 'ok' }; }) });
  await runPipeline(graph, 'trigger-full', { versionId: 431 }, executors, {});

  // Direct child — must resolve under the literal key "trigger", not under "trigger-full".
  expect(seenInputs[0].trigger).toEqual({ appName: 'x', versionId: 431 });
  // Two hops from the Trigger, behind a Transform — must still resolve.
  expect(seenInputs[1].trigger).toEqual({ appName: 'x', versionId: 431 });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts`
Expected: PASS — including every Task 13 test, unmodified.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/pipeline-runner.ts backend/services/ai-jobs/pipeline-runner.test.ts
git commit -m "feat(ai-jobs): executor — concurrent waves, transitive skip propagation"
```

### Task 15: Executor — envelope nodes (`Branch`, `Report`), exempt from skip, adjacency-sensitive

**Files:**
- Modify: `backend/services/ai-jobs/pipeline-runner.ts`
- Modify: `backend/services/ai-jobs/pipeline-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to pipeline-runner.test.ts
describe('runPipeline — envelope nodes', () => {
  function branchGraph(): PipelineGraph {
    return {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primary-sink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'fallback-sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'primary-sink', label: 'primary' },
        { from: 'branch', to: 'fallback-sink', label: 'fallback' },
      ],
    };
  }

  it('Branch runs even when its immediate parent failed, and routes only the chosen edge', async () => {
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => { throw new Error('boom'); }),
      Branch: vi.fn((_config, envelope: any) => (envelope.status === 'failed' ? 'fallback' : 'primary')),
    });
    const result = await runPipeline(branchGraph(), 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'agent')!.status).toBe('failed');
    expect(result.nodes.find(n => n.nodeId === 'branch')!.status).toBe('ok'); // envelope node — not skipped
    expect(result.nodes.find(n => n.nodeId === 'fallback-sink')!.status).toBe('ok'); // chosen edge
    // 'inactive', not 'skipped' — a Branch's non-chosen edge was never going to run regardless of
    // whether anything upstream failed; it is structurally outside this run's chosen path, the same
    // concept Task 16 uses for a whole non-fired Trigger zone. This matters for the rollup (see the
    // new test below): if this were 'skipped', a perfectly healthy Branch-routed run would report
    // 'partial' overall purely because one edge was never taken, which is wrong. Caught in Task 13's
    // review, fixed here before this task's code was ever written, not as a later patch.
    expect(result.nodes.find(n => n.nodeId === 'primary-sink')!.status).toBe('inactive'); // not chosen
    expect(executors.Branch).toHaveBeenCalledWith(expect.anything(), { status: 'failed', error: expect.stringContaining('boom') }, {});
  });

  it('a healthy Branch-routed run reports "ok" overall, not "partial" — the non-chosen edge is inactive, not a negative outcome', async () => {
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => ({ text: 'ok' })), // succeeds this time, unlike the test above
      Branch: vi.fn(() => 'primary'),
    });
    const result = await runPipeline(branchGraph(), 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'agent')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'branch')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'primary-sink')!.status).toBe('ok'); // chosen edge
    expect(result.nodes.find(n => n.nodeId === 'fallback-sink')!.status).toBe('inactive'); // not chosen, not a failure
    // The whole point of this test: an untaken branch must never drag a fully healthy run down to
    // 'partial'. Relies on the rollup already excluding 'inactive' from its ok/some-ok/none-ok vote
    // (added as a forward-compatible no-op during Task 13's own fix round, for exactly this case).
    expect(result.status).toBe('ok');
  });

  // Three more cases this task's own review found broken in the first draft — add them here,
  // not as an afterthought: (1) a non-chosen path more than one hop deep (e.g.
  // branch -[fallback, not chosen]-> midAgent -> sink) must mark BOTH midAgent and sink
  // 'inactive', not 'skipped', and the overall run must still be 'ok'; (2) a second Branch
  // sitting entirely on a non-chosen edge must itself become 'inactive' and never call
  // executors.Branch; (3) same for a Report on a fully dead path — its Sink must never fire.
  // Each of these reproduces a real bug the review proved by probing the live executor, not a
  // hypothetical — write them as real regression tests, not a TODO.
  //
  // A fourth case, found on the SAME review's re-pass over its own fix: a Report fed by several
  // sources where most are genuinely live and ok, and exactly one is on a dead (non-chosen)
  // Branch edge — assert the Report's executor IS called (unlike case 3 above, where every
  // source is dead), its Sink runs with the real assembled content from the live sections, and
  // the overall run is 'ok'. This is the scenario that proved the naive "any dead edge -> Report
  // inactive" rule wrong — six good sections must never be silently dropped because a seventh,
  // optional one wasn't chosen.
  //
  // Two more cases found on a THIRD pass over the same fix, both from isEdgeDead not matching
  // its own stated contract: (5) a Report fed ONLY by a Branch whose predicate function threw —
  // assert the Report still runs (not 'inactive'), its envelope for that section is
  // {status:'failed', error: ...}, and its Sink fires with an honest failure placeholder, not a
  // silent drop. (6) a Report fed by one live, genuinely-ok AgentCall PLUS a direct edge from a
  // Branch's non-chosen label (no intermediate node between the Branch and the Report) — assert
  // the Report still runs, the branch-edge section's envelope is exactly {status:'inactive'}
  // (not the Branch's raw {chosenEdge} output, which would crash runReport's `.text` access),
  // the assembled markdown contains the live section's real content plus an honest placeholder
  // for the branch-gated one, and the overall run is 'ok'.

  it('a Branch that is NOT the immediate child of a failure sees "skipped", not "failed" — the adjacency rule in practice', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'transform', config: { kind: 'Transform', fn: 'x' } }, // sits between the failure and the Branch
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary'] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' }, { from: 'agent', to: 'transform' },
        { from: 'transform', to: 'branch' }, { from: 'branch', to: 'sink', label: 'primary' },
      ],
    };
    let seenEnvelope: any;
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => { throw new Error('boom'); }),
      Branch: vi.fn((_c, envelope: any) => { seenEnvelope = envelope; return 'primary'; }),
    });
    await runPipeline(graph, 'trigger', {}, executors, {});
    expect(seenEnvelope).toEqual({ status: 'skipped' }); // not { status: 'failed', error: 'boom' } — transform absorbed it
  });

  it('Report gathers an envelope per section source and assembles once all settle', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'a1', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'ok', toolAllowlist: [] } },
        { id: 'a2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'FAIL', toolAllowlist: [] } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'One', from: 'a1' }, { title: 'Two', from: 'a2' }] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'a1' }, { from: 'trigger', to: 'a2' },
        { from: 'a1', to: 'report' }, { from: 'a2', to: 'report' }, { from: 'report', to: 'sink' },
      ],
    };
    let seenEnvelopes: any;
    const agentCall = vi.fn(async (config: any) => { if (config.instructionTemplate === 'FAIL') throw new Error('nope'); return { text: 'ok' }; });
    const report = vi.fn((_c, envelopes: any) => { seenEnvelopes = envelopes; return { markdown: 'x' }; });
    const result = await runPipeline(graph, 'trigger', {}, fakeExecutors({ AgentCall: agentCall, Report: report }), {});

    expect(result.nodes.find(n => n.nodeId === 'report')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('ok'); // Report's own output always flows onward
    expect(seenEnvelopes).toEqual({
      a1: { status: 'ok', output: { text: 'ok' } },
      a2: { status: 'failed', error: expect.stringContaining('nope') },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts -t "envelope nodes"`
Expected: FAIL — `runOne`'s `Branch`/`Report` cases still throw the Task-13 placeholder errors, and the wave loop's `parentUnavailable` check skips them like any other node.

- [ ] **Step 3: Add the envelope exemption and envelope-building**

Add a helper and change two things in the wave loop: the skip check, and `runOne`'s `Branch`/`Report` cases.

```ts
function buildEnvelope(parentId: string, results: Map<string, { status: string; output?: Record<string, unknown>; error?: string }>): Envelope {
  const r = results.get(parentId);
  if (!r) return { status: 'skipped' }; // defensive — shouldn't happen, the wave loop only runs a node once every incoming edge has a result
  if (r.status === 'ok') return { status: 'ok', output: r.output ?? {} };
  if (r.status === 'failed') return { status: 'failed', error: r.error ?? 'unknown error' };
  return { status: r.status === 'inactive' ? 'inactive' : 'skipped' };
}
```

Also add a second helper, `isEdgeDead`, shared by `unavailabilityStatus` below and by `Report`'s own eligibility check and envelope-building — three different call sites all need the same answer to "did this specific EDGE ever carry anything," not just "what's my parent's own collapsed status":

```ts
/**
 * Whether a single incoming edge is "dead" this run — its source never actually fed this edge,
 * either because the source itself is already 'inactive' (a dead path, recursively), or because
 * the source is a Branch and THIS edge's label isn't the one it chose (the source itself may
 * well have resolved 'ok' — a Branch always does when it successfully routes — so checking the
 * source's own collapsed status is not enough; the per-edge label match is what actually decides
 * whether this particular edge carried anything).
 *
 * A 'failed' or 'skipped' source is deliberately NOT "dead" by this definition, and the check
 * below must come FIRST, before the Branch-label check — a Branch whose own predicate function
 * threw has no `output.chosenEdge` at all, so `chosenEdge !== e.label` is true for every one of
 * its outgoing edges, which would otherwise mark them all "dead" even though the real situation
 * is a genuine failure, not a routing decision. Caught in this task's review: the first version
 * of this function skipped straight to the Branch-label check without this guard, which made a
 * `Report` fed only by a failed `Branch` go `'inactive'` (never running, losing the failure
 * placeholder and the Sink write) instead of running normally with a `{status:'failed'}` envelope
 * for that section — exactly the silent-data-loss failure this whole mechanism exists to prevent.
 */
function isEdgeDead(e: PipelineEdge, byId: Map<string, PipelineNode>, results: Map<string, NodeRunResult>): boolean {
  const parentResult = results.get(e.from);
  if (parentResult?.status === 'failed' || parentResult?.status === 'skipped') return false;
  if (parentResult?.status === 'inactive') return true;
  if (byId.get(e.from)?.config.kind === 'Branch' && e.label) {
    const chosenEdge = (parentResult?.output as { chosenEdge?: string } | undefined)?.chosenEdge;
    return chosenEdge !== e.label;
  }
  return false;
}
```

(`PipelineEdge` needs adding to this file's existing `import type { PipelineGraph, NodeConfig, ... } from './types';` line alongside `PipelineNode`.)

In the wave loop, change the skip decision — note this anticipates the `unavailabilityStatus` helper Step 3 below replaces `parentUnavailable` with, so write them together rather than one then the other. **The envelope-node exemption applies only to a genuine ancestor failure (`'skipped'`), never to a dead/non-chosen path (`'inactive'`)** — a `Branch` or `Report` sitting entirely on an edge that was never chosen has nothing to decide or assemble, and must not run (this was a real bug caught in this task's own review: the first draft of this block exempted envelope nodes from `'inactive'` too, which let a second `Branch` — or a `Report` — sitting on a non-chosen edge still execute, including any `Sink` beneath it actually writing in production).

**`Report` needs its own, more lenient eligibility rule, not the generic `unavailabilityStatus` check** — this is the spec's own explicit requirement (`docs/specs/2026-10-10-ai-job-pipelines-design.md`'s Node primitives table: "it always runs once every `from` node settles... rather than requiring all-`ok`"), and a second real bug this task's own review caught when the fix above was first drafted: `unavailabilityStatus` returns `'inactive'` the moment even ONE incoming edge is a pure branch-mismatch and none are real failures — correct for `Branch` (exactly one logical predecessor, so "any dead input" and "all dead inputs" are the same thing), wrong for `Report` (many declared sections, where the entire point is tolerating a mix of outcomes). Applying the generic rule to `Report` made a `Report` with, say, six live `ok` sections and a seventh behind a `Branch` that didn't choose that path go entirely `'inactive'` and never run — silently dropping six good sections and reporting the run `'ok'`, the exact "silent gap reported as success" failure mode this whole project exists to eliminate. `Report` must instead go `'inactive'` only when **every** incoming edge is dead; if even one is live (whether `ok`, `failed`, or `skipped` — anything that isn't `'inactive'`), `Report` runs and gets its usual per-section envelopes (Task 9's `runReport` already placeholders a non-`ok` section identically for `failed`/`skipped`/`inactive`, so no change needed there):

```ts
      const isEnvelopeNode = node.config.kind === 'Branch' || node.config.kind === 'Report';

      if (node.config.kind === 'Report') {
        const incomingEdges = graph.edges.filter(e => e.to === nodeId);
        // Per-EDGE liveness via isEdgeDead, not a raw parent-status check — a Report fed directly
        // off a Branch's non-chosen labeled edge has a parent (the Branch) that resolved 'ok', so
        // checking the parent's own collapsed status would miss that THIS specific edge was never
        // the chosen one. Caught in this task's review: the first draft of this check used
        // `results.get(e.from)?.status === 'inactive'` directly, which passed every test that
        // existed at the time but is wrong the moment Report sits immediately downstream of a
        // Branch rather than behind an intermediate node.
        const allIncomingDead = incomingEdges.length > 0
          && incomingEdges.every(e => isEdgeDead(e, byId, results));
        if (allIncomingDead) {
          results.set(nodeId, { nodeId, status: 'inactive' });
          return;
        }
        // otherwise fall through and run Report normally — it's already exempt from 'skipped'
        // below, and is now also exempt from a partial-'inactive' mix via the check just above
      } else {
        if (unavailability === 'inactive') {
          results.set(nodeId, { nodeId, status: 'inactive' });
          return; // every node kind except Report (handled above) — a dead path is dead regardless of kind
        }
        if (unavailability === 'skipped' && !isEnvelopeNode) {
          results.set(nodeId, { nodeId, status: 'skipped' });
          return; // the envelope-node exemption, now scoped to genuine failures only
        }
      }
```

And replace `runOne`'s `Branch`/`Report` cases:

```ts
    case 'Branch': {
      // Branch has exactly one logical predecessor per the spec (it picks ONE outgoing edge from
      // ONE input) — if a graph somehow wires more than one into a Branch, use the first; the
      // graph validator (Task 12) doesn't currently forbid this, worth a follow-up if it matters.
      const envelope = branchEnvelope!; // see call-site change below — passed in rather than recomputed here
      const chosen = executors.Branch(config, envelope, ctx);
      return { chosenEdge: chosen };
    }
    case 'Report': {
      const envelopes = reportEnvelopes!; // see call-site change below
      return executors.Report(config, envelopes, ctx);
    }
```

`runOne` needs the envelope(s) passed in rather than computed from `input` (which only ever carries `ok` outputs, never failure info) — change its signature and the one call site:

```ts
async function runOne(
  config: NodeConfig,
  input: Record<string, unknown>,
  executors: NodeExecutors,
  ctx: ExecutionCtx,
  branchEnvelope?: Envelope,
  reportEnvelopes?: Record<string, Envelope>,
): Promise<Record<string, unknown>> {
```

and in the wave loop, right before the `runOne` call, branch on node kind to build what Step 3 just wired through:

```ts
      let branchEnvelope: Envelope | undefined;
      let reportEnvelopes: Record<string, Envelope> | undefined;
      if (node.config.kind === 'Branch') {
        branchEnvelope = buildEnvelope(incoming[0], results);
      } else if (node.config.kind === 'Report') {
        // Edge-aware, same reasoning as the eligibility check above: `buildEnvelope` alone only
        // ever looks at a parent's own collapsed status, so a section sourced directly from a
        // Branch's non-chosen edge would get `{status:'ok', output:{chosenEdge:...}}` — a real
        // envelope shape, just the WRONG one, since that edge never actually carried report
        // content. `runReport` then throws reading `.text` off an object that doesn't have it.
        // Caught in this task's review: override to `{status:'inactive'}` for any edge
        // `isEdgeDead` says never carried anything, regardless of what its parent's own status is.
        const reportIncomingEdges = graph.edges.filter(e => e.to === nodeId);
        reportEnvelopes = Object.fromEntries(
          reportIncomingEdges.map(e => [
            e.from,
            isEdgeDead(e, byId, results) ? { status: 'inactive' as const } : buildEnvelope(e.from, results),
          ]),
        );
      }

      const input = buildInput(incoming, outputs);
      input.trigger = outputs.get(triggerNodeId); // see Task 14 — keep this line through every later rewrite of this block
      try {
        const output = await runOne(node.config, nodeId === triggerNodeId ? rawInput : input, executors, ctx, branchEnvelope, reportEnvelopes);
        results.set(nodeId, { nodeId, status: 'ok', output });
        outputs.set(nodeId, output);
      } catch (err) {
        results.set(nodeId, { nodeId, status: 'failed', error: String(err instanceof Error ? err.message : err) });
      }
```

Finally, a `Branch`'s *downstream* routing: when deciding whether a node fed by a `Branch` is unavailable, an edge whose `label` doesn't match the Branch's `chosenEdge` must count as unavailable even though the Branch itself is `ok`. But this needs to produce a status distinct from a genuine ancestor failure: a non-chosen edge was never going to run regardless of whether anything upstream failed, so it gets `'inactive'` (the same "structurally outside this run" concept Task 16 uses for a whole non-fired Trigger zone). **Only a real `failed`/`skipped` ancestor produces `'skipped'` — `'inactive'` never does, at any depth.** (An earlier draft of this paragraph said "a real failed/skipped/inactive ancestor still produces skipped" — that's the exact bug this task's own review caught and fixed below: grouping `'inactive'` with the two real-failure statuses made an inactive ancestor degrade into `'skipped'` one hop downstream, which makes a perfectly healthy Branch-routed run report `'partial'` overall purely because one edge was never taken.)

Replace the `incoming.some(p => ...)` boolean from Task 14 with a function that returns the right status instead of a bare boolean, built on top of `isEdgeDead` above. Add `PipelineNode` and `PipelineEdge` to this file's existing `import type { PipelineGraph, NodeConfig, ... } from './types';` line — used here as explicit parameter annotations for the first time in this file (everywhere else they were only ever inferred):

```ts
function unavailabilityStatus(
  nodeId: string,
  graph: PipelineGraph,
  byId: Map<string, PipelineNode>,
  results: Map<string, NodeRunResult>,
): 'skipped' | 'inactive' | null {
  const incomingEdges = graph.edges.filter(e => e.to === nodeId);
  let anyUnavailable = false;
  let branchMismatchOnly = true; // flips to false the moment a REAL ancestor failure/skip is found — NOT for 'inactive'
  for (const e of incomingEdges) {
    const s = results.get(e.from)?.status;
    if (s === 'failed' || s === 'skipped') {
      anyUnavailable = true;
      branchMismatchOnly = false;
      continue;
    }
    // A dead edge (source already 'inactive', or a Branch's non-chosen label) must propagate as
    // 'inactive', never degrade to 'skipped' just because it crossed a hop boundary — it does NOT
    // flip branchMismatchOnly: a dead edge is itself only ever caused by a branch mismatch (or
    // another dead edge, recursively) further up the chain, never a real failure. isEdgeDead
    // already returns false for a failed/skipped source (checked above anyway, so redundant here,
    // but keeps the two functions' contracts consistent for every caller).
    if (isEdgeDead(e, byId, results)) anyUnavailable = true;
  }
  if (!anyUnavailable) return null;
  return branchMismatchOnly ? 'inactive' : 'skipped';
}
```

And in the wave loop, right before the skip-decision block above:

```ts
      const unavailability = unavailabilityStatus(nodeId, graph, byId, results);
```

(`incoming`, the plain id array, is still used elsewhere in this block for `buildInput`/envelope-building — keep that variable too; this function is additional, not a replacement for it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts`
Expected: PASS — every test from Tasks 13–15.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/pipeline-runner.ts backend/services/ai-jobs/pipeline-runner.test.ts
git commit -m "feat(ai-jobs): executor — Branch/Report envelope exemption, edge-label routing"
```

### Task 16: Executor — multi-trigger zones, `inactive` status, run-status rollup excludes it

**Files:**
- Modify: `backend/services/ai-jobs/pipeline-runner.ts`
- Modify: `backend/services/ai-jobs/pipeline-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to pipeline-runner.test.ts
describe('runPipeline — multi-trigger zones', () => {
  const twoTriggerGraph: PipelineGraph = {
    nodes: [
      { id: 'full', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'rescan', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'agent-full', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink-full', config: { kind: 'Sink', writeFn: 'x' } },
      { id: 'agent-rescan', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink-rescan', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [
      { from: 'full', to: 'agent-full' }, { from: 'agent-full', to: 'sink-full' },
      { from: 'rescan', to: 'agent-rescan' }, { from: 'agent-rescan', to: 'sink-rescan' },
    ],
  };

  it('firing "rescan" marks every node in the "full" zone inactive, and never calls their executors', async () => {
    const executors = fakeExecutors();
    const result = await runPipeline(twoTriggerGraph, 'rescan', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'full')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'agent-full')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'sink-full')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'rescan')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'agent-rescan')!.status).toBe('ok');
    // The Trigger executor is called once per run (the fired one), never for the inactive zone's Trigger.
    expect(executors.Trigger).toHaveBeenCalledTimes(1);
  });

  it('run status rolls up over the active zone only — inactive nodes never count toward ok/partial/failed', async () => {
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { throw new Error('boom'); }) });
    const result = await runPipeline(twoTriggerGraph, 'rescan', {}, executors, {});
    // agent-rescan fails, sink-rescan skips — the "full" zone (4 inactive nodes) must not turn this into "partial"
    // via some leftover inactive-counts-as-ok logic, nor silently inflate node totals.
    expect(result.status).toBe('failed'); // the whole (2-node) active zone produced nothing
    const activeZoneNodes = result.nodes.filter(n => n.status !== 'inactive');
    expect(activeZoneNodes.map(n => n.nodeId).sort()).toEqual(['agent-rescan', 'rescan', 'sink-rescan']);
  });

  it('throws on a triggerNodeId that does not name a real Trigger node, rather than silently reporting ok', async () => {
    const executors = fakeExecutors();
    await expect(runPipeline(twoTriggerGraph, 'not-a-real-node', {}, executors, {})).rejects.toThrow(/not a Trigger node/);
    await expect(runPipeline(twoTriggerGraph, 'agent-full', {}, executors, {})).rejects.toThrow(/not a Trigger node/); // a real node, but not a Trigger
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts -t "multi-trigger"`
Expected: FAIL — today every node runs regardless of which `Trigger` fired (there's only ever been one `Trigger` exercised so far), so `executors.Trigger` is called once per `Trigger` node in the graph, not once total, and nothing is ever `inactive`.

- [ ] **Step 3: Compute the fired trigger's reachable zone up front, short-circuit everything else**

Add a reachability helper (same shape as the graph validator's, intentionally not shared — the validator's runs at publish time over the *whole* graph checking every `Trigger`; this one runs at execution time for *one* fired `Trigger`, different enough callers that a shared util would need a clunky parameter just to say "which mode," not worth it for two call sites):

```ts
function reachableFrom(nodeId: string, graph: PipelineGraph): Set<string> {
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== current || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}
```

At the top of `runPipeline`, right after `const byId = new Map(...)`:

```ts
  const firedTrigger = byId.get(triggerNodeId);
  if (!firedTrigger || firedTrigger.config.kind !== 'Trigger') {
    // Without this, a typo'd or missing triggerNodeId makes activeZone = {triggerNodeId} only
    // (reachableFrom still "succeeds" — it just finds one unknown node with no edges), every
    // real node ends up `inactive`, activeResults is empty, and the ok/partial/failed rollup
    // below is vacuously `true` on an empty array — the run reports 'ok' having executed and
    // written nothing. Caught in plan review. Fail loud instead.
    throw new Error(`runPipeline: "${triggerNodeId}" is not a Trigger node in this graph`);
  }

  const activeZone = reachableFrom(triggerNodeId, graph);
  for (const n of graph.nodes) {
    if (!activeZone.has(n.id)) results.set(n.id, { nodeId: n.id, status: 'inactive' });
  }
```

Change the wave loop's `remaining` set to exclude the inactive nodes from the start (they already have a result, so `ready`'s `!results.has` style checks would naturally skip them if you compute `remaining` as `new Set(order.filter(id => activeZone.has(id)))` instead of `new Set(order)`).

**No change needed to the run-status rollup block itself** — by this point in the plan it
already excludes both Trigger-kind nodes and `'inactive'` status from its vote. Both exclusions
were added during Task 13's own review (not as something this task introduces): that task's
first draft counted the fired Trigger's own `'ok'` status in the rollup, which made a single
downstream failure alongside an otherwise-healthy Trigger incorrectly report `'partial'`
instead of `'failed'`; the `'inactive'` exclusion was added at the same time, as a forward-
compatible no-op, specifically so neither this task nor Task 15 (which started actually
producing `'inactive'` statuses, for a Branch's non-chosen edge) would need to touch this block
again. It also already handles the empty-outcome-set edge case correctly (falls back to the
fired Trigger's own status rather than hardcoding `'ok'`) — a gap this task's own multi-trigger
work would otherwise have reintroduced for a Trigger-only active zone whose Trigger throws.
Confirm by reading the current state of the block rather than re-deriving it:

```ts
  const outcomeStatuses = statuses.filter(r =>
    r.status !== 'inactive' && byId.get(r.nodeId)?.config.kind !== 'Trigger'
  );
  const runStatus: RunStatus = outcomeStatuses.length === 0
    ? (results.get(triggerNodeId)?.status === 'ok' ? 'ok' : 'failed')
    : outcomeStatuses.every(r => r.status === 'ok')
      ? 'ok'
      : outcomeStatuses.some(r => r.status === 'ok')
        ? 'partial'
        : 'failed';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts`
Expected: PASS — every test from Tasks 13–16.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai-jobs/pipeline-runner.ts backend/services/ai-jobs/pipeline-runner.test.ts
git commit -m "feat(ai-jobs): executor — multi-trigger zones, inactive status, rollup excludes it"
```

### Task 17: Executor — opt-in memoization

Design note not spelled out verbatim in the spec: the hash is computed over `{config, input}` together, not `input` alone. Since `(nodeId, pipelineVersionId)` already pins `config` for the cache key, hashing `input` alone would be equivalent in practice — but hashing both is strictly safer (covers a future case where the same `nodeId` legitimately gets different config across a hand-edited draft/published split) and costs nothing. `Trigger` and `Report` are never memoized regardless of `reuseUnchanged` — enforced structurally by only checking the cache for `'AgentCall'`/`'Sink'` kinds.

**Files:**
- Create: `backend/services/ai-jobs/memoization.ts`
- Create: `backend/services/ai-jobs/memoization.test.ts`
- Modify: `backend/services/ai-jobs/pipeline-runner.ts`
- Modify: `backend/services/ai-jobs/pipeline-runner.test.ts`

**Interfaces:**
- Produces: `computeInputHash(config: NodeConfig, input: Record<string, unknown>): string` (sha256 hex, normalized through a JSON round-trip first — see Step 3 below for why). `runPipeline`'s signature gains a 6th, optional parameter: `options?: { reuseUnchanged?: boolean; priorNodeRuns?: Record<string, { inputHash: string; output: Record<string, unknown> }> }`. `NodeRunResult` gains `wasMemoized?: boolean` AND `inputHash?: string` — the hash is computed and attached for every `MEMOIZABLE_KINDS` node **regardless of whether `reuseUnchanged` is set**, not only on a cache hit; otherwise a run with reuse off can never seed a hash for a later run to reuse, and Task 19's REST handler (which persists this column so it can reload it next time) would have nothing real to write. Caught in this task's own review.

- [ ] **Step 1: Write the failing test for `computeInputHash`**

```ts
// backend/services/ai-jobs/memoization.test.ts
import { describe, it, expect } from 'vitest';
import { computeInputHash } from './memoization';

describe('computeInputHash', () => {
  it('is stable for the same config + input regardless of key order', () => {
    const a = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: ['a', 'b'] }, { trigger: { appName: 'x', versionName: '1' } });
    const b = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: ['a', 'b'] }, { trigger: { versionName: '1', appName: 'x' } });
    expect(a).toBe(b);
  });

  it('changes when the input changes', () => {
    const config = { kind: 'AgentCall' as const, tier: 'High', instructionTemplate: 'x', toolAllowlist: [] };
    const a = computeInputHash(config, { trigger: { versionName: '6.10.1' } });
    const b = computeInputHash(config, { trigger: { versionName: '6.10.2' } });
    expect(a).not.toBe(b);
  });

  it('changes when the config changes, even with identical input', () => {
    const input = { trigger: { versionName: '1' } };
    const a = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'old prompt', toolAllowlist: [] }, input);
    const b = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'new prompt', toolAllowlist: [] }, input);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/memoization.test.ts`
Expected: FAIL — module `./memoization` does not exist.

- [ ] **Step 3: Write `computeInputHash`**

```ts
// backend/services/ai-jobs/memoization.ts
import { createHash } from 'crypto';
import type { NodeConfig } from './types';

/** Deterministic stringify: sorts object keys at every level so key order never affects the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeInputHash(config: NodeConfig, input: Record<string, unknown>): string {
  // Round-trip through JSON first — found during Task 17's review. Two gaps in stableStringify
  // alone: (1) a Date hashes as '{}' (stableStringify's object branch walks a value's own keys,
  // and a Date has none of its time data as an own enumerable key, so two different Dates
  // collide into a false "unchanged" hit — not reachable today since every real Date this hashes
  // touches is already stringified to ISO text before it gets here, e.g. the Trigger's own
  // expander, but fragile to rely on silently); (2) a key explicitly set to
  // `undefined` hashes differently from that key being entirely absent, which matters once a
  // hash computed in-memory during one run has to match the SAME hash after a round-trip through
  // the DB's JSON column in a later run (undefined keys don't survive that round-trip, so an
  // in-memory hash computed before storage would never match one computed after reload). A
  // JSON.parse(JSON.stringify(...)) pass first gives the hash the exact same normalization the
  // DB round-trip already imposes, so a hash computed now matches one computed after storage.
  const normalized = JSON.parse(JSON.stringify({ config, input }));
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

export const MEMOIZABLE_KINDS: ReadonlySet<string> = new Set(['AgentCall', 'Sink']);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/memoization.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing executor test**

```ts
// append to pipeline-runner.test.ts
describe('runPipeline — memoization', () => {
  it('reuses a prior AgentCall output when reuseUnchanged is set and the hash matches, never calls the executor', async () => {
    const { computeInputHash } = await import('./memoization');
    const config = linearGraph.nodes[1].config; // the AgentCall node
    // Must match what the executor actually builds, not a guess — fakeExecutors' Trigger returns
    // { appName: 'x', ...rawInput }, and every node's input.trigger is that output (Task 14's fix).
    // The first draft of this test hashed { trigger: { versionId: 431 } } (missing appName),
    // which never matched the runtime hash — the memoization lookup missed, AgentCall WAS
    // called, and the test failed for a hash mismatch, not the behavior it claims to test.
    // Caught in plan review.
    const input = { trigger: { appName: 'x', versionId: 431 } };
    const priorHash = computeInputHash(config, input);

    const executors = fakeExecutors();
    const result = await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {}, {
      reuseUnchanged: true,
      priorNodeRuns: { agent: { inputHash: priorHash, output: { text: 'cached answer' } } },
    });

    expect(executors.AgentCall).not.toHaveBeenCalled();
    const agentResult = result.nodes.find(n => n.nodeId === 'agent')!;
    expect(agentResult.status).toBe('ok');
    expect(agentResult.wasMemoized).toBe(true);
    expect(agentResult.output).toEqual({ text: 'cached answer' });
  });

  it('runs fresh when the hash does not match (input actually changed)', async () => {
    const executors = fakeExecutors();
    const result = await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {}, {
      reuseUnchanged: true,
      priorNodeRuns: { agent: { inputHash: 'stale-hash-from-a-different-input', output: { text: 'stale' } } },
    });
    expect(executors.AgentCall).toHaveBeenCalled();
    expect(result.nodes.find(n => n.nodeId === 'agent')!.wasMemoized).toBeFalsy();
  });

  it('never memoizes Trigger or Report even when a matching hash is supplied', async () => {
    const { computeInputHash } = await import('./memoization');
    // Hash against the REAL runtime input shape, not a guess — found during this task's own
    // review via mutation testing (temporarily adding 'Trigger' to MEMOIZABLE_KINDS and
    // re-running): the earlier draft of this test hashed `{ versionId: 431 }`, which never
    // matches what the executor actually computes for the Trigger node (`{ trigger: undefined }`
    // — the Trigger hasn't produced its own output into `outputs` yet when it itself is the one
    // about to run), so a broken exclusion gate would have passed this test anyway. Confirming
    // the gate is real requires a hash that WOULD match if the gate were ever removed.
    const triggerConfig = linearGraph.nodes[0].config;
    const triggerHash = computeInputHash(triggerConfig, { trigger: undefined });
    const reportConfig: NodeConfig = { kind: 'Report', sections: [{ title: 'X', from: 'agent' }] };
    const reportInput = { agent: { text: 'fresh' }, trigger: { appName: 'x', versionId: 431 } };
    const reportHash = computeInputHash(reportConfig, reportInput);

    const executors = fakeExecutors();
    await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {}, {
      reuseUnchanged: true,
      priorNodeRuns: {
        trigger: { inputHash: triggerHash, output: { appName: 'cached' } },
        agent: { inputHash: reportHash, output: { markdown: 'cached report' } }, // only matters if 'agent' were a Report; see note below
      },
    });
    expect(executors.Trigger).toHaveBeenCalled(); // not skipped, despite a matching hash in priorNodeRuns

    // Separately confirm the Report exclusion on a graph that actually has one — `linearGraph`'s
    // own 'agent' node is an AgentCall, not a Report, so reuse the envelope-nodes `branchGraph`-
    // style fixture (or any graph with a Report node already defined earlier in this file) rather
    // than fabricate a second graph inline here: run it with `reuseUnchanged: true` and a
    // `priorNodeRuns` entry for the Report node using `reportHash`/`reportInput` above (adjust
    // `reportInput` to that graph's real section sources), and assert `executors.Report` was
    // still called despite the "matching" hash.
  });

  it('reuseUnchanged defaults to off — omitting it runs everything fresh even with priorNodeRuns supplied', async () => {
    const { computeInputHash } = await import('./memoization');
    const config = linearGraph.nodes[1].config;
    const hash = computeInputHash(config, { trigger: { appName: 'x', versionId: 431 } }); // the real resolved shape, same correction as the first test
    const executors = fakeExecutors();
    await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {}, {
      priorNodeRuns: { agent: { inputHash: hash, output: { text: 'should not be used' } } },
    });
    expect(executors.AgentCall).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts -t memoization`
Expected: FAIL — `runPipeline` doesn't accept a 6th parameter yet, and `NodeRunResult` has no `wasMemoized` field.

- [ ] **Step 7: Wire memoization into the executor**

Add to `types.ts`: `NodeRunResult` (if it's declared there instead of `pipeline-runner.ts` — it's declared in `pipeline-runner.ts` per Task 13, so add it there) gains `wasMemoized?: boolean` and `inputHash?: string`.

Change `runPipeline`'s signature and add the lookup inside the wave loop, right before the `try`/`runOne` call:

```ts
export async function runPipeline(
  graph: PipelineGraph,
  triggerNodeId: string,
  rawInput: Record<string, unknown>,
  executors: NodeExecutors,
  ctx: ExecutionCtx,
  options: { reuseUnchanged?: boolean; priorNodeRuns?: Record<string, { inputHash: string; output: Record<string, unknown> }> } = {},
): Promise<RunResult> {
```

Inside the wave loop, after `const input = buildInput(incoming, outputs);` and before the `try`. The hash is computed unconditionally for a `MEMOIZABLE_KINDS` node — not gated on `options.reuseUnchanged` — specifically so a run with reuse OFF still produces a real `inputHash` for `NodeRunResult`, which Task 19's REST handler persists so a LATER run (possibly the first one with `reuseUnchanged: true`) has something to compare against. Found in this task's own review: an earlier draft gated the hash computation itself on `reuseUnchanged`, which meant `inputHash` was only ever populated during a cache-hit check, never recorded for Task 19 to persist — the feature could never fire even once in production. Also clones the reused output (`structuredClone`) rather than handing back a shared reference, so nothing downstream can mutate the cached entry in place:

```ts
      let inputHash: string | undefined;
      if (MEMOIZABLE_KINDS.has(node.config.kind)) {
        // try/catch: found in Task 17's final review round. Making the hash unconditional (see
        // above) means a default run — reuseUnchanged never even mentioned — now always reaches
        // computeInputHash too; before this task's fix round it only ran inside the
        // reuseUnchanged-gated block, so a default run never touched it. A BigInt or circular
        // reference anywhere in a memoizable node's input (JSON.stringify throws on both) would
        // otherwise reject the WHOLE runPipeline call over a cosmetic hash failure, even with
        // memoization never in use. Leaving inputHash undefined and continuing is strictly safer
        // than crashing the run for a feature that isn't even active.
        try {
          inputHash = computeInputHash(node.config, input);
        } catch {
          inputHash = undefined;
        }
        if (options.reuseUnchanged && inputHash !== undefined) {
          const prior = options.priorNodeRuns?.[nodeId];
          if (prior && prior.inputHash === inputHash) {
            const output = structuredClone(prior.output);
            results.set(nodeId, { nodeId, status: 'ok', output, wasMemoized: true, inputHash });
            outputs.set(nodeId, output);
            return;
          }
        }
      }
```

And the existing fresh-execution path, right below, needs `inputHash` attached too (so a run with reuse off still records it):

```ts
      try {
        const output = await runOne(node.config, nodeId === triggerNodeId ? rawInput : input, executors, ctx, branchEnvelope, reportEnvelopes);
        results.set(nodeId, { nodeId, status: 'ok', output, ...(inputHash !== undefined ? { inputHash } : {}) });
        outputs.set(nodeId, output);
      } catch (err) {
        results.set(nodeId, { nodeId, status: 'failed', error: String(err instanceof Error ? err.message : err) });
      }
```

Add the import: `import { computeInputHash, MEMOIZABLE_KINDS } from './memoization';`

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/pipeline-runner.test.ts`
Expected: PASS — every test from Tasks 13–17.

- [ ] **Step 9: Commit**

```bash
git add backend/services/ai-jobs/memoization.ts backend/services/ai-jobs/memoization.test.ts backend/services/ai-jobs/pipeline-runner.ts backend/services/ai-jobs/pipeline-runner.test.ts
git commit -m "feat(ai-jobs): opt-in memoization — AgentCall/Sink only, off by default"
```

### Task 18: Pin the concurrent-`Sink`-writes invariant with a real gate test

This is the load-bearing, previously-undocumented behavior the spec calls out: `patchNoteSection` does a synchronous read-splice-write with no `await` between the read and the write, so same-tick concurrent calls happen to serialize correctly today. This task doesn't add new product code — it adds the regression test that catches it if `apk-notes.ts`'s storage ever goes async.

**Files:**
- Modify: `backend/services/apk-notes.test.ts` (existing file — add to it)

- [ ] **Step 1: Write the test**

```ts
// append to backend/services/apk-notes.test.ts — adapt the db setup to whatever fixture
// the rest of this test file already uses (it has apk_versions/apk_notes tables wired up
// somewhere already, since every other test in the file needs them); don't build a second one.
describe('concurrent patchNoteSection calls', () => {
  it('four concurrent writes to four different sections of the same version all land — no lost update', async () => {
    const db = /* existing fixture */;
    const versionId = /* existing fixture's seeded version id */;

    await Promise.all([
      Promise.resolve().then(() => patchNoteSection(db, versionId, 'Overview', 'Overview content.')),
      Promise.resolve().then(() => patchNoteSection(db, versionId, 'Wait Times', 'Wait times content.')),
      Promise.resolve().then(() => patchNoteSection(db, versionId, 'Maps', 'Maps content.')),
      Promise.resolve().then(() => patchNoteSection(db, versionId, 'Secrets', 'Secrets content.')),
    ]);

    const note = getNote(db, versionId);
    expect(note).toContain('## Overview\nOverview content.');
    expect(note).toContain('## Wait Times\nWait times content.');
    expect(note).toContain('## Maps\nMaps content.');
    expect(note).toContain('## Secrets\nSecrets content.');
  });
});
```

Note on the `Promise.resolve().then(...)` wrapping: `patchNoteSection` itself is synchronous (`getNote`/`setNote` are plain `better-sqlite3` calls, no `await` inside), so `Promise.all` over four plain synchronous calls would just run them one after another in call order with no actual interleaving to test. Wrapping each in a microtask queues all four read-splice-write sequences to interleave at the microtask boundary, which is the realistic shape of "four `Sink` nodes in the same executor wave, each `await`ing before calling the (synchronous) write function" — this is what actually exercises the no-await-between-read-and-write property instead of trivially passing because nothing was ever concurrent.

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run backend/services/apk-notes.test.ts -t "concurrent patchNoteSection"`
Expected: PASS — this is a regression pin on existing, correct behavior, not a new feature; if it fails, that's a real bug in `apk-notes.ts` to fix before continuing, not a sign this test is wrong.

- [ ] **Step 3: Commit**

```bash
git add backend/services/apk-notes.test.ts
git commit -m "test(ai-jobs): pin the concurrent patchNoteSection no-lost-update invariant"
```

---

## Phase D: REST API

### Task 19: `/v1/ai-pipelines` endpoints — CRUD, publish, run, run status

**Files:**
- Create: `backend/api/ai-pipelines.ts`
- Create: `backend/api/ai-pipelines.test.ts`
- Modify: `backend/index.ts` (register the new endpoints, same place `registerJobEndpoints`/other `register*Endpoints` calls live)

**Interfaces:**
- Consumes: `validateGraph` (Task 12), `runPipeline` (Tasks 13–17), `aiPipelines`/`aiPipelineVersions`/`aiPipelineRuns`/`aiPipelineNodeRuns` (Task 1).
- Produces: `registerAiPipelineEndpoints(deps: AiPipelineDeps): void` where `AiPipelineDeps = { db: AppDatabase; executors: NodeExecutors; buildCtx: (identity, input: Record<string, unknown>) => ExecutionCtx }` — `buildCtx` derives the run's identity from the authenticated request, not a fixed core-service identity, matching `triggerAiAgentManual`'s existing per-user-identity pattern.

Routes (scopes match `patch_analysis_section`/`read_analysis_notes`'s existing `core.apk:manage`/`core.apk:read`, per Global Constraints):
- `GET /v1/ai-pipelines` — list; each row includes its published (or latest draft) version's `graph` inline, since the frontend canvas needs it on first load and there's no sibling "get one pipeline" endpoint in this plan to fetch it separately (`core.apk:read`)
- `POST /v1/ai-pipelines` — create a pipeline + its first draft version (`core.apk:manage`)
- `POST /v1/ai-pipelines/:id/versions` — add a new draft version (`core.apk:manage`)
- `POST /v1/ai-pipelines/:id/publish` — validates the latest draft version via `validateGraph`, 400s with the validation errors if invalid, else flips it to `published` (`core.apk:manage`)
- `POST /v1/ai-pipelines/:id/run` — body `{ triggerNodeId, input, reuseUnchanged? }`; **rejects with 409 if a `running` row already exists for this pipeline's current published version** (Review Focus: cross-run concurrency) — otherwise inserts a `running` `aiPipelineRuns` row, calls `runPipeline`, persists every `NodeRunResult` as an `aiPipelineNodeRuns` row, updates the run row to its final status (`core.apk:manage`)
- `GET /v1/ai-pipelines/runs/:runId` — status + every node-run row (`core.apk:read`)

- [ ] **Step 1: Write the failing test for the 409 concurrency guard (Review Focus item) and the GET list's inlined graph**

```ts
// backend/api/ai-pipelines.test.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import * as schema from '../db/schema';
import { registerAiPipelineEndpoints } from './ai-pipelines';
// Use the project's existing REST-over-WebSocket or supertest-style harness for api-service.ts
// routes — grep an existing *.test.ts in backend/api/ for the pattern (e.g. apk-availability.test.ts)
// and reuse it rather than inventing a new way to exercise registerEndpoint-registered routes.

describe('GET /v1/ai-pipelines', () => {
  it('includes each pipeline\'s published version graph inline, not just the bare pipeline row', async () => {
    // Arrange: one pipeline with a draft v1 and a published v2 (different graphs).
    // Act: GET /v1/ai-pipelines.
    // Assert: the row's `graph` equals v2's graph (the published one), not v1's, and
    // `pipelineVersionId` equals v2's id — a pipeline with no published version at all falls
    // back to its latest draft instead of returning `graph: null` and leaving the canvas empty.
  });
});

describe('POST /v1/ai-pipelines/:id/run — concurrency guard', () => {
  it('rejects a second run with 409 while one is already running for the same pipeline', async () => {
    // Arrange: a published pipeline version, and an aiPipelineRuns row already `status: 'running'`
    // for it. Act: POST /v1/ai-pipelines/:id/run. Assert: 409, body.error mentions "already running",
    // and runPipeline (the executor) is never actually invoked for the rejected request.
  });

  it('accepts a run once the prior one has finished (status is ok/partial/failed, not running)', async () => {
    // Same setup, but the existing row's status is 'ok'. Assert: 200, a new row created.
  });

  it('infers triggerNodeId when the published version has exactly one Trigger and the request omits it', async () => {
    // A published version with one Trigger, POST /run with no triggerNodeId in the body.
    // Assert: 200, and the aiPipelineRuns row's triggerNodeId column was set to that one Trigger's id.
  });

  it('rejects with 400 when triggerNodeId is omitted and the version has more than one Trigger', async () => {
    // A published version with two Triggers (same shape as ASTERIX_PATTERN_GRAPH), POST /run with no
    // triggerNodeId. Assert: 400, body.error mentions how many Trigger nodes exist.
  });

  it('rejects with 400 when triggerNodeId is supplied but does not name a real Trigger node', async () => {
    // POST /run with triggerNodeId: 'agent-overview' (a real node, but not a Trigger). Assert: 400.
  });
});
```

Fill in the two test bodies using the harness pattern found by grepping `backend/api/apk-availability.test.ts` (or whichever sibling test file turns out to exercise `registerEndpoint`-registered routes most directly) — this plan intentionally doesn't fabricate the exact request-dispatch helper names here since getting them from a real neighboring test is more reliable than guessing them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/api/ai-pipelines.test.ts`
Expected: FAIL — module `./ai-pipelines` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// backend/api/ai-pipelines.ts
import { eq, and } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiPipelines, aiPipelineVersions, aiPipelineRuns, aiPipelineNodeRuns } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { validateGraph } from '../services/ai-jobs/graph-validator';
import { runPipeline, type NodeExecutors, type ExecutionCtx } from '../services/ai-jobs/pipeline-runner';
import type { PipelineGraph } from '../services/ai-jobs/types';

export interface AiPipelineDeps {
  db: AppDatabase;
  executors: NodeExecutors;
  /** `identity` comes from the authenticated request (req.authUser), not a fixed core-service identity —
   * a manual run from the editor runs as the clicking user, same as `triggerAiAgentManual` does today. */
  buildCtx: (identity: { type: 'core-service' } | { type: 'user'; userId: number }, input: Record<string, unknown>) => ExecutionCtx;
}

export function registerAiPipelineEndpoints(deps: AiPipelineDeps): void {
  const { db } = deps;

  registerEndpoint('GET', '/v1/ai-pipelines', (req, res) => {
    // Task 22's frontend reads `apkPipeline.graph` straight off a row from this endpoint — the
    // pre-flight scan caught that a bare `aiPipelines` select has no graph column at all (it
    // lives on `aiPipelineVersions`), which would leave the canvas stuck on its loading state
    // against the real server even though Task 22's own test (mocking this response shape
    // directly) would pass. Fold each pipeline's published version (falling back to its latest
    // draft if none is published yet) in here instead of adding a second round-trip.
    const rows = db.select().from(aiPipelines).all();
    const data = rows.map((row) => {
      const versions = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, row.id))
        .orderBy(aiPipelineVersions.version).all();
      const version = versions.find(v => v.status === 'published') ?? versions.at(-1);
      return { ...row, pipelineVersionId: version?.id ?? null, graph: version?.graph ?? null };
    });
    res.json({ success: true, data });
  }, { requires: ['core.apk:read'] });

  registerEndpoint('POST', '/v1/ai-pipelines', (req, res) => {
    const { name, jobKind, graph } = req.body as { name: string; jobKind: string; graph: PipelineGraph };
    const now = new Date();
    const pipelineId = db.insert(aiPipelines).values({ name, jobKind, createdAt: now }).run().lastInsertRowid as number;
    db.insert(aiPipelineVersions).values({ pipelineId, version: 1, graph, status: 'draft', createdAt: now }).run();
    res.json({ success: true, data: { id: pipelineId } });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('POST', '/v1/ai-pipelines/:id/versions', (req, res) => {
    const pipelineId = Number(req.params.id);
    const { graph } = req.body as { graph: PipelineGraph };
    const latest = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, pipelineId))
      .orderBy(aiPipelineVersions.version).all().pop();
    const nextVersion = (latest?.version ?? 0) + 1;
    db.insert(aiPipelineVersions).values({ pipelineId, version: nextVersion, graph, status: 'draft', createdAt: new Date() }).run();
    res.json({ success: true, data: { version: nextVersion } });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('POST', '/v1/ai-pipelines/:id/publish', (req, res) => {
    const pipelineId = Number(req.params.id);
    const latest = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, pipelineId))
      .orderBy(aiPipelineVersions.version).all().pop();
    if (!latest) { res.status(404).json({ success: false, error: 'No version to publish' }); return; }

    const errors = validateGraph(latest.graph as PipelineGraph);
    if (errors.length > 0) { res.status(400).json({ success: false, error: 'Invalid graph', errors }); return; }

    // Demote every other version back to draft first, so "published" is a true singleton per
    // pipeline — found during this task's review: without this, GET (picks the OLDEST published
    // version after an ascending sort) and /run (picks the NEWEST) disagreed about which version
    // was current the moment a second version was ever published, breaking the exact contract
    // Task 22's frontend depends on (the canvas loading one version while Run executes another).
    db.update(aiPipelineVersions).set({ status: 'draft' })
      .where(and(eq(aiPipelineVersions.pipelineId, pipelineId), eq(aiPipelineVersions.status, 'published')))
      .run();
    db.update(aiPipelineVersions).set({ status: 'published' }).where(eq(aiPipelineVersions.id, latest.id)).run();
    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('POST', '/v1/ai-pipelines/:id/run', async (req, res) => {
    const pipelineId = Number(req.params.id);
    const { input, reuseUnchanged } = req.body as { triggerNodeId?: string; input: Record<string, unknown>; reuseUnchanged?: boolean };
    let { triggerNodeId } = req.body as { triggerNodeId?: string };

    const version = db.select().from(aiPipelineVersions)
      .where(and(eq(aiPipelineVersions.pipelineId, pipelineId), eq(aiPipelineVersions.status, 'published')))
      .orderBy(aiPipelineVersions.version).all().pop();
    if (!version) { res.status(404).json({ success: false, error: 'No published version for this pipeline' }); return; }

    // Spec (API surface): "triggerNodeId required once a version has more than one Trigger,
    // optional and inferred when it has exactly one." The first draft of this handler never
    // implemented that — it just passed whatever the body sent straight to runPipeline, which
    // (before the validation fix above) would silently no-op on undefined. Implement it for real.
    const graphForTriggerCheck = version.graph as PipelineGraph;
    const triggerNodes = graphForTriggerCheck.nodes.filter(n => n.config.kind === 'Trigger');
    if (!triggerNodeId) {
      if (triggerNodes.length !== 1) {
        res.status(400).json({ success: false, error: `triggerNodeId is required — this pipeline version has ${triggerNodes.length} Trigger nodes, not exactly one` });
        return;
      }
      triggerNodeId = triggerNodes[0].id;
    } else if (!triggerNodes.some(n => n.id === triggerNodeId)) {
      res.status(400).json({ success: false, error: `"${triggerNodeId}" is not a Trigger node in this pipeline version` });
      return;
    }

    const alreadyRunning = db.select().from(aiPipelineRuns)
      .where(and(eq(aiPipelineRuns.pipelineVersionId, version.id), eq(aiPipelineRuns.status, 'running')))
      .all()[0];
    if (alreadyRunning) {
      res.status(409).json({ success: false, error: `A run is already in progress for this pipeline version (run ${alreadyRunning.id})` });
      return;
    }

    const now = new Date();
    const runId = db.insert(aiPipelineRuns).values({
      pipelineVersionId: version.id, triggerNodeId, triggeredBy: 'manual',
      input, reuseUnchanged: !!reuseUnchanged, status: 'running', startedAt: now,
    }).run().lastInsertRowid as number;

    const graph = version.graph as PipelineGraph;
    let priorNodeRuns: Record<string, { inputHash: string; output: Record<string, unknown> }> | undefined;
    if (reuseUnchanged) {
      priorNodeRuns = {};
      // Ascending by id, so a later (more recent) run's node output always overwrites an earlier
      // one's in the loop below — relying on unordered default row-scan order "worked" on
      // better-sqlite3's rowid scan in practice but wasn't a guaranteed contract (plan review).
      const priorRuns = db.select().from(aiPipelineRuns).where(eq(aiPipelineRuns.pipelineVersionId, version.id)).orderBy(aiPipelineRuns.id).all();
      for (const priorRun of priorRuns) {
        const priorNodes = db.select().from(aiPipelineNodeRuns)
          .where(and(eq(aiPipelineNodeRuns.runId, priorRun.id), eq(aiPipelineNodeRuns.status, 'ok')))
          .all();
        for (const nr of priorNodes) {
          if (nr.inputHash && nr.output) priorNodeRuns[nr.nodeId] = { inputHash: nr.inputHash, output: nr.output };
        }
      }
    }

    const identity = req.authUser
      ? { type: 'user' as const, userId: req.authUser.userId } // AuthUser (backend/auth/middleware.ts:9-18) has userId, not actorUserId — that field belongs to the unrelated AgentIdentity type; plan review caught this, as-written every manual run threw "forUser: user undefined not found"
      : { type: 'core-service' as const }; // defensive fallback — registerEndpoint's scope check already requires an authUser for a core.apk:manage route, this branch should be unreachable in practice
    // Wrapped in try/catch — found during this task's review: without this, any throw between
    // inserting the 'running' row above and finalizing it (buildCtx, runPipeline itself, or a
    // node-run insert) left the row stuck in 'running' forever, and the 409 guard above then
    // permanently blocked every future /run for this version, with no way to clear it short of a
    // direct DB edit. Task 20's real buildCtx does a DB lookup by versionId that could plausibly
    // throw, so this isn't theoretical.
    try {
      const result = await runPipeline(graph, triggerNodeId, input, deps.executors, deps.buildCtx(identity, input), { reuseUnchanged, priorNodeRuns });

      for (const nodeResult of result.nodes) {
        db.insert(aiPipelineNodeRuns).values({
          runId, nodeId: nodeResult.nodeId, status: nodeResult.status,
          output: nodeResult.output, error: nodeResult.error,
          // inputHash must be persisted here, not just wasMemoized — found during Task 17's review:
          // the loader just above (priorNodeRuns[nr.nodeId] = {inputHash: nr.inputHash, ...}) filters
          // on `nr.inputHash && nr.output`, so without writing it here, priorNodeRuns is ALWAYS empty
          // on every later run and the whole memoization feature can never fire even once in
          // production, regardless of whether reuseUnchanged is set. Task 17's executor now computes
          // and returns inputHash for every memoizable-kind node unconditionally (not only when
          // reuseUnchanged is true), specifically so a run with reuse OFF still seeds the cache for
          // a later run that turns it on.
          inputHash: nodeResult.inputHash,
          wasMemoized: !!nodeResult.wasMemoized, startedAt: now, finishedAt: new Date(),
        }).run();
      }
      db.update(aiPipelineRuns).set({ status: result.status, finishedAt: new Date() }).where(eq(aiPipelineRuns.id, runId)).run();

      res.json({ success: true, data: { runId, status: result.status } });
    } catch (err) {
      db.update(aiPipelineRuns).set({ status: 'failed', finishedAt: new Date() }).where(eq(aiPipelineRuns.id, runId)).run();
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('GET', '/v1/ai-pipelines/runs/:runId', (req, res) => {
    const runId = Number(req.params.runId);
    const run = db.select().from(aiPipelineRuns).where(eq(aiPipelineRuns.id, runId)).all()[0];
    if (!run) { res.status(404).json({ success: false, error: 'Run not found' }); return; }
    const nodes = db.select().from(aiPipelineNodeRuns).where(eq(aiPipelineNodeRuns.runId, runId)).all();
    res.json({ success: true, data: { run, nodes } });
  }, { requires: ['core.apk:read'] });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/api/ai-pipelines.test.ts`
Expected: PASS

- [ ] **Step 5: Add the `// TODO(Task 20)` placeholder in `backend/index.ts`**

`buildApkAnalysisExecutors`/`buildApkAnalysisExecutionCtx` don't exist until Task 20 — this step adds the registration call **commented out**, so this task's own build stays green in isolation. Near the other `register*Endpoints(...)` calls (e.g. `registerJobEndpoints(jobRegistry)` at line 768):

```ts
import { registerAiPipelineEndpoints } from './api/ai-pipelines';
// ...
// TODO(Task 20): uncomment once buildApkAnalysisExecutors/buildApkAnalysisExecutionCtx exist.
// registerAiPipelineEndpoints({
//   db,
//   executors: buildApkAnalysisExecutors(),
//   buildCtx: (identity, input) => buildApkAnalysisExecutionCtx({ db, aiFactory, identity, versionId: input.versionId as number }),
// });
```

**This plan runs its tasks in order, so Task 20 below carries an explicit step that comes
back and finishes this — do not treat the TODO as done once it's merely written.** The
pre-flight scan caught that the original draft of this plan left this as a dangling
TODO with no task ever assigned to close it, which would have meant the REST API is
never actually reachable on a running server even after every task "passes."

- [ ] **Step 6: Commit**

```bash
git add backend/api/ai-pipelines.ts backend/api/ai-pipelines.test.ts backend/index.ts
git commit -m "feat(ai-jobs): REST API — CRUD, publish (validated), run (409 on concurrent), run status"
```

---

## Phase E: The Astérix pipeline + migration off the old loop

### Task 20: Wire the `NodeExecutors` map + define the Astérix pipeline graph as data

**Files:**
- Create: `backend/services/ai-jobs/apk-analysis-pipeline.ts`
- Create: `backend/services/ai-jobs/apk-analysis-pipeline.test.ts`
- Modify: `backend/index.ts` (seed the pipeline at boot, and complete Task 19's commented-out `registerAiPipelineEndpoints` wiring — Step 6 below)

**Interfaces:**
- Consumes: every `nodes/*.ts` file (Tasks 4, 6–11), `runPipeline`/`NodeExecutors`/`ExecutionCtx` (Tasks 13–17), `registerAiPipelineEndpoints`/`AiPipelineDeps` (Task 19).
- Produces: `buildApkAnalysisExecutors(): NodeExecutors`, `buildApkAnalysisExecutionCtx(deps: { db: AppDatabase; aiFactory: AiAgentFactory; identity: 'core-service' | { userId: number } }, triggerNodeId: string): ExecutionCtx`, `ASTERIX_PATTERN_GRAPH: PipelineGraph` (the literal worked-example graph from the spec — this is the actual pipeline definition seeded for `apk-analysis`, not a test fixture, even though it lives next to its own test file), `seedApkAnalysisPipeline(db): void`.

- [ ] **Step 1: Write the failing test — the graph itself passes validation and has the right shape**

```ts
// backend/services/ai-jobs/apk-analysis-pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { ASTERIX_PATTERN_GRAPH, buildApkAnalysisExecutors } from './apk-analysis-pipeline';
import { validateGraph } from './graph-validator';
import { runPipeline } from './pipeline-runner';

describe('ASTERIX_PATTERN_GRAPH', () => {
  it('passes graph validation — two disjoint Trigger zones, consistent schema, valid Report sections', () => {
    expect(validateGraph(ASTERIX_PATTERN_GRAPH)).toEqual([]);
  });

  it('has exactly two Triggers, eight AgentCalls (7 Group-A/B + agent-diff), one Report, two Sinks', () => {
    // Found during this task's review: the brief's own earlier draft asserted 7 AgentCalls,
    // contradicting the very graph it specifies below — 7 Group-A/B nodes feed the Report, but
    // 'agent-diff' (Quick Rescan's own AgentCall) is an 8th. The Report still declares exactly
    // 7 sections; that count is unaffected.
    const kinds = ASTERIX_PATTERN_GRAPH.nodes.map(n => n.config.kind);
    expect(kinds.filter(k => k === 'Trigger')).toHaveLength(2);
    expect(kinds.filter(k => k === 'AgentCall')).toHaveLength(8);
    expect(kinds.filter(k => k === 'Report')).toHaveLength(1);
    expect(kinds.filter(k => k === 'Sink')).toHaveLength(2);
  });

  it('the Report node declares its 7 sections in the spec\'s stated order', () => {
    const report = ASTERIX_PATTERN_GRAPH.nodes.find(n => n.config.kind === 'Report')!;
    const titles = (report.config as { sections: Array<{ title: string }> }).sections.map(s => s.title);
    expect(titles).toEqual(['Overview', 'Wait Times', 'Opening Hours', 'Maps', 'Secrets', 'cURL Examples', 'Bypass Script']);
  });

  it('runs end to end against mocked executors with the Full Analysis trigger, Bypass Script failing', async () => {
    const executors = buildApkAnalysisExecutors();
    // Spy-override just the AgentCall and Sink entries with fakes, leaving Trigger/Transform/Branch/
    // Report/ForEach as their real implementations — this is the one test that exercises the real
    // Report assembly + real Sink writes against an in-memory DB, not just mocks throughout.
    // ...see Task 1/4/11's fixtures for the in-memory db + seeded apk_versions row pattern...
  });
});
```

Flesh out the fourth test's body once writing this task for real: build an in-memory DB seeded the way Task 4's and Task 11's tests already do, override only `buildApkAnalysisExecutors()`'s `AgentCall` entry with a fake that fails for the node whose `config.instructionTemplate` contains `'SSL pinning'` (the Bypass Script node's real template, defined in this same task) and succeeds otherwise, run `runPipeline(ASTERIX_PATTERN_GRAPH, '<full-analysis-trigger-id>', { versionId }, executors, ctx)`, then assert `result.status === 'partial'` and that `getNote(db, versionId)` contains a `## Bypass Script` section with "unavailable this run" in it alongside six real sections.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/ai-jobs/apk-analysis-pipeline.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the graph + executor wiring**

```ts
// backend/services/ai-jobs/apk-analysis-pipeline.ts
import type { PipelineGraph } from './types';
import type { NodeExecutors, ExecutionCtx } from './pipeline-runner';
import { TRIGGER_REGISTRY } from './nodes/trigger';
import { runAgentCall } from './nodes/agent-call';
import { runTransform } from './nodes/transform';
import { runBranch } from './nodes/branch';
import { runReport } from './nodes/report';
import { runForEach } from './nodes/foreach';
import { runSink } from './nodes/sink';
import type { AiAgentFactory } from '../ai-agent-factory';
import type { AppDatabase } from '../../db/index';

const APK_CONTEXT_SCHEMA = [
  { field: 'appName', type: 'string', description: 'Display name' },
  { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
  { field: 'versionName', type: 'string', description: 'Human version string' },
  { field: 'versionCode', type: 'number', description: 'Numeric version code' },
  { field: 'fileSizeBytes', type: 'number', description: 'APK file size in bytes' },
  { field: 'downloadedAt', type: 'string', description: 'ISO timestamp' },
  { field: 'source', type: 'string', description: "'device' | 'playstore' | 'qq' | 'upload'" },
];

const GROUP_A_TOOLS = ['get_apk_overview', 'get_apk_strings', 'list_apk_assets', 'get_app_versions', 'search_apk_code', 'find_api_endpoints', 'get_api_endpoint', 'get_map_config'];
const GROUP_B_TOOLS = ['search_credentials', 'search_apk_code', 'get_apk_strings', 'find_api_endpoints', 'get_api_endpoint', 'list_api_endpoints', 'detect_ssl_pinning', 'generate_ssl_bypass', 'inspect_class_methods'];

export const ASTERIX_PATTERN_GRAPH: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: APK_CONTEXT_SCHEMA } },
    { id: 'trigger-rescan', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: APK_CONTEXT_SCHEMA } },

    { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Analyze {{trigger.appName}} ({{trigger.packageName}}) version {{trigger.versionName}}. Summarize purpose, framework, permissions and notable SDKs.' } },
    { id: 'agent-wait-times', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Find how {{trigger.appName}} fetches ride wait times. Search for queue, wait and attraction-status endpoints.' } },
    { id: 'agent-opening-hours', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Find how {{trigger.appName}} v{{trigger.versionName}} fetches park opening hours and schedule data.' } },
    { id: 'agent-maps', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Describe the map system in {{trigger.packageName}}: offline tiles, bounds, or a live tile provider.' } },
    { id: 'agent-secrets', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: 'Document every hardcoded secret, API key and token in {{trigger.packageName}} v{{trigger.versionName}}, with file location.' } },
    { id: 'agent-curl', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: "Write runnable curl examples for {{trigger.appName}}'s discovered API endpoints, using the real extracted keys." } },
    { id: 'agent-bypass', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: 'Write a Frida script bypassing SSL pinning in {{trigger.packageName}} v{{trigger.versionName}}.' } },

    { id: 'report', config: { kind: 'Report', sections: [
      { title: 'Overview', from: 'agent-overview' },
      { title: 'Wait Times', from: 'agent-wait-times' },
      { title: 'Opening Hours', from: 'agent-opening-hours' },
      { title: 'Maps', from: 'agent-maps' },
      { title: 'Secrets', from: 'agent-secrets' },
      { title: 'cURL Examples', from: 'agent-curl' },
      { title: 'Bypass Script', from: 'agent-bypass' },
    ] } },
    // Both Sinks declare `from` — the executor wraps even a single predecessor's output by its
    // node id (Tasks 13-17), so a write function needs to be told which key to unwrap. See the
    // SDD pre-flight fix to SinkConfig (Task 2) and sink.ts (Task 11).
    { id: 'sink-report', config: { kind: 'Sink', writeFn: 'apk-analysis/write-full-document', from: 'report' } },

    { id: 'agent-diff', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: ['get_app_versions', 'search_apk_findings'], instructionTemplate: 'Compare {{trigger.appName}} v{{trigger.versionName}} against the previously analyzed version. Summarize what changed — new endpoints, new permissions, new SDKs.' } },
    { id: 'sink-diff', config: { kind: 'Sink', writeFn: 'apk-analysis/write-section', from: 'agent-diff', section: 'Diff Summary' } },
  ],
  edges: [
    ...['agent-overview', 'agent-wait-times', 'agent-opening-hours', 'agent-maps', 'agent-secrets', 'agent-curl', 'agent-bypass']
      .map(agentId => ({ from: 'trigger-full', to: agentId })),
    ...['agent-overview', 'agent-wait-times', 'agent-opening-hours', 'agent-maps', 'agent-secrets', 'agent-curl', 'agent-bypass']
      .map(agentId => ({ from: agentId, to: 'report' })),
    { from: 'report', to: 'sink-report' },
    { from: 'trigger-rescan', to: 'agent-diff' },
    { from: 'agent-diff', to: 'sink-diff' },
  ],
};

export type ApkAnalysisIdentity = { type: 'core-service' } | { type: 'user'; userId: number };

export function buildApkAnalysisExecutors(): NodeExecutors {
  return {
    Trigger: async (config, rawInput, ctx) => {
      const expand = TRIGGER_REGISTRY[config.expandFn];
      if (!expand) throw new Error(`Unknown trigger expander "${config.expandFn}"`);
      return expand(rawInput, { db: (ctx as { db: AppDatabase }).db });
    },
    // Binds its OWN BoundAgent, per node, using this node's own config.tier — the whole point of
    // "one tier per AgentCall, no shared research/write pair" (spec, Architecture). A single
    // agent bound once for the entire run and reused by every node would silently defeat that:
    // every node would run on whatever tier the FIRST bind happened to use, regardless of its own
    // declared config.tier. Astérix's seven nodes all happen to declare "High" today, which is
    // exactly the kind of coincidence that hides this bug until a second pipeline uses two tiers.
    AgentCall: async (config, input, ctx) => {
      const c = ctx as { aiFactory: import('../ai-agent-factory').AiAgentFactory; identity: ApkAnalysisIdentity; contextId: string };
      const agent = c.identity.type === 'core-service'
        ? c.aiFactory.forCoreService('apk-analyzer', { tier: config.tier })
        : c.aiFactory.forUser(c.identity.userId, { tier: config.tier });
      return runAgentCall(config, input, { agent, contextId: c.contextId });
    },
    Transform: (config, input) => runTransform(config, input),
    Branch: (config, envelope) => runBranch(config, envelope),
    // Every AgentCall in this job kind returns { text: string } (Task 6) by construction, but the
    // generic NodeExecutors interface types a Report's envelopes as bare Envelope<unknown> — it
    // has no way to know a given job's AgentCall output shape. Narrowing the cast (not `as any`,
    // which hides any future shape mismatch) documents that assumption instead of erasing it.
    Report: (config, envelopes) => runReport(config, envelopes as Record<string, import('./types').Envelope<{ text: string }>>),
    ForEach: async (config, items) => runForEach(config, items),
    Sink: async (config, input, ctx) => {
      const c = ctx as { db: AppDatabase; versionId: number };
      await runSink(config, input, c);
    },
  };
}

export function buildApkAnalysisExecutionCtx(
  deps: { db: AppDatabase; aiFactory: import('../ai-agent-factory').AiAgentFactory; identity: ApkAnalysisIdentity; versionId: number },
): ExecutionCtx {
  return {
    db: deps.db,
    aiFactory: deps.aiFactory,
    identity: deps.identity,
    contextId: String(deps.versionId),
    versionId: deps.versionId,
  };
}
```

**Test to add alongside the ones in Step 1** confirming this binding actually happens per node, not once for the whole run:

```ts
it('binds a fresh BoundAgent per AgentCall node, each with that node\'s own config.tier', async () => {
  const forCoreService = vi.fn(() => ({ identity: {} as any, handleMessage: vi.fn(async (p: any) => { p.onToken('ok'); return { run: { requests: [] } }; }) }));
  const aiFactory = { forCoreService } as unknown as import('../ai-agent-factory').AiAgentFactory;
  const executors = buildApkAnalysisExecutors();
  const ctx = buildApkAnalysisExecutionCtx({ db: {} as any, aiFactory, identity: { type: 'core-service' }, versionId: 431 });

  await executors.AgentCall(ASTERIX_PATTERN_GRAPH.nodes.find(n => n.id === 'agent-overview')!.config as any, { trigger: {} }, ctx);
  await executors.AgentCall(ASTERIX_PATTERN_GRAPH.nodes.find(n => n.id === 'agent-bypass')!.config as any, { trigger: {} }, ctx);

  expect(forCoreService).toHaveBeenCalledTimes(2); // not once, reused — once per node
  expect(forCoreService).toHaveBeenCalledWith('apk-analyzer', { tier: 'High' });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run backend/services/ai-jobs/apk-analysis-pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Seed the pipeline + published version at server boot**

Add a `seedApkAnalysisPipeline(db: AppDatabase): void` function to the same file — idempotent (checks for an existing `aiPipelines` row with `jobKind: 'apk-analysis'` and name `'Astérix pattern'` before inserting), called once from `backend/index.ts` near `apkAnalyzer.start()`. Write its own small test (insert twice, assert only one `aiPipelines` row and one `published` version exist) before wiring it into `index.ts`.

- [ ] **Step 6: Finish Task 19's `registerAiPipelineEndpoints` wiring in `backend/index.ts`**

Task 19 left this commented out with a `// TODO(Task 20)` note because `buildApkAnalysisExecutors`/`buildApkAnalysisExecutionCtx` didn't exist yet. They do now — uncomment it and fix the one name that was never real (`aiJobExecutors` was always a placeholder, not an actual export anywhere). **Do not uncomment it in place.** Found during this task's own review: the original TODO comment sits right after `registerJobEndpoints(jobRegistry)`, which comes BEFORE `const aiFactory = new AiAgentFactory(...)` is declared further down the same top-level script — uncommenting there would throw a TDZ `ReferenceError` on every server boot. Move the call to immediately after `aiFactory` is constructed and its core identities registered (e.g. right after `apkDiffEngine.setAiFactory(aiFactory)`, wherever that real line currently sits — re-grep it fresh, don't trust a stale line number), where both `aiFactory` and `db` are genuinely in scope:

```ts
registerAiPipelineEndpoints({
  db,
  executors: buildApkAnalysisExecutors(),
  buildCtx: (identity, input) => buildApkAnalysisExecutionCtx({ db, aiFactory, identity, versionId: input.versionId as number }),
});
```

Add the import: `import { buildApkAnalysisExecutors, buildApkAnalysisExecutionCtx, seedApkAnalysisPipeline, ASTERIX_PATTERN_GRAPH } from './services/ai-jobs/apk-analysis-pipeline';` (consolidate with whatever Step 5 already added for the seeding call, don't duplicate the import line). Confirm `aiFactory` and `db` are both in scope at this call site (they are — `aiFactory.registerCoreIdentity` already runs near here per the existing boot sequence). Without this step, `/v1/ai-pipelines` is never actually reachable on a running server, Task 22-25's frontend work has nothing real to call, and Task 25's e2e spec fails against the live backend even though every unit test up to this point is green — the TODO text from Task 19 is not a suggestion, it's a dependency on this exact step.

- [ ] **Step 7: Run the full backend test suite, confirm no regression, then commit**

Run: `npx vitest run`
Expected: PASS — every existing test, plus everything from Tasks 1-20.

```bash
git add backend/services/ai-jobs/apk-analysis-pipeline.ts backend/services/ai-jobs/apk-analysis-pipeline.test.ts backend/index.ts
git commit -m "feat(ai-jobs): define the Astérix pattern pipeline, wire executors + REST endpoints, seed it at boot"
```

### Task 21: Migrate `apk-analyzer.ts` off the old loop, behind a setting

**Files:**
- Modify: `backend/services/apk-analyzer.ts` (the `runAiAgent` method, called from `triggerAiAgentAuto`/`triggerAiAgentManual`)
- Modify: `backend/services/apk-analyzer.test.ts`
- Modify: `backend/index.ts` (extend the `apkAnalyzer.setAiConfig(...)` call site, or add a sibling `setPipelinesEnabled(...)` setter — match whichever is the smaller diff once Step 1's grep shows the real current call)

**Interfaces:**
- Consumes: `runPipeline`, `buildApkAnalysisExecutors`, `buildApkAnalysisExecutionCtx` (Task 20), `aiPipelines`/`aiPipelineVersions` (Task 1).

**Design correction made before this task was dispatched (raised when Cube asked how the
APK service points at the pipeline it runs):** the graph a real run executes must come from
the DB's current *published* version for the `apk-analysis` job kind, never a hardcoded
`ASTERIX_PATTERN_GRAPH` import. `ASTERIX_PATTERN_GRAPH` (Task 20) is still real — it's the
literal graph `seedApkAnalysisPipeline` inserts into the DB at boot, and what the executor's
own tests exercise directly — but a running server has to follow whatever was last published
through the `/ui/pipelines` editor (Tasks 22-24), not freeze at server-start. Importing the
constant directly here, as an earlier draft of this task did, would mean every edit made in
the UI and published has zero effect on real auto/manual-triggered runs — silently defeating
the entire point of shipping an editable pipeline tool.

- [ ] **Step 1: Write the failing test**

Grep `backend/services/apk-analyzer.test.ts` first for how `runAiAgent`/`triggerAiAgentAuto` are currently tested (a mock `aiFactory`/`BoundAgent` fixture already exists there — reuse it, this task adds one new describe block, not a parallel harness).

```ts
// append to apk-analyzer.test.ts
describe('AI notes generation — pipeline path', () => {
  it('calls runPipeline with the DB\'s published apk-analysis graph, not a hardcoded constant, when ai_pipelines_enabled is true', async () => {
    const runPipelineSpy = vi.fn(async () => ({ status: 'ok', nodes: [] }));
    // Seed an aiPipelines row (jobKind: 'apk-analysis') and TWO aiPipelineVersions rows on the
    // test db: an older 'published' one with a distinguishable graph, and seed it as the ONLY
    // published row. Construct the ApkAnalyzerService the way the rest of this file already
    // does, but with setPipelinesEnabled(() => true) (or whichever setter Step 3 below actually
    // adds) and the runPipeline call point injected/mocked — adapt to this file's existing DI
    // pattern (setAiConfig takes closures; whatever this task adds should match that shape).

    analyzer.triggerAiAgentManual(431, userId);
    await flushMicrotasks(); // match whatever async-flush helper this test file already uses, if any

    expect(runPipelineSpy).toHaveBeenCalled();
    // Assert the graph argument runPipeline received is the SEEDED published version's graph
    // (deep-equal it, or at minimum assert it is NOT referentially the imported
    // ASTERIX_PATTERN_GRAPH constant) — this is the test that would have caught the original
    // hardcoded-import draft of this task.
  });

  it('keeps calling agent.handleMessage directly when ai_pipelines_enabled is false (the default)', async () => {
    // Same setup, setPipelinesEnabled(() => false). Assert the OLD path still runs —
    // this is the one test in this task that must never break across the rollout window.
  });

  it('logs and does not throw out of the request handler when no published apk-analysis pipeline row exists', async () => {
    // setPipelinesEnabled(() => true), but don't seed any aiPipelines/aiPipelineVersions row.
    // This should only ever happen if Task 20's seedApkAnalysisPipeline never ran — still,
    // triggerAiAgentManual must not throw synchronously into its caller; the failure belongs in
    // the same activeAiAgentRuns-tracked async path as any other run failure.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/services/apk-analyzer.test.ts -t "pipeline path"`
Expected: FAIL — there's no `ai_pipelines_enabled` branch in `runAiAgent` yet.

- [ ] **Step 3: Branch `runAiAgent` on the new setting**

In `apk-analyzer.ts`, add a `getPipelinesEnabled?: () => boolean` field next to the existing `getAiPrompt`/`getAiAutorun`/`getTierConfig` closures (same constructor-injection shape — find their declarations via `grep -n "getAiPrompt\|getAiAutorun\|getTierConfig" backend/services/apk-analyzer.ts` and add the new one right beside them, plus a `setPipelinesEnabled(fn)` method mirroring whatever `setAiConfig` already does for the other three).

`runAiAgent` takes an already-bound `agent: BoundAgent` today (bound once, no tier option, by `triggerAiAgentAuto`/`triggerAiAgentManual` before calling it) — fine for the old path's single `handleMessage` call, wrong for the pipeline path, which needs to rebind a fresh `BoundAgent` **per `AgentCall` node** using that node's own `config.tier` (Task 20's fix). So `runAiAgent` needs an `identity` descriptor threaded through from its two callers, not just the pre-bound `agent` — add a parameter rather than trying to recover identity from the already-bound agent:

```ts
// triggerAiAgentAuto's existing `agent = this.aiFactory.forCoreService('apk-analyzer')` call stays
// (the old path still needs it) — add the identity descriptor alongside it:
this.runAiAgent(versionId, agent, { type: 'core-service' });

// triggerAiAgentManual's existing `agent = this.aiFactory.forUser(userId)` call stays too:
this.runAiAgent(versionId, agent, { type: 'user', userId });
```

```ts
private runAiAgent(
  versionId: number,
  agent: import('./ai-agent-factory').BoundAgent,
  identity: { type: 'core-service' } | { type: 'user'; userId: number },
): void {
  if (this.activeAiAgentRuns.has(versionId)) {
    log(`AI agent already running for version ${versionId}, skipping`);
    return;
  }
  this.activeAiAgentRuns.add(versionId);
  broadcastToAll({ type: 'apk:ai-agent-update', versionId, status: 'running' });
  log(`Starting AI agent for version ${versionId}`);

  if (this.getPipelinesEnabled?.()) {
    this.runAiPipeline(versionId, identity).finally(() => this.activeAiAgentRuns.delete(versionId));
    return;
  }

  // ...existing agent.handleMessage({...}) call, unchanged below this point — still uses the
  // pre-bound `agent` parameter, which stays exactly as it is today for this path...
}

private async runAiPipeline(
  versionId: number,
  identity: { type: 'core-service' } | { type: 'user'; userId: number },
): Promise<void> {
  const { buildApkAnalysisExecutors, buildApkAnalysisExecutionCtx } =
    await import('./ai-jobs/apk-analysis-pipeline');
  const { runPipeline } = await import('./ai-jobs/pipeline-runner');
  const { aiPipelines, aiPipelineVersions } = await import('../db/schema');
  const { eq, and, desc } = await import('drizzle-orm');

  // The graph comes from the DB's published version for this job kind, never the
  // ASTERIX_PATTERN_GRAPH constant directly — see the design-correction note above this task.
  const pipeline = this.db.select().from(aiPipelines).where(eq(aiPipelines.jobKind, 'apk-analysis')).all()[0];
  if (!pipeline) {
    log(`AI pipeline for version ${versionId}: no apk-analysis pipeline row found — did seedApkAnalysisPipeline run at boot?`);
    broadcastToAll({ type: 'apk:ai-agent-update', versionId, status: 'failed' });
    return;
  }
  const version = this.db.select().from(aiPipelineVersions)
    .where(and(eq(aiPipelineVersions.pipelineId, pipeline.id), eq(aiPipelineVersions.status, 'published')))
    .orderBy(desc(aiPipelineVersions.version)).all()[0];
  if (!version) {
    log(`AI pipeline for version ${versionId}: pipeline "${pipeline.name}" (id ${pipeline.id}) has no published version`);
    broadcastToAll({ type: 'apk:ai-agent-update', versionId, status: 'failed' });
    return;
  }

  const triggerNodeId = 'trigger-full'; // auto/manual re-analysis both use the Full Analysis entry point
  const result = await runPipeline(
    version.graph as import('./ai-jobs/types').PipelineGraph, triggerNodeId, { versionId },
    buildApkAnalysisExecutors(),
    buildApkAnalysisExecutionCtx({ db: this.db, aiFactory: this.aiFactory!, identity, versionId }),
  );

  // Scope gap, stated plainly rather than silently absorbed: `frontend/pages/ApkAnalysis.tsx:400`
  // types `msg.status` as the literal union 'running' | 'completed' | 'failed' — there is no
  // 'partial' value this event can carry without widening that union and updating the page to
  // render it distinctly, and this task doesn't do either. A `partial` run (say, Bypass Script
  // failed but the other six sections landed with Report's placeholder) broadcasts as plain
  // "completed" on the one surface an analyst actually watches during a run — which quietly
  // undercuts the spec's own stated motivation ("zero silent gaps") on exactly that surface.
  // Real, valuable follow-up work; out of scope for this task. See Open Questions.
  broadcastToAll({ type: 'apk:ai-agent-update', versionId, status: result.status === 'failed' ? 'failed' : 'completed' });
  log(`AI pipeline completed for version ${versionId}: ${result.status}`);
}
```

Adjust field/method names to whatever Step 1's grep actually finds — the shape above (one more closure, one more branch at the top of the existing method) is the real constraint; exact identifiers depend on the file as it stands at execution time, not as summarized in this plan.

- [ ] **Step 4: Wire the setting in `backend/index.ts`**

Next to the existing `apkAnalyzer.setAiConfig(...)` call (found in Task-research as lines 593–604):

```ts
apkAnalyzer.setPipelinesEnabled(() => {
  const row = db.select().from(settings).where(eq(settings.key, 'ai_pipelines_enabled')).all()[0];
  return row?.value === 'true'; // default false — opt in deliberately, per the spec's rollout plan
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run backend/services/apk-analyzer.test.ts`
Expected: PASS — including every pre-existing test in the file, unmodified, since the default (`ai_pipelines_enabled` unset) keeps the old path.

- [ ] **Step 6: Commit**

```bash
git add backend/services/apk-analyzer.ts backend/services/apk-analyzer.test.ts backend/index.ts
git commit -m "feat(ai-jobs): migrate apk-analyzer to the pipeline executor behind ai_pipelines_enabled"
```

---

## Phase F: Frontend

A working, verified interactive mockup of this editor already exists (published during design, not part of this repo) — its visual language (dark theme tokens, node header-bar colors per kind, grid canvas background, curved SVG edges with per-section ports on `Report`, the prompt-editor variable chips, the `INACTIVE`/`CACHED` badges) is the reference to match, not to redesign from scratch. Frontend tasks below port that proven interaction design into real, data-driven React components against the real REST API from Phase D, rather than inventing the UI fresh.

### Task 22: `@xyflow/react` dependency + route + canvas rendering a real pipeline version

**Files:**
- Modify: `package.json` (add `@xyflow/react`, pin an exact version ≥2 weeks old at execution time — check npm for the current latest and pick accordingly, don't hardcode a version from spec-writing time into installed `package.json` without checking it still resolves)
- Create: `frontend/pages/ai-jobs/AiJobsWorkspace.tsx`
- Create: `frontend/pages/ai-jobs/Canvas.tsx`
- Create: `frontend/pages/ai-jobs/testing.tsx` (fixture builders + mock ws, same shape as `frontend/pages/plugins/testing.tsx`)
- Create: `frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx`
- Modify: `frontend/App.tsx` (add the route as a **top-level** route, not nested under `settings`)
- Modify: `frontend/components/layout/AppLayout.tsx` (add a top-level nav entry — **not** `SettingsSidebar.tsx`)
- Modify: `frontend/components/layout/AppLayout.test.tsx` (one-line assertion that the new nav entry renders)

**Design correction made before this task was dispatched** (Cube asked directly whether this
would get its own section "like Automations"): it does. `AppLayout.tsx`'s `CORE_NAV_GROUPS`
gives `Automations` (`/ui/automations`) its own top-level nav entry, not a line inside the
Settings page — this tool is heading the same direction (general-purpose, used for more than
APK analysis later per Cube's stated goal), so an earlier draft of this task that buried it
under Settings alongside things like notification preferences was the wrong call. Route moves
to `/ui/pipelines`, as a sibling of `automations`/`devices`/`apks` in `App.tsx`'s route list,
with a nav entry in the `'Tools'` group (next to `APKs`/`Frida`/`Plugins` in
`AppLayout.tsx:88-98`) labeled `'Pipelines'`, using the `Workflow` icon from `lucide-react`
(add it to the existing icon import block) and `requiredScope: 'core.apk:read'` (same scope
`APKs` already uses — reuse per Global Constraints, no new scope string). The internal
directory name `frontend/pages/ai-jobs/` stays as-is; only the public route/nav label change.

**Interfaces:**
- Consumes: `GET /v1/ai-pipelines` (Task 19) via the existing `useWebSocket`/`sendRestApi` pattern (same pattern as `frontend/pages/plugins/usePluginCatalog.ts` — follow it, don't reinvent).
- Produces: the `/ui/pipelines` route rendering a read-only canvas for the `apk-analysis` pipeline's published version.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/pages/ai-jobs/AiJobsWorkspace.test.tsx
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AiJobsWorkspace } from './AiJobsWorkspace';
import { createMockWs, withProviders, mockPipelineVersion } from './testing';

describe('AiJobsWorkspace', () => {
  it('renders the Trigger, AgentCall, Report and Sink nodes from the fetched pipeline', async () => {
    const ws = createMockWs({ pipelineVersion: mockPipelineVersion() });
    render(<AiJobsWorkspace />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    expect(screen.getByText('Assemble notes')).toBeInTheDocument(); // the Report node's label
    expect(screen.getAllByText(/AGENTCALL/i).length).toBeGreaterThanOrEqual(7);
  });
});
```

`mockPipelineVersion()` in `testing.tsx` returns a fixture matching `ASTERIX_PATTERN_GRAPH`'s real shape (Task 20) — build it by copying that graph's node/edge data into the fixture, not inventing a different smaller graph, so this test exercises the real shape the backend actually serves.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:frontend -- AiJobsWorkspace`
Expected: FAIL — `AiJobsWorkspace`/`Canvas`/`testing` don't exist yet.

- [ ] **Step 3: Add the dependency, the route, the nav entry, and the components**

```bash
npm install @xyflow/react@<latest-at-execution-time>
```

```tsx
// frontend/pages/ai-jobs/Canvas.tsx
import React, { useMemo } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types'; // type-only import — erased at build, no runtime coupling to backend code

const KIND_COLOR: Record<string, string> = {
  Trigger: '#2dd4bf', AgentCall: '#4d8eff', Transform: '#a78bfa',
  Branch: '#fbbf24', Report: '#818cf8', ForEach: '#f472b6', Sink: '#94a3b8',
};

export function Canvas({ graph, onSelectNode }: { graph: PipelineGraph; onSelectNode: (nodeId: string) => void }) {
  const nodes: Node[] = useMemo(() => graph.nodes.map((n, i) => ({
    id: n.id,
    position: { x: (i % 4) * 260, y: Math.floor(i / 4) * 160 }, // placeholder layout — a real force/dagre layout is a follow-up, not blocking this task's deliverable
    data: { label: `${n.config.kind}\n${n.id}` },
    style: { borderLeft: `4px solid ${KIND_COLOR[n.config.kind]}`, background: '#161f36', color: '#e4e9fb' },
  })), [graph]);

  const edges: Edge[] = useMemo(() => graph.edges.map((e, i) => ({
    id: `e${i}`, source: e.from, target: e.to, animated: false,
  })), [graph]);

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, node) => onSelectNode(node.id)} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

```tsx
// frontend/pages/ai-jobs/AiJobsWorkspace.tsx
import React, { useEffect, useState } from 'react';
import { useWebSocket, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Canvas } from './Canvas';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

export function AiJobsWorkspace() {
  useDocumentTitle('AI Job Pipelines');
  const { sendRestApi } = useWebSocket();
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [pipelineId, setPipelineId] = useState<number | null>(null); // threaded into Task 24's Run call instead of a hardcoded id
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sendRestApi('GET', '/v1/ai-pipelines').then((res: any) => {
      if (cancelled) return;
      const apkPipeline = res.body?.data?.find((p: any) => p.jobKind === 'apk-analysis');
      if (apkPipeline?.graph) { setGraph(apkPipeline.graph); setPipelineId(apkPipeline.id); }
    });
    return () => { cancelled = true; };
  }, [sendRestApi]);

  if (!graph) return <div className="page-header"><h1>Pipelines</h1></div>; // loading state — replace with a real spinner in Task 23, not this task's concern

  return (
    <div className="ai-jobs-root" style={{ height: '100vh' }}>
      <Canvas graph={graph} onSelectNode={setSelected} />
      {selected && <div data-testid="selected-node">{selected}</div>}
    </div>
  );
}
```

`testing.tsx` mirrors `frontend/pages/plugins/testing.tsx`'s `createMockWs`/`withProviders` shape exactly — same `envelope()` helper, same `{ type: 'restapi', id, status, body }` response shape — plus a new `mockPipelineVersion()` fixture builder returning a `{ graph: ASTERIX_PATTERN_GRAPH-shaped-data }` object, and the mock ws's `GET /v1/ai-pipelines` route returning `{ success: true, data: [{ id: 1, jobKind: 'apk-analysis', graph: mockPipelineVersion().graph }] }` (matching Task 19's real response shape, which now folds each pipeline's published graph inline — see that task's pre-flight fix).

Add the route to `App.tsx` as a **top-level** route — a sibling of `automations`/`devices`/`apks`, not nested under `settings`:

```tsx
<Route path="pipelines" element={<AiJobsWorkspace />} />
```

Add the import at the top of `App.tsx`: `import { AiJobsWorkspace } from './pages/ai-jobs/AiJobsWorkspace';`

Add a top-level nav entry to `AppLayout.tsx`'s `CORE_NAV_GROUPS`, in the `'Tools'` group (`AppLayout.tsx:88-98`, next to `APKs`/`Frida`/`Plugins`) — **not** `SettingsSidebar.tsx`, see the design-correction note above:

```tsx
{ to: '/ui/pipelines', label: 'Pipelines', icon: Workflow, requiredScope: 'core.apk:read' },
```

Add `Workflow` to the existing `lucide-react` import block at the top of `AppLayout.tsx` (alongside `Package`, `Download`, etc.).

- [ ] **Step 4: Run test to verify it passes, then extend `AppLayout.test.tsx` for the new nav entry**

Run: `npm run test:frontend -- AiJobsWorkspace`
Expected: PASS

`AppLayout.test.tsx` already asserts `Automations` renders in the nav (`expect(screen.getByText('Automations')).toBeInTheDocument();`) — add the same one-line assertion for `'Pipelines'`, scoped to whatever auth fixture already grants `core.apk:read` in that file (several tests already do, for the existing `APKs` nav entry). Run `npm run test:frontend -- AppLayout` to confirm.

- [ ] **Step 5: Throwaway `tsc` check (frontend isn't type-checked by the main build — project memory `frontend_not_typechecked.md`)**

```bash
npx tsc --noEmit --jsx react-jsx --esModuleInterop --skipLibCheck frontend/pages/ai-jobs/*.tsx
```

Fix any real type errors it surfaces before committing — this is the only type-check these files will ever get.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json frontend/pages/ai-jobs/ frontend/App.tsx frontend/components/layout/AppLayout.tsx frontend/components/layout/AppLayout.test.tsx
git commit -m "feat(ai-jobs): add @xyflow/react, /ui/pipelines route, canvas renders a real pipeline"
```

### Task 23: Side panel — per-kind facts, the `AgentCall` prompt editor, the `Report` section list editor

One panel component, branching on node kind — mirrors `frontend/pages/plugins/PluginDrawer.tsx`'s role/structure (`role="dialog"`, a close button, focus management) rather than inventing a second drawer pattern. The prompt-editor's live-preview substitution is a client-side-only convenience copy of the server's `resolveTemplate` logic (Task 3) — duplicated deliberately rather than imported across the frontend/backend boundary, since it's a preview aid, not the authoritative resolution (that only ever happens server-side, inside an actual run).

**Files:**
- Create: `frontend/pages/ai-jobs/SidePanel.tsx`
- Create: `frontend/pages/ai-jobs/templatePreview.ts` (the small client-side substitution copy)
- Create: `frontend/pages/ai-jobs/templatePreview.test.ts`
- Create: `frontend/pages/ai-jobs/SidePanel.test.tsx`
- Modify: `frontend/pages/ai-jobs/AiJobsWorkspace.tsx` (render `SidePanel` when `selected` is set)

**Interfaces:**
- Consumes: `PipelineGraph`/`PipelineNode` (type-only, from the backend types module, same as Task 22).
- Produces: `resolvePreview(template: string, scope: Record<string, unknown>): string` (never throws — an unresolved placeholder renders inline as a visibly-marked miss, since this is a preview aid, not a thing that blocks typing); `<SidePanel node={...} onClose={...} onSave={(nodeId, patch) => void} />`.

- [ ] **Step 1: Write the failing test for `resolvePreview`**

```ts
// frontend/pages/ai-jobs/templatePreview.test.ts
import { describe, it, expect } from 'vitest';
import { resolvePreview } from './templatePreview';

describe('resolvePreview', () => {
  it('substitutes a resolvable path', () => {
    expect(resolvePreview('Analyze {{trigger.appName}}.', { trigger: { appName: 'Parc Astérix' } }))
      .toBe('Analyze Parc Astérix.');
  });

  it('marks an unresolved path inline instead of throwing — this is a preview, typing must never crash', () => {
    const result = resolvePreview('{{trigger.typoed}}', { trigger: { appName: 'x' } });
    expect(result).toContain('unresolved');
    expect(() => resolvePreview('{{trigger.typoed}}', { trigger: {} })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:frontend -- templatePreview`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `resolvePreview`**

```ts
// frontend/pages/ai-jobs/templatePreview.ts
export function resolvePreview(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\}\}/g, (match, path: string) => {
    const [source, ...fieldParts] = path.split('.');
    let value: unknown = scope[source];
    for (const part of fieldParts) {
      if (value === null || typeof value !== 'object') { value = undefined; break; }
      value = (value as Record<string, unknown>)[part];
    }
    return value === undefined || value === null ? `${match} (unresolved)` : String(value);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:frontend -- templatePreview`
Expected: PASS

- [ ] **Step 5: Write the failing `SidePanel` test**

```tsx
// frontend/pages/ai-jobs/SidePanel.test.tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SidePanel } from './SidePanel';

const agentNode = {
  id: 'agent-overview',
  config: { kind: 'AgentCall' as const, tier: 'High', instructionTemplate: 'Analyze {{trigger.appName}}.', toolAllowlist: ['get_apk_overview'] },
};
const triggerSchema = [{ field: 'appName', type: 'string', description: 'x' }];

describe('SidePanel — AgentCall', () => {
  it('shows the instruction template in an editable textarea', () => {
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByRole('textbox')).toHaveValue('Analyze {{trigger.appName}}.');
  });

  it('inserting a variable chip appends it at the cursor and the preview updates', () => {
    const onSave = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /trigger\.appName/i }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toContain('{{trigger.appName}}');
    expect(onSave).toHaveBeenCalledWith('agent-overview', expect.objectContaining({ instructionTemplate: expect.stringContaining('{{trigger.appName}}') }));
  });

  it('closing calls onClose', () => {
    const onClose = vi.fn();
    render(<SidePanel node={agentNode} triggerSchema={triggerSchema} onClose={onClose} onSave={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SidePanel — Report', () => {
  const reportNode = {
    id: 'report',
    config: { kind: 'Report' as const, sections: [{ title: 'Overview', from: 'agent-overview' }, { title: 'Bypass Script', from: 'agent-bypass' }] },
  };

  it('lists sections in declared order, numbered', () => {
    render(<SidePanel node={reportNode} triggerSchema={triggerSchema} onClose={() => {}} onSave={() => {}} />);
    const rows = screen.getAllByTestId('report-section-row');
    expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('1'), expect.stringContaining('2')].map((m, i) => expect.stringContaining(['Overview', 'Bypass Script'][i])));
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test:frontend -- SidePanel`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Write `SidePanel`**

**Correction made before this task was dispatched:** this task's own opening line promises the
panel "mirrors `frontend/pages/plugins/PluginDrawer.tsx`'s role/structure (`role="dialog"`, a
close button, focus management)" — but the draft below has no focus management at all: no
move-focus-in on open, no restore-focus-on-close, no Escape-to-close. Given the explicit bar for
this tool ("world-class leading, intuitive UI/UX"), a dialog panel without keyboard support isn't
a nice-to-have gap, it's the promised behavior simply missing. Fixed by hoisting the dialog chrome
(the `<aside role="dialog">`, the close button, and PluginDrawer's own two `useEffect`s verbatim —
`frontend/pages/plugins/PluginDrawer.tsx:105-122`) into the outer `SidePanel`, so it exists exactly
once rather than being duplicated (or omitted) per kind; each kind now renders only its own body
content into that shared shell — which also reads cleaner against the "DRY without premature
abstraction" review bar than three copies of the same dialog scaffolding would have:

```tsx
// frontend/pages/ai-jobs/SidePanel.tsx
import React, { useEffect, useRef, useState } from 'react';
import { resolvePreview } from './templatePreview';

interface SchemaField { field: string; type: string; description: string }
interface NodeLike { id: string; config: Record<string, any> & { kind: string } }

export function SidePanel({ node, triggerSchema, onClose, onSave }: {
  node: NodeLike;
  triggerSchema: SchemaField[];
  onClose: () => void;
  onSave: (nodeId: string, patch: Record<string, unknown>) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the panel on open, hand it back to whatever opened it on close.
  // Verbatim pattern from frontend/pages/plugins/PluginDrawer.tsx:105-113.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Escape closes the panel, unless a modal above it already took the key.
  // Verbatim pattern from frontend/pages/plugins/PluginDrawer.tsx:116-122.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside role="dialog" aria-label={`${node.id} details`}>
      <button ref={closeRef} type="button" aria-label="Close details" onClick={onClose}>×</button>
      {node.config.kind === 'AgentCall' ? (
        <AgentCallBody node={node} triggerSchema={triggerSchema} onSave={onSave} />
      ) : node.config.kind === 'Report' ? (
        <ReportBody node={node} />
      ) : (
        <dl>{Object.entries(node.config).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{JSON.stringify(v)}</dd></div>)}</dl>
      )}
    </aside>
  );
}

function AgentCallBody({ node, triggerSchema, onSave }: {
  node: NodeLike; triggerSchema: SchemaField[]; onSave: (nodeId: string, patch: Record<string, unknown>) => void;
}) {
  const [template, setTemplate] = useState<string>(node.config.instructionTemplate);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sampleScope = { trigger: Object.fromEntries(triggerSchema.map(f => [f.field, `<${f.field}>`])) };

  function insertVar(field: string) {
    const ta = taRef.current;
    const token = `{{trigger.${field}}}`;
    const start = ta?.selectionStart ?? template.length;
    const end = ta?.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    onSave(node.id, { instructionTemplate: next });
  }

  return (
    <>
      <textarea
        ref={taRef}
        value={template}
        onChange={(e) => { setTemplate(e.target.value); onSave(node.id, { instructionTemplate: e.target.value }); }}
      />
      {triggerSchema.map(f => (
        <button key={f.field} onClick={() => insertVar(f.field)}>+ trigger.{f.field}</button>
      ))}
      <div data-testid="prompt-preview">{resolvePreview(template, sampleScope)}</div>
    </>
  );
}

function ReportBody({ node }: { node: NodeLike }) {
  const sections = node.config.sections as Array<{ title: string; from: string }>;
  return (
    <ol>
      {sections.map((s, i) => (
        <li key={s.from} data-testid="report-section-row">{i + 1}. {s.title} ← {s.from}</li>
      ))}
    </ol>
  );
}
```

Add one more case to the Step 5 test file alongside the existing three: closing via the Escape key
calls `onClose` (`fireEvent.keyDown(document, { key: 'Escape' })`), matching the equivalent
coverage `PluginDrawer.test.tsx` already has for its own Escape handling — grep that file for its
Escape test and mirror its shape.

- [ ] **Step 8: Run test to verify it passes**

Run: `npm run test:frontend -- SidePanel`
Expected: PASS

- [ ] **Step 9: Wire it into `AiJobsWorkspace.tsx`**

**Correction made before this task was dispatched:** the draft below picked `graph.nodes.find(n =>
n.config.kind === 'Trigger')` — the FIRST Trigger node in array order, unconditionally. The real
Astérix graph (Task 20) has two disjoint Trigger zones, `trigger-full` and `trigger-rescan`; today
both happen to share `APK_CONTEXT_SCHEMA`, which is why this wouldn't have failed any test written
against that one pipeline, but this tool's whole purpose (per spec) is to be reused for pipelines
this plan never sees. The first pipeline anyone builds with two Triggers of genuinely different
shape would show every AgentCall downstream of the second Trigger the WRONG variable chips. Find
the Trigger that actually reaches the selected node instead, using the same forward-reachability
BFS the executor itself uses to define a Trigger's zone (Task 16's `reachableFrom` in
`backend/services/ai-jobs/pipeline-runner.ts` — duplicated here client-side rather than imported,
for the same frontend/backend-boundary reason `templatePreview.ts` duplicates `resolveTemplate`):

```tsx
// in AiJobsWorkspace.tsx, alongside the other module-level helpers
function reachableFrom(nodeId: string, graph: PipelineGraph): Set<string> {
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== current || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

/** The Trigger whose zone actually contains `nodeId` — never just "the first Trigger in the
 * graph." A valid published graph (graph-validator, Task 16) guarantees every non-Trigger node
 * is reachable from some Trigger, so the fallback below is defensive, not a real path. */
function findOwningTriggerSchema(graph: PipelineGraph, nodeId: string): Array<{ field: string; type: string; description: string }> {
  const triggers = graph.nodes.filter(n => n.config.kind === 'Trigger');
  for (const trigger of triggers) {
    if (reachableFrom(trigger.id, graph).has(nodeId)) return trigger.config.outputSchema;
  }
  return triggers[0]?.config.outputSchema ?? [];
}
```

Replace the `{selected && <div data-testid="selected-node">{selected}</div>}` placeholder from Task 22 with:

```tsx
{selected && (
  <SidePanel
    node={graph.nodes.find(n => n.id === selected)!}
    triggerSchema={findOwningTriggerSchema(graph, selected)}
    onClose={() => setSelected(null)}
    onSave={(nodeId, patch) => {
      setGraph(g => g && ({ ...g, nodes: g.nodes.map(n => n.id === nodeId ? { ...n, config: { ...n.config, ...patch } } : n) }));
    }}
  />
)}
```

(This updates local state only — persisting an edited graph as a new draft version is a `POST /v1/ai-pipelines/:id/versions` call, Task 19's endpoint; wiring a "Save" button to it is this plan's natural next follow-up once this task's own tests are green, not blocking this task's own deliverable.)

Add a test to `AiJobsWorkspace.test.tsx` (or a dedicated `findOwningTriggerSchema`-only unit, implementer's choice) proving this with a fixture that has two Trigger zones with *different* `outputSchema`s, asserting the AgentCall belonging to the second zone gets the second zone's schema, not the first's.

- [ ] **Step 10: `tsc` check + commit**

```bash
npx tsc --noEmit --jsx react-jsx --esModuleInterop --skipLibCheck frontend/pages/ai-jobs/*.tsx frontend/pages/ai-jobs/*.ts
git add frontend/pages/ai-jobs/SidePanel.tsx frontend/pages/ai-jobs/SidePanel.test.tsx frontend/pages/ai-jobs/templatePreview.ts frontend/pages/ai-jobs/templatePreview.test.ts frontend/pages/ai-jobs/AiJobsWorkspace.tsx
git commit -m "feat(ai-jobs): side panel — AgentCall prompt editor, Report section list, generic facts"
```

### Task 24: Entry-point picker, reuse-unchanged toggle, Run flow

**Scope note, stated plainly rather than silently narrowed:** the spec's Frontend section says status "streams... over the existing WebSocket channel the way Live Log already does." Phase D's `/run` endpoint (Task 19) is synchronous — it `await`s the whole `runPipeline()` call and responds once with the final result; there is no per-node live broadcast wired up anywhere in this plan. This task builds the UI that matches what Phase D actually ships: a single blocking "Running…" state for the whole run's duration, then every node's final status applied at once from the response. True per-node live streaming (a `broadcastToAll` call per `NodeRunResult` as the executor produces it, the way `apk:ai-agent-update` already works elsewhere) is real, valuable follow-up work this plan does not include — see Open Questions at the end of this document.

**Files:**
- Create: `frontend/pages/ai-jobs/RunControls.tsx`
- Create: `frontend/pages/ai-jobs/RunControls.test.tsx`
- Modify: `frontend/pages/ai-jobs/AiJobsWorkspace.tsx`

**Interfaces:**
- Consumes: `POST /v1/ai-pipelines/:id/run` (Task 19).
- Produces: `<RunControls triggers={...} onRun={(triggerNodeId, reuseUnchanged) => Promise<RunResponse>} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/pages/ai-jobs/RunControls.test.tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RunControls } from './RunControls';

const triggers = [{ id: 'trigger-full', label: 'Full Analysis' }, { id: 'trigger-rescan', label: 'Quick Rescan' }];

describe('RunControls', () => {
  it('defaults to the first trigger and reuse off, Run calls onRun with those', async () => {
    const onRun = vi.fn().mockResolvedValue({ status: 'ok', nodes: [] });
    render(<RunControls triggers={triggers} onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith('trigger-full', false));
  });

  it('switching the entry point and checking reuse changes what Run sends', async () => {
    const onRun = vi.fn().mockResolvedValue({ status: 'ok', nodes: [] });
    render(<RunControls triggers={triggers} onRun={onRun} />);
    fireEvent.change(screen.getByRole('combobox', { name: /entry point/i }), { target: { value: 'trigger-rescan' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /reuse unchanged/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith('trigger-rescan', true));
  });

  it('disables the Run button while a run is in flight and re-enables after it settles', async () => {
    let resolve!: (v: unknown) => void;
    const onRun = vi.fn(() => new Promise(r => { resolve = r; }));
    render(<RunControls triggers={triggers} onRun={onRun as any} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: /running/i })).toBeDisabled();
    resolve({ status: 'ok', nodes: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:frontend -- RunControls`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `RunControls`**

```tsx
// frontend/pages/ai-jobs/RunControls.tsx
import React, { useState } from 'react';

export function RunControls({ triggers, onRun }: {
  triggers: Array<{ id: string; label: string }>;
  // Deliberately `Promise<unknown>`, not a shaped result type: this component never reads the
  // resolved value, only awaits it to toggle `running` — see the Step 5 correction for why the
  // real caller (AiJobsWorkspace's handleRun) can't reliably promise a `nodes` field here.
  onRun: (triggerNodeId: string, reuseUnchanged: boolean) => Promise<unknown>;
}) {
  const [triggerNodeId, setTriggerNodeId] = useState(triggers[0]?.id ?? '');
  const [reuseUnchanged, setReuseUnchanged] = useState(false);
  const [running, setRunning] = useState(false);

  async function handleRun() {
    setRunning(true);
    try {
      await onRun(triggerNodeId, reuseUnchanged);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="run-controls">
      <label>
        Entry point
        <select aria-label="Entry point" value={triggerNodeId} onChange={(e) => setTriggerNodeId(e.target.value)}>
          {triggers.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Reuse unchanged nodes"
          checked={reuseUnchanged}
          onChange={(e) => setReuseUnchanged(e.target.checked)}
        />
        Reuse unchanged nodes
      </label>
      <button onClick={handleRun} disabled={running}>{running ? 'Running…' : 'Run'}</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:frontend -- RunControls`
Expected: PASS

- [ ] **Step 5: Wire it into `AiJobsWorkspace.tsx`**

**Correction made before this task was dispatched:** the draft below read `res.body?.data?.nodes`
straight off the `POST /run` response. The real endpoint (`backend/api/ai-pipelines.ts:154`,
Task 19) only ever responds `{ success: true, data: { runId, status } }` — it never includes
`nodes`; those are persisted to `aiPipelineNodeRuns` and only readable back via the sibling
`GET /v1/ai-pipelines/runs/:runId` endpoint (`ai-pipelines.ts:166-172`, response shape
`{ success: true, data: { run, nodes } }`, where each `nodes[i]` carries `nodeId`/`status`/
`wasMemoized` — exactly the fields this task wants). Without this fix, `nodeStatuses` would stay
`{}` forever, even after a fully successful run — the entire second half of this task's own
deliverable (Canvas reflecting run results) would silently do nothing, on every run, always.
Fixed by following up the `/run` call with a `GET` on the `runId` it returns:

```tsx
const triggerNodes = graph.nodes.filter(n => n.config.kind === 'Trigger').map(n => ({ id: n.id, label: n.id })); // real label source is a follow-up — Task 20's graph has no human-readable Trigger display name field today, just its id; adding one is a small, separate schema/UI change, not blocking this task

const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: string; wasMemoized?: boolean }>>({});

async function handleRun(triggerNodeId: string, reuseUnchanged: boolean) {
  // pipelineId comes from the `pipelineId` state Task 22's useEffect already sets alongside
  // setGraph (the real id GET /v1/ai-pipelines returned for the apk-analysis entry) — never a
  // hardcoded literal.
  const runRes: any = await sendRestApi('POST', `/v1/ai-pipelines/${pipelineId}/run`, { triggerNodeId, input: {}, reuseUnchanged });
  const runId = runRes.body?.data?.runId;
  // The /run response never includes per-node results (see correction above) — fetch them from
  // the run-detail endpoint. A failed POST (409 already-running, 400 bad trigger, 404, 500) has
  // no runId, so this is skipped and nodeStatuses is simply left unchanged; surfacing a run
  // failure to the user is real follow-up work (see Open Questions), not added here.
  if (runId != null) {
    const detailRes: any = await sendRestApi('GET', `/v1/ai-pipelines/runs/${runId}`);
    const byId: Record<string, { status: string; wasMemoized?: boolean }> = {};
    for (const n of detailRes.body?.data?.nodes ?? []) byId[n.nodeId] = { status: n.status, wasMemoized: n.wasMemoized };
    setNodeStatuses(byId);
  }
  return runRes.body?.data;
}
```

Since `handleRun`'s resolved value no longer reliably carries a `nodes` field (the `/run` response
never had one), loosen `RunControls`'s `onRun` prop type from `Promise<{ status: string; nodes:
unknown[] }>` to `Promise<unknown>` in Step 3's code — `RunControls` never reads the resolved
value's shape (it only awaits the promise to toggle `running`), so this type was unused ceremony
that would otherwise force a mismatch against what `handleRun` can actually return.

Render `<RunControls triggers={triggerNodes} onRun={handleRun} />` above the `Canvas`, and pass `nodeStatuses` into `Canvas` so node styling can reflect `ok`/`failed`/`cached`/`inactive` (extend `Canvas`'s `style` computation from Task 22 to read `nodeStatuses[n.id]?.status` and pick a border color accordingly — same `KIND_COLOR`-style lookup table pattern, one more small table for status colors).

Add a test to `AiJobsWorkspace.test.tsx` proving this two-call sequence actually populates node
styling: mock `POST .../run` returning `{ runId: 7, status: 'ok' }` and `GET .../runs/7` returning
a couple of `nodes` entries, trigger a run, and assert the mock ws recorded both calls in order
(`calledPaths`-style) and that the resulting node elements pick up the expected status styling.

- [ ] **Step 6: `tsc` check + commit**

```bash
npx tsc --noEmit --jsx react-jsx --esModuleInterop --skipLibCheck frontend/pages/ai-jobs/*.tsx
git add frontend/pages/ai-jobs/RunControls.tsx frontend/pages/ai-jobs/RunControls.test.tsx frontend/pages/ai-jobs/AiJobsWorkspace.tsx frontend/pages/ai-jobs/Canvas.tsx
git commit -m "feat(ai-jobs): entry-point picker, reuse-unchanged toggle, Run wired to the REST API"
```

### Task 25: End-to-end test

**Files:**
- Create: `tests/e2e/ai-pipelines.spec.ts`

**Interfaces:**
- Consumes: the real server, via the shared e2e `webServer` (same as `navigation.spec.ts`/`ai-tiers.spec.ts`) — **not** `plugins-install-ui.spec.ts`'s isolated-DB-and-Vite pattern. An earlier draft of this task claimed it needed isolation because it "publishes a pipeline version and triggers a real run," but the test below does neither — it only reads `GET /v1/ai-pipelines` (the `apk-analysis` pipeline is seeded with a published v1 at boot, unconditionally — `seedApkAnalysisPipeline`, Task 20, not gated by `ai_pipelines_enabled`) and exercises the canvas/panel UI entirely client-side (`SidePanel.onSave` only touches local React state — Task 23 — never `POST .../versions`). Nothing this test does mutates shared state, so isolation would only add the cost of spinning up a second backend+Vite instance for no benefit. If a future task adds a step that actually publishes or runs, promote it to the isolated pattern then.

**Correction made before this task was dispatched:** the draft test clicked and asserted against `'Overview'`/`'Assemble notes'` to represent "the `agent-overview` AgentCall node" and "the Report node" respectively. Neither works against the real rendering (`frontend/pages/ai-jobs/Canvas.tsx`'s `NodeLabel`, Task 22/23): every node's label is its kind plus its own `id` (`'AgentCall'` / `'agent-overview'`), and a `Report` node additionally lists its section titles as separate lines — so `'Overview'` is the Report node's first section-title line, not the `agent-overview` AgentCall node's label, and `'Assemble notes'` doesn't exist anywhere in the real pipeline (Task 20's actual section titles are Overview/Wait Times/Opening Hours/Maps/Secrets/cURL Examples/Bypass Script — the exact same stale string Task 22's own unit test had to fix for the same reason). Clicking `'Overview'` as drafted would have opened the *Report* panel, not the AgentCall prompt editor the test claims to be testing. Fixed below by targeting each node's real id text, with `exact: true` so `'report'` doesn't also match `'sink-report'` as a substring. Also renamed the test — its old name ("Run produces a partial result with Bypass Script failed") described a live Run this test explicitly never performs (see the note after the code block, unchanged from the original draft).

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/ai-pipelines.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('AI job pipelines', () => {
  test('canvas renders the real Astérix pipeline; prompt editor and Report sections show real content', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');

    // Every node renders its own id as part of its label (Canvas.tsx's NodeLabel).
    await expect(page.getByText('agent-overview', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('report', { exact: true })).toBeVisible();

    // Click the agent-overview AgentCall node, confirm the prompt editor opens with real content.
    await page.getByText('agent-overview', { exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveValue(/Analyze \{\{trigger\.appName\}\}/);

    // Insert a variable chip, confirm it lands in the textarea.
    await page.getByRole('button', { name: /trigger\.appName/i }).click();
    await expect(page.getByRole('textbox')).toHaveValue(/\{\{trigger\.appName\}\}.*\{\{trigger\.appName\}\}/s);

    // Close this panel before opening the next one, rather than assume the Report node is
    // reachable underneath whatever's currently open.
    await page.getByRole('button', { name: /close/i }).click();

    // Click the Report node, confirm its ordered section list shows all seven, in order.
    await page.getByText('report', { exact: true }).click();
    const sectionRows = page.getByTestId('report-section-row');
    await expect(sectionRows).toHaveCount(7);
    await expect(sectionRows.nth(6)).toContainText('Bypass Script');
  });
});
```

This spec deliberately stops short of clicking Run against a live model — doing that for real would cost a live API call and hit exactly the cyber-classifier refusal this whole project exists to route around, non-deterministically, inside a gate-tested e2e suite where that's the wrong place for it. A full live run belongs in the periodic eval the spec's Testing section already calls for, not here.

- [ ] **Step 2: Run the test**

Run: `npx playwright test tests/e2e/ai-pipelines.spec.ts`
Expected: PASS (after Tasks 22–24 are all in place — this test exercises the whole frontend phase together, which is the point of an e2e spec as the phase's final gate).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/ai-pipelines.spec.ts
git commit -m "test(ai-jobs): e2e — canvas renders the real pipeline, prompt editor, Report sections"
```

---

## Open Questions Carried Forward (not blocking, named so they aren't lost)

- **Per-node live status streaming** (Task 24's scope note) — `/run` is synchronous today; broadcasting each `NodeRunResult` as it's produced, the way `apk:ai-agent-update` already works, is real follow-up work.
- ~~A failed Run shows no feedback to the user~~ — **fixed in the final-review fix round, not deferred.** `AiJobsWorkspace.tsx` now shows a `role="status"` line with the POST's server error (403/409/etc.), the run's final outcome once polling settles, or "still running on the server" if polling gives up — added alongside the async-run rework the final review required anyway (see below).
- **Canvas layout** (Task 22) — nodes are placed in a naive grid, not the hand-tuned 2D layout with per-section `Report` ports the verified mockup used. A real layout pass (either a `dagre`/`elkjs` auto-layout or porting the mockup's exact coordinate math) is a follow-up, not required for this plan's tests to pass.
- **Persisting an edited graph** (Task 23) — `SidePanel`'s `onSave` only updates local React state today; wiring it to `POST /v1/ai-pipelines/:id/versions` (Task 19 already has the endpoint) is a small follow-up.
- Every "Open question" already named in the spec itself (reconverging Trigger zones, cross-version memoization, versioned prompt templates, human-in-the-loop nodes) — unchanged, still future work, not restated here.
- **Wave-based scheduling blocks a wave's faster nodes on its slowest node** (Task 14, found in that task's review) — `runPipeline`'s executor runs each wave's ready nodes concurrently via `Promise.all`, but waits for every one of them before computing the next wave, even across independent branches. For the shipped Astérix pipeline this costs nothing (its 7 parallel `AgentCall`s all sit in one wave, and `Report` genuinely needs all 7 to finish before it can run regardless), but a future pipeline with asymmetric independent branches off one `Trigger` would have its faster branch's downstream nodes wait on the slower branch's node to finish first. Fixing this properly means a true dataflow scheduler (start each node the instant its own predecessors settle, not wave-by-wave) — a real rewrite of the executor's scheduling loop, not a patch, and three more tasks (15-17) build directly on the current wave shape. Deliberately not done now; a future pipeline with real throughput needs should prompt revisiting this.
- **What an ordinary (non-envelope) node that merges both of a Branch's arms should do is undefined** (Task 15, found in that task's review) — if a plain node (not a `Report`) has two incoming edges, one from the chosen arm and one from the non-chosen arm, `unavailabilityStatus` currently makes it `'inactive'` (since the non-chosen arm's edge is never resolved to a real failure), even though its OTHER input is perfectly live. Under the executor's existing strict-AND-join semantics (every input must be available for a node to run — unchanged since Task 14), this is arguably correct: a node genuinely can't do its job with one of its two declared inputs permanently absent. But the spec never states that a `Report` is the *only* valid way to rejoin a Branch's arms, and the graph validator doesn't enforce it. Not fixed — deliberately left as a named design question rather than guessed at; either the validator should reject a non-`Report` merge downstream of a `Branch`, or the spec should explicitly bless it with these "inactive wins" semantics.
- ~~A `Report` fed by a mix of live-and-ok sources and sources on a dead (non-chosen) branch isn't specially handled~~ — **this was wrong and has been fixed, not deferred.** The generic `unavailabilityStatus` rule goes `'inactive'` the moment even one incoming edge is a pure branch-mismatch, which is correct for `Branch` (one logical predecessor) but was being applied to `Report` too — and a second pass of Task 15's own review (re-verified against the spec's explicit text: "`Report`... always runs once every `from` node settles... rather than requiring all-`ok`") caught that this made a `Report` with, say, 6 live `ok` sections plus a 7th behind a non-chosen `Branch` edge go entirely `'inactive'` and never run — silently dropping 6 good sections while reporting the run `'ok'`. `Report` now has its own eligibility rule: `'inactive'` only when **every** incoming edge is dead, never merely because some are. See the code block above.
- **The special `trigger` input key can collide with a real node literally named `"trigger"`** (Task 14, found in that task's review) — `input.trigger = outputs.get(triggerNodeId)` (every node's input always carries the fired Trigger's output under the literal key `'trigger'`) would silently overwrite a legitimate predecessor's output if some OTHER node in the graph is also named `trigger` and happens to be a direct predecessor of the same node. Narrow (requires a graph author to pick that exact id for a non-Trigger node) and not reachable in the shipped Astérix pipeline (whose Trigger nodes are named `trigger-full`/`trigger-rescan`, never bare `trigger`). A cheap fix exists (reserve `'trigger'` as a disallowed node id in `graph-validator.ts`) but wasn't added — Task 12 is already shipped and reviewed, and this is narrow enough not to justify reopening it. Worth a one-line addition to the validator whenever that file is next touched.
- **The spec's Testing section names three lanes — Gate tests, Periodic eval, E2E. This plan only has tasks for the first and third.** No periodic-eval harness exists anywhere in this codebase today (checked: no `eval` infra under `backend/`, nothing beyond unrelated name collisions) — there is no established convention this plan could follow, and inventing one from scratch wasn't done here rather than guessed at. The four assertions the spec's Testing section calls for (no single failure empties more than its own section; token cost holds against today's design; benign sections stay on the High tier's top model; Group B's fallback rate isn't worse scoped than diluted) are real, still unimplemented, and — per CLAUDE.md's "every feature ships with a test suite AND an eval suite, in the same commit" — this plan is **not** a complete discharge of that rule as written. Whoever picks this plan up should treat "design the eval harness" as its own small piece of work, done before calling the whole feature DONE, not silently skipped because it wasn't a task above.
- **The shared pipeline-run concurrency guard is keyed only on `pipelineVersionId`, not on which real-world input (e.g. which APK version) the run is for** (final whole-branch review's fix round, deliberately accepted) — the original REST `/run` endpoint (Task 19) already had this coarser-than-ideal guard; the final-review fix made `apk-analyzer.ts`'s production auto-trigger path share it too (closing a real race between a REST run and an auto-triggered run on the *same* APK version — the actual finding being fixed). The side effect: once `ai_pipelines_enabled` is on, auto-triggered analyses of *two different* APK versions can no longer run concurrently through the pipeline — the second one's auto-trigger gets an "already running" failure note with no automatic retry (nothing in this system retries any AI-analysis failure automatically; a human re-triggers). Before this fix, two different APKs' analyses never conflicted (each was keyed by its own `versionId` in an in-memory Set with no shared record). This throttles throughput to one pipeline-driven analysis at a time, system-wide, which matters if Cube ever analyzes multiple APKs back-to-back with the flag on. Fixing it properly needs a per-input-aware concurrency key (e.g. `pipelineVersionId` + `input.versionId`) — deliberately not built now, since the generic `startPipelineRun` function has no way to know which field of an arbitrary future pipeline's `input` is the meaningful dedup key.
- **A Full Analysis Sink's per-section note patch (final review's fix round, Part 8) can leave stale fragments if an AgentCall's own output text contains its own `## ` heading** — `patchNoteSection` only replaces up to the next `## ` line; if, say, the Overview section's AI-generated text happens to include a `## Endpoints` sub-heading, re-running Full Analysis replaces only the part of that section before the embedded heading, and the old embedded block survives as an orphan that piles up across runs. Not a regression: the pre-pipeline `patch_analysis_section` tool has the exact same limitation, and the old `setNote`-based Sink (which this round replaced specifically to stop it from destroying *other* sections) traded one failure mode for this narrower, pre-existing one. A real fix (have `runReport`'s assembler demote any `##` found inside a section's own body to `###`, or instruct the model not to use level-2 headings) is a small, separate follow-up.
- **`ai_pipelines_enabled` has no UI toggle** — it defaults off (Task 21's deliberate design) and this plan never built a settings-page control for it; flipping it today needs a direct `update_setting` call (e.g. via the darkride MCP tools, or a raw DB edit). Not a bug — a settings toggle was never in scope for this 25-task plan — but worth knowing before trying to demo the Run flow.
- **The polling loop in `AiJobsWorkspace.tsx`'s `handleRun` doesn't cancel if the user navigates away mid-run** (final review's fix round) — it keeps polling `GET /v1/ai-pipelines/runs/:runId` every 2s for up to ~10 minutes after unmount. Harmless (no state corruption, at most a wasted network call and a possible dev-mode React warning), but a real cleanup gap. A small follow-up (an `AbortController` or a cancelled-flag closed over by the polling loop, checked each iteration) — not added now, Minor severity.
- **A dev DB seeded before the final-review fix round's Part 7 tool-list trim keeps the old, untrimmed tool names in its stored, published graph** (`seedApkAnalysisPipeline` never updates an existing row — M7, above) — and the re-review corrected the fix's own report on exactly why this is (mostly) harmless: it is NOT Part 6's new allowlist-at-execution check that protects the auto-trigger identity here (that check only compares against whatever's in the *stored* allowlist, which on a stale DB still contains the dead names) — it's `AiToolRegistry.executeTool`'s pre-existing scope check, which already throws `Insufficient scope` for the credentials/traffic/frida tools and `Unknown tool` for the never-real `get_map_config`, regardless of this fix round. That part is genuinely harmless on a stale DB. What is NOT fully harmless: a **manual** UI-triggered run (which executes as the clicking user, not the restricted core identity) by someone who *does* hold `core.credentials:read`/`core.traffic:read`/`core.frida:manage` would still have those tools reachable on a stale DB, exactly as before this fix round — not a new regression, but a real residual gap until the dev DB is re-seeded or the pipeline is republished from the editor.
