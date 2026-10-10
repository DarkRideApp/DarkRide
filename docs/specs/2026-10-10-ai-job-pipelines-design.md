# AI job pipelines: design

Date: 2026-10-10
Status: **Decided (Approach A), not yet built.** Scope, approach and first migration target were chosen by Cube; node contracts, data model and rollout were settled during design.

## The problem

Found while reviewing the Parc Astérix (`fr.parcasterix.appli.android`) AI analysis notes, which had degraded from a detailed writeup (version 390) to a one-paragraph stub (version 431) despite the agent run doing real work (37+ tool calls, a full SSL-pinning Frida bypass generated).

Two independent root causes, both structural to how `apk-analyzer.ts` runs the job today — one long-lived agent conversation, one system prompt, every tool call (read and write) replayed through the same growing context:

1. **Instruction-level refusal, whole-run blast radius.** Settings → APK Analysis has three custom rules on top of the default prompt: document secrets, include cURL examples, write Frida bypass scripts. Each one *individually* trips Anthropic's cyber-safety classifier on `claude-opus-5-5` — confirmed by the Astérix run, where Opus refused at turn 0, before any tool call ran, purely from the system prompt. The existing router fallback (Opus → Sonnet 5 → OpenRouter Free) catches this correctly, but because it's one agent run with one system prompt, the *entire* run — including the sections the default prompt handles fine (Overview, Wait Times, Maps) — gets demoted to the fallback model. One instruction's trigger taxes every section's quality.
2. **Write-escalation flakiness, independent of safety.** `ai-agent.ts` already runs a cheap/expensive split: a research-tier model does reads, and any write-class tool call (`patch_analysis_section`, `write_analysis_notes`) gets replayed against a write-tier model on the full accumulated context. If the write model doesn't emit a matching tool call — for any reason, not necessarily a refusal, confirmed by the Astérix run where the write model (Sonnet 5, no `ModelRefusedError` thrown) simply didn't produce one for an innocuous Maps section — the code silently falls back to the cheap model's own write. One flaky write-model turn degrades that section with no visible failure state; it's a `log()` line in Live Log, nothing in the notes doc or the UI says it happened.

Both failures share a shape: a single model call that's scoped too broadly (one prompt for the whole job; one replay of the whole context to approve one write) has an outsized, silent effect on parts of the job that had nothing to do with the failure.

## Options considered

Cube chose the scope and interface up front (see chat log): a **general AI-job orchestrator**, not a one-off fix scoped to APK analysis, with a **visual node-based editor** as the authoring surface, and the rebuilt APK-analysis-notes job as the first pipeline built on it. That fixed the scope; the remaining open question was how a pipeline is represented and run.

- **A. Typed JSON graph + generic executor (chosen).** Pipelines are versioned data (nodes + edges), not code. A generic executor walks the graph; the editor reads and writes the same data it runs. Editing a pipeline's structure or prompts never requires a deploy.
- **B. Visual editor as a design tool, code-generates a `.ts` module.** Zero custom interpreter — a pipeline is just a normal, debuggable TypeScript module using the same `agent()`/`pipeline()`/`parallel()` shape as Claude Code's own `Workflow` tool. Rejected: every edit needs commit → CI → restart before it takes effect, which throws away the point of choosing a visual, live-editable surface.

Also considered and rejected: reusing DarkRide's existing script sandbox (`automation-sandbox.ts`, isolated-vm, used for device automations). Wrong tool — it exists to isolate semi-trusted device-automation scripts from Node (DOM/Device/Http ctx only, 128 MB V8 isolate, functions stripped crossing the boundary). AI job pipelines are first-party code at the same trust level as the rest of the backend, and need direct access to the DB, the model router, and outbound HTTP. Running them inside a sandbox built to keep code *out* of Node would mean bridging every single capability across the isolate boundary for no safety benefit.

## Architecture

Three layers:

1. **Node primitive library** (`backend/services/ai-jobs/nodes/`) — a small, closed set of typed node kinds (below). Each is a pure, independently testable TS function: `(input, ctx) => output`.
2. **Pipeline definition + executor** (`backend/services/ai-jobs/pipeline-runner.ts`) — pipelines are versioned rows holding a typed graph. The executor topologically walks it, runs independent branches concurrently, and persists a per-node run record. An `AgentCall` node delegates straight into the existing `ai-agent.ts` → `ai-model-router.ts` → `resolveTierConfig` stack — none of that is rebuilt; this project only decides *what gets called, with what scope, in what order*.
3. **Visual editor** (`frontend/pages/ai-jobs/`) — `@xyflow/react` canvas. The graph the editor shows *is* the stored pipeline definition; there is no separate authoring format to keep in sync. A manual "Run" triggers a live run; each node reflects its own run state (idle/running/ok/failed) and shows its last input/output on selection.

`@xyflow/react` (formerly React Flow) is the pick for the canvas: the de facto standard for in-browser node graphs, actively maintained, what tools like n8n are built on. Nothing else in the space is close on adoption or maintenance. Not currently a dependency — this adds it.

## Node primitives

| Kind | Does | Notes |
|---|---|---|
| `AgentCall` | Runs one scoped agent turn-loop | `{ tier, systemPromptTemplate, toolAllowlist, inputMapping }`. Scoped tools + scoped prompt — this is the actual fix for problem 1: a `Secrets` node only ever carries the secrets instruction, an `Overview` node only ever carries the default prompt. No single model call bundles unrelated trigger instructions, so one node's refusal can't touch another's quality. |
| `Transform` | Deterministic reshape/merge | A named, pre-registered pure TS function, picked by name in the graph — not freeform code stored in the DB. E.g. `mergeNotesSections`, `dedupeFindings`. This is the deterministic half of every job: the LLM nodes produce raw material, `Transform` nodes make it consistent. |
| `Branch` | Picks an outgoing edge | Predicate over the upstream node's output and/or run status (e.g. `status !== 'ok'` → the fallback edge). |
| `ForEach` | Runs a subgraph per item | Iterates a list input (e.g. one `AgentCall` per finding category), collects results into an array. |
| `Sink` | Terminal write | Pluggable per job family. APK analysis's sink calls `patch_analysis_section`; a future job defines its own without touching the core engine. |

Every node consumes one JSON-serializable input (merged from its incoming edges plus run-level context: `versionId`, trigger metadata) and produces one JSON-serializable output. No named ports in this version — a node with two outputs a downstream node needs separately should be two nodes.

## Data model

New tables in `backend/db/schema.ts` (Drizzle, sqlite, matching existing conventions):

```ts
export const aiPipelines = sqliteTable('ai_pipelines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  jobKind: text('job_kind').notNull(), // 'apk-analysis' | future kinds
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const aiPipelineVersions = sqliteTable('ai_pipeline_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineId: integer('pipeline_id').notNull().references(() => aiPipelines.id),
  version: integer('version').notNull(), // monotonic per pipeline
  graph: text('graph', { mode: 'json' }).notNull(), // { nodes: [...], edges: [...] }
  status: text('status').notNull().default('draft'), // 'draft' | 'published'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  uniqueVersion: unique().on(t.pipelineId, t.version),
}));

export const aiPipelineRuns = sqliteTable('ai_pipeline_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineVersionId: integer('pipeline_version_id').notNull().references(() => aiPipelineVersions.id),
  triggeredBy: text('triggered_by').notNull(), // 'job-registry' | 'manual' | 'apk-analysis-complete'
  input: text('input', { mode: 'json' }),
  status: text('status').notNull().default('running'), // 'running' | 'ok' | 'failed' | 'partial'
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});

export const aiPipelineNodeRuns = sqliteTable('ai_pipeline_node_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => aiPipelineRuns.id),
  nodeId: text('node_id').notNull(), // node id within the graph, not a row id
  status: text('status').notNull(), // 'ok' | 'failed' | 'skipped'
  input: text('input', { mode: 'json' }),
  output: text('output', { mode: 'json' }),
  error: text('error'),
  modelUsed: text('model_used'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});
```

Per-node run records are what let the editor show pass/fail/output per node after a run, and what the eval suite asserts against (below). A new migration file is needed — remember the journal `when` gotcha: it must exceed the **max** `when` across every existing entry, not just the one above it.

## Executor semantics

- Topological order; nodes with no unmet dependency run concurrently (the four benign `AgentCall` nodes in the Astérix pipeline run in parallel, same as the three trigger-instruction nodes).
- A node that fails (its tier's fallback chain exhausted, or a `Sink` write rejected) is marked `failed` in its node-run record. The executor does **not** abort the run. Its direct downstream nodes are marked `skipped` unless a `Branch` node explicitly routes the failure to a handling edge.
- Run status is `ok` (every node `ok`), `partial` (some `failed`/`skipped`, at least one `ok`), or `failed` (nothing produced). `partial` is an expected, visible outcome — not a bug — for a run where, say, the Bypass node declines but Overview/Wait Times/Maps all land. This is the direct fix for "one write-model decline wipes the whole notes doc."
- Each `AgentCall` node calls `resolveTierConfig`/`ai-model-router` independently, with its own fresh `refusedModels` set — a research/write split inside *that node's own* turn-loop only, exactly as `ai-agent.ts` does today. Nodes do not share refusal memory with each other: `Bypass Script` failing over to Sonnet 5 tells the executor nothing about whether `Overview` should also skip Opus. Call logging and usage reporting (`ai-call-logger.ts`, `ai-usage-report.ts`) are untouched; they already key off individual requests.

## The Astérix pipeline (worked example)

```
┌─ Overview ──────┐
├─ Wait Times ─────┤→ Sink(patch_analysis_section) × 4, in parallel
├─ Opening Hours ──┤
└─ Maps ───────────┘

┌─ Secrets ────────┐
├─ Curl Examples ──┤→ Sink(patch_analysis_section) × 3, in parallel
└─ Bypass Script ──┘
```

All seven `AgentCall` nodes are High tier. The first four carry the default prompt only. The last three each carry exactly one of the custom rules — expected, going in, to fall back from Opus to Sonnet 5 on every run (that's the known, accepted behavior, not a bug to chase). A decline on `Bypass Script` now produces a `partial` run with six sections written and one `Sink` node red in the editor — not a one-paragraph stub standing in for the whole analysis.

## Frontend

New route `/ui/settings/ai-jobs` (Settings sidebar, matches where `APK Analysis` settings already live). `@xyflow/react` canvas: a node palette (the five kinds above), click a node to edit its config in a side panel (mirrors the plugin detail drawer pattern), a "Run" button that POSTs a manual run and streams per-node status over the existing WebSocket channel the way Live Log already does.

## API surface

New REST endpoints under `/v1/ai-pipelines`: CRUD on pipelines and versions, `POST /:id/publish`, `POST /:id/run`, `GET /runs/:runId` (status + per-node results). The `apk-analysis-complete` hook and `job-registry` call `runPipeline(pipelineId, input)` directly (no HTTP hop) — same as the "keep existing triggers" decision; this project does not touch scheduling.

## Migration & rollout

- `apk-analyzer.ts`'s current notes-generation tool-loop is replaced by a call to `runPipeline()` for the Astérix-pattern pipeline. The `patch_analysis_section`/`write_analysis_notes` MCP tools are unchanged — they're the `Sink` implementation, not replaced.
- `apk-diff-engine.ts` and `disney-menus-fetcher` are explicitly **out of scope for this phase** (see Non-goals) — they keep their current implementations. The contracts above are written generally enough for them to adopt later, which is what "general orchestrator from day one" means here: general contracts now, not a forced migration of every job now.
- Roll out behind a setting (`ai_pipelines_enabled` or similar) so the old loop stays available as a fallback until the new pipeline has run clean on real APK versions for a stretch, then remove the old loop.

## Testing

- **Gate tests** (mocked router, <2s): one suite per node kind (`AgentCall`, `Transform`, `Branch`, `ForEach`, `Sink`), and one for executor traversal — linear, branch, forEach, partial-failure-continues-independent-branches.
- **Periodic eval**: run the real Astérix pipeline (and at least one more known-good APK) against live models, assert (a) no single node failure empties more than its own `Sink`'s section, (b) total token cost doesn't regress against today's single-run design, (c) the benign sections stay on the High tier's top model when the trigger-instruction nodes are the only ones falling back.
- **E2E** (Playwright): build a small pipeline in the editor, run it against a mocked provider, see per-node status go green and output land in notes — same pattern as the plugins-workspace e2e suite.

## Non-goals

- A new scripting language or freeform code-in-the-DB. `Transform` nodes are pre-registered named functions, not arbitrary script.
- Pipeline-owned scheduling/triggers. `job-registry` and the APK-analysis-complete hook keep that role.
- Migrating `apk-diff-engine.ts` or `disney-menus-fetcher` in this phase.
- Reusing or extending `automation-sandbox.ts` — different trust model, wrong fit (see Options considered).
- Multi-input ports on a node. A node needing two independent inputs from upstream is two nodes.

## Open questions for later

- Whether `AgentCall` node prompts should support versioned templates independent of the pipeline version (useful once more than one job reuses a prompt fragment) — not needed for the Astérix pipeline, revisit once a second job migrates.
- Human-in-the-loop / approval nodes (pause a run for a manual check before a `Sink` fires) — no current job needs it; noting it so the node-kind enum isn't assumed closed forever.
