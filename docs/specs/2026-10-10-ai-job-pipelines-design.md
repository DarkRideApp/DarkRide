# AI job pipelines: design

Date: 2026-10-10
Status: **Decided (Approach A), not yet built.** Scope, approach and first migration target were chosen by Cube; node contracts, data model and rollout were settled during design. Revised 2026-10-10 twice: after an adversarial review found a load-bearing contradiction, then again after Cube's multi-trigger and memoization questions surfaced two more real gaps — see the end of this doc for what changed and why, in order.

## The problem

Found while reviewing the Parc Astérix (`fr.parcasterix.appli.android`) AI analysis notes, which had degraded from a detailed writeup (version 390) to a one-paragraph stub (version 431) despite the agent run doing real work (37+ tool calls, a full SSL-pinning Frida bypass generated).

Two independent root causes, both structural to how `apk-analyzer.ts` runs the job today — one long-lived agent conversation, one system prompt, every tool call (read and write) replayed through the same growing context:

1. **Instruction-level refusal, whole-run blast radius.** Settings → APK Analysis has three custom rules on top of the default prompt: document secrets, include cURL examples, write Frida bypass scripts. Each one *individually* trips Anthropic's cyber-safety classifier on `claude-opus-5-5` — confirmed by the Astérix run, where Opus refused at turn 0, before any tool call ran. Correction from the review: this instruction text is the saved `analysis_ai_prompt` setting, sent as the first **user** turn (`ai-agent.ts:435`), not the `system` role — the spec's earlier drafts said "system prompt" throughout, which overstated what's actually proven about *why* the classifier fires. What's solid: the whole blob triggers at turn 0 regardless of role. The existing router fallback (Opus → Sonnet 5 → OpenRouter Free) catches this correctly, but because it's one agent run fed one instruction blob, the *entire* run — including the sections the default prompt handles fine (Overview, Wait Times, Maps) — gets demoted to the fallback model. One instruction's trigger taxes every section's quality.
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
2. **Pipeline definition + executor** (`backend/services/ai-jobs/pipeline-runner.ts`) — pipelines are versioned rows holding a typed graph. The executor topologically walks it, runs independent branches concurrently, and persists a per-node run record. An `AgentCall` node calls through `ai-agent-factory.ts`'s `BoundAgent.handleMessage` (not `ai-agent.ts` directly — that's where identity resolution and call-logging start/end already live, `ai-agent-factory.ts:170-208`), which calls `ai-model-router.ts`/`resolveTierConfig` underneath. The router's per-tier fallback (Opus → Sonnet 5 → OpenRouter Free on refusal or rate limit) is reused as-is. What is **not** reused, corrected after review: `ai-agent.ts`'s two-phase research/write *escalation* (a cheap model reads, a separate expensive model gets replayed the full context to approve a write). That mechanism only exists because today's single long-lived agent calls `patch_analysis_section` itself, mid-loop, and the code has to decide which model's tool call to trust. In this design `Sink` owns the write deterministically (see Node primitives) — `AgentCall` nodes never carry a write-class tool in their allowlist, so there is nothing to escalate. This also means each `AgentCall` needs exactly one tier, not a research/write pair — matching the node contract below, and removing the cost-regression risk a research/write pair would have introduced if `AgentCall` had kept both halves on the (then uniformly "High") tier.
   Two capabilities this reuses the *name* of but not the *code* of, flagged by the review as net-new surface: (a) an arbitrary tool allowlist per call — `ai-tools.ts`'s `getToolDefinitionsForUser` returns every tool registered for a page context today, filtered only by scope/unattended, with no subset-filtering; `AgentCall` needs a new thin wrapper over it. (b) a per-call instruction fragment — `handleMessage` has no parameter for one today; the `instructionTemplate` field is sent the same way `analysis_ai_prompt` is sent today (the first user turn), not threaded into `buildSystemPrompt()`. Both are small, but they are new code, not reuse — said so explicitly because the first draft of this doc claimed otherwise.
3. **Visual editor** (`frontend/pages/ai-jobs/`) — `@xyflow/react` canvas. The graph the editor shows *is* the stored pipeline definition; there is no separate authoring format to keep in sync. A manual "Run" triggers a live run; each node reflects its own run state (idle/running/ok/failed) and shows its last input/output on selection.

`@xyflow/react` (formerly React Flow) is the pick for the canvas: the de facto standard for in-browser node graphs, actively maintained, what tools like n8n are built on. Nothing else in the space is close on adoption or maintenance. Not currently a dependency — this adds it.

## Node primitives

| Kind | Does | Notes |
|---|---|---|
| `Trigger` | Entry point, declares and expands the run's input | Pluggable per job family, same as `Sink`. For `apk-analysis`: takes `{ versionId }` (what `job-registry`/the APK-analysis-complete hook actually has), expands it into an `ApkContext` struct (`appName`, `packageName`, `versionName`, `versionCode`, `fileSizeBytes`, `downloadedAt`, `source`, …) using the same data `get_apk_overview`/`get_app_versions` already expose. **One or more `Trigger` nodes per pipeline version** — each is an independent root (zero incoming edges). Every `Trigger` in a pipeline must declare the **same output schema**, so a downstream `{{trigger.field}}` template never needs to know which entry point fired. Each node in the graph must be reachable from exactly **one** `Trigger` — triggers partition the graph into disjoint zones; the executor rejects a graph where a node is reachable from more than one (see Executor semantics — this is what keeps multi-trigger from reopening the AND-join ambiguity). A run fires exactly one `Trigger`; nodes outside its reachable zone are `inactive` for that run, not `skipped`. |
| `AgentCall` | Runs one scoped, **read-only** agent turn-loop | `{ tier, instructionTemplate, toolAllowlist }`. Never holds a write-class tool (see Executor semantics — `Sink` owns writing). Scoped tools + scoped instruction text is the actual fix for problem 1: a `Secrets` node only ever carries the secrets instruction, an `Overview` node only ever carries the default prompt. No single model call bundles unrelated trigger instructions, so one node's refusal can't touch another's quality. |
| `Transform` | Deterministic reshape/merge | A named, pre-registered pure TS function, picked by name in the graph — not freeform code stored in the DB. E.g. `mergeNotesSections`, `dedupeFindings`. This is the deterministic half of every job: the LLM nodes produce raw material, `Transform` nodes make it consistent. |
| `Branch` | Picks an outgoing edge | Predicate over the upstream node's output and/or run status (e.g. `status !== 'ok'` → the fallback edge). To actually catch a failure, a `Branch` must be wired as the **immediate** child of the node it's watching — see Executor semantics. |
| `ForEach` | Runs a subgraph per item | Iterates a list input (e.g. one `AgentCall` per finding category), collects per-item results into an array — see Executor semantics for how item-level failure is handled. |
| `Sink` | Terminal, deterministic write | Pluggable per job family, same as `Trigger`. APK analysis's sink calls `patch_analysis_section` directly — it is a plain function, not a model call. A `Sink` either writes or throws; there is nothing for it to "decline." This structurally removes problem 2 (the old write-tier-decline flakiness) rather than just containing its blast radius: there is no second model in the loop to flake. |

Every node (`Trigger` excepted) consumes one JSON-serializable input and produces one JSON-serializable output. A node's input is an object keyed by source: `trigger` (the `Trigger` node's output, available to **every** node in the graph, not just its direct children — this is what a prompt template reaches for) plus one key per direct incoming edge, named by that edge's source node id. No named ports in this version — a node with two outputs a downstream node needs separately should be two nodes. `Trigger`, `AgentCall` and `Sink` each declare a lightweight output **schema** (field name, type, one-line description) alongside their implementation — not runtime-enforced (the executor stays duck-typed JSON), only used by the editor to populate the variable picker described below.

## Template resolution and the prompt editor

Feedback from Cube mid-review: the editor needs a real way to write a prompt against the pipeline's actual data, not just free text per node, and the `Trigger` node is what supplies that data.

- **Syntax**: `{{dotted.path}}` only — a lookup into the node's resolved input, never an expression (no arithmetic, no conditionals, no function calls). Keeps resolution in deterministic space: a pure string-substitution function, not something that runs through a model or needs its own interpreter. `{{trigger.appName}}`, `{{trigger.versionName}}`, `{{agent-overview.summary}}` (a direct predecessor's output field) are valid; `{{trigger.fileSizeBytes / 1024}}` is not — a `Transform` node does unit conversion if a job needs it, the template does not.
- **Resolution timing**: happens once per `AgentCall` node run, immediately before `BoundAgent.handleMessage` is called — `instructionTemplate` is a static string stored in the graph; the *resolved* instruction text (not the template) is what's recorded in that node run's `input` column, so a run's audit trail shows exactly what was sent, not just the template that produced it.
- **Fail loud on a miss.** A placeholder that doesn't resolve — typo'd path, a field the referenced node doesn't actually produce — throws rather than being left as literal `{{...}}` text in what gets sent to the model. That failure is an ordinary node failure (`failed`, visible, downstream skipped per Executor semantics), not a silent bad prompt. Silent degradation is the exact failure class this whole project exists to kill; a template engine that fails open would reintroduce it one layer up.
- **The prompt editor** (side panel, `AgentCall` nodes): a real textarea bound to `instructionTemplate`, not a read-only fact. A variable picker lists every field in scope — `trigger`'s declared output schema (always present) plus the output schema of whatever feeds this node directly — and inserts `{{trigger.appName}}` at the cursor on click. A live preview renders the template against the pipeline's last run's actual input (or the `Trigger`'s schema defaults before any run exists), so what you see while editing is what would actually be sent, not a guess.
- **For `apk-analysis`**, the built-in `Trigger` node's output schema is the `ApkContext` struct: `appName`, `packageName`, `versionName`, `versionCode`, `fileSizeBytes`, `downloadedAt`, `source` — the same fields `get_apk_overview`/`get_app_versions` already expose, not new data DarkRide has to start tracking.

## Data model

New tables in `backend/db/schema.ts` (Drizzle, sqlite, matching existing conventions):

```ts
type PipelineGraph = { nodes: PipelineNode[]; edges: PipelineEdge[] };
type NodeRunStatus = 'ok' | 'failed' | 'skipped' | 'inactive'; // inactive: outside the fired Trigger's reachable zone
type RunStatus = 'running' | 'ok' | 'failed' | 'partial';

export const aiPipelines = sqliteTable('ai_pipelines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  jobKind: text('job_kind').notNull(), // 'apk-analysis' | future kinds
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const aiPipelineVersions = sqliteTable('ai_pipeline_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineId: integer('pipeline_id').notNull().references(() => aiPipelines.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(), // monotonic per pipeline
  graph: text('graph', { mode: 'json' }).$type<PipelineGraph>().notNull(),
  status: text('status', { enum: ['draft', 'published'] }).notNull().default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => ({
  uniqueVersion: unique().on(t.pipelineId, t.version),
}));

export const aiPipelineRuns = sqliteTable('ai_pipeline_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pipelineVersionId: integer('pipeline_version_id').notNull().references(() => aiPipelineVersions.id, { onDelete: 'cascade' }),
  triggerNodeId: text('trigger_node_id').notNull(), // which Trigger node (graph node id) fired this run
  triggeredBy: text('triggered_by').notNull(), // 'job-registry' | 'manual' | 'apk-analysis-complete'
  input: text('input', { mode: 'json' }).$type<Record<string, unknown>>(), // raw input the fired Trigger expands, e.g. { versionId }
  reuseUnchanged: integer('reuse_unchanged', { mode: 'boolean' }).notNull().default(false), // memoization opt-in for this run
  status: text('status', { enum: ['running', 'ok', 'failed', 'partial'] }).notNull().default('running'), // rolled up over active-zone nodes only — inactive nodes don't count
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});

export const aiPipelineNodeRuns = sqliteTable('ai_pipeline_node_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => aiPipelineRuns.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(), // node id within the graph, not a row id
  status: text('status', { enum: ['ok', 'failed', 'skipped', 'inactive'] }).notNull(),
  input: text('input', { mode: 'json' }).$type<Record<string, unknown>>(),
  inputHash: text('input_hash'), // sha256 of resolved input; memoization cache key is (nodeId, pipelineVersionId, inputHash)
  wasMemoized: integer('was_memoized', { mode: 'boolean' }).notNull().default(false), // output reused from a prior run, not freshly computed
  output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
  error: text('error'),
  modelUsed: text('model_used'), // null for Trigger/Transform/Branch/ForEach/Sink — only AgentCall calls a model
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
});
```

Cascade deletes on all three FKs, matching the established pattern (`apkNotes.versionId`, `aiCallRequest.callId`, etc. — see `fk_delete_cleanup_pattern` in project memory, the bug class this project has hit before: a parent delete either throws with `foreign_keys=ON` or orphans children without it). `$type<T>()` on every `json` column and `{ enum: [...] }` on every fixed-value `status` column, matching the dominant style elsewhere in `schema.ts` rather than the plain `text()` the first draft used.

Per-node run records are what let the editor show pass/fail/output per node after a run, and what the eval suite asserts against (below). A new migration file is needed — remember the journal `when` gotcha: it must exceed the **max** `when` across every existing entry, not just the one above it.

## Executor semantics

- **A run fires exactly one `Trigger`.** Before anything else, the executor computes that `Trigger`'s reachable zone (every node reachable from it by following edges forward) and marks every node *outside* that zone `inactive` — not `skipped`, not counted toward `ok`/`partial`/`failed` rollup, just "not part of this run." Because the graph validator already guarantees every node is reachable from exactly one `Trigger` (see Node primitives), this is an unambiguous partition, not a fuzzy "mostly reachable" judgment call.
- Topological order; nodes with no unmet dependency run concurrently (the four benign `AgentCall` nodes in the Astérix pipeline run in parallel, same as the three trigger-instruction nodes).
- A node that fails (its tier's fallback chain exhausted, or a `Sink` write throwing) is marked `failed` in its node-run record. The executor does **not** abort the run. Its direct downstream nodes are marked `skipped`.
- **Skip propagates transitively**, same as failure: a `skipped` node's own downstream is also `skipped`, not run with absent input. A node with two or more incoming edges runs only if *every* edge resolved `ok` (strict AND-join) — the only join policy the Astérix graph needs, since nothing in it has more than one incoming edge; a job that needs an OR-join is future work, not assumed here.
- **`Branch` is the one kind exempt from the default skip rule** — it always runs once its predecessors settle (`ok`, `failed`, or `skipped`), receiving an envelope describing the outcome, not just a value. This only works if the `Branch` is wired as the **immediate** child of the node it's meant to catch: skip propagation marks everything between a failure and a non-adjacent `Branch` as `skipped` before the `Branch` ever evaluates, same as any other node, so a fallback edge that isn't a direct child never fires. Document this on the node when building a pipeline that uses `Branch` for failure handling.
- **`ForEach` failure is data, not an executor-level status.** A `ForEach` node runs its per-item subgraph via `Promise.allSettled`; per-item outcomes (`ok`/`failed` + error) live *inside* its output array. The `ForEach` node itself reports `ok` as long as it didn't throw outright (e.g. its input list was malformed) — it does not go `failed` just because some items did. Downstream nodes (typically a `Transform`) decide what a partial item-failure rate means for the job; the generic executor stays domain-agnostic rather than guessing a threshold.
- Run status is `ok` (every **active-zone** node `ok`), `partial` (some `failed`/`skipped` in the active zone, at least one `ok`), or `failed` (nothing in the active zone produced). `inactive` nodes never factor in — a "Quick Rescan" run reports against its own 2-node zone, not "1/15 nodes ok" because the other 13 were never in scope. `partial` is an expected, visible outcome — not a bug — for a run where, say, the Bypass node declines but Overview/Wait Times/Maps all land. This is the direct fix for "one write-model decline wipes the whole notes doc."
- Each `AgentCall` node calls `resolveTierConfig`/`ai-model-router` independently through `BoundAgent.handleMessage`, with its own fresh `refusedModels` set scoped to that one node's turn-loop — one tier, no research/write pair (see Architecture: `Sink` owns writing, so there is nothing to escalate to a second model). Nodes do not share refusal memory with each other: `Bypass Script` failing over to Sonnet 5 tells the executor nothing about whether `Overview` should also skip Opus. Call logging and usage reporting (`ai-call-logger.ts`, `ai-usage-report.ts`) are untouched; they already key off individual requests.
- **Concurrent `Sink` writes to the same notes doc rely on an existing, previously-undocumented invariant.** `patchNoteSection` (`apk-notes.ts`) does a synchronous read-splice-write with no `await` between the read and the write, so same-tick concurrent `Sink` calls happen to serialize correctly today — not because anything here guarantees it. Flagging it as load-bearing: a gate test must assert four concurrent `Sink` writes to four different sections of the same run all land (no lost update), and if `apk-notes.ts`'s storage ever goes async, that test is what catches the regression before a notes doc silently loses a section again.

## Memoization (opt-in, per run)

Added per Cube's feedback — a real gap, not in the first draft at all.

- **Off by default.** A run is always fresh unless the caller passes `reuseUnchanged: true` (the manual-run form in the editor exposes this as a checkbox next to Run). No surprise staleness: forgetting the flag just means normal behavior.
- **Cache key**: `(nodeId, pipelineVersionId, inputHash)` — `inputHash` is a stable hash of the node's fully *resolved* input (for `AgentCall`, that's the resolved instruction text, tool allowlist and tier together, not the template string). Scoped to one pipeline version deliberately: editing the graph publishes a new version, and cross-version cache reuse is not attempted in v1 — simpler, and avoids a stale cache surviving a structural change to the node it's attached to.
- **Lookup**: before executing a node, the executor checks for the most recent prior run of the same pipeline version with a node-run row for this `nodeId` whose `inputHash` matches and whose `status` was `ok`. A hit sets `wasMemoized: true` and reuses that row's `output` instead of calling `handleMessage`/the `Sink` function again.
- **`AgentCall` memoization is a cost/speed tradeoff, not a correctness guarantee.** Reusing a prior answer for unchanged input is not the same claim a build-system cache makes ("identical input *guarantees* identical output") — an LLM given the same prompt twice is not guaranteed to answer identically. This is a deliberate "accept the last answer instead of paying for a new one," and the editor labels a memoized node `CACHED`, visually distinct from a freshly-produced `OK`, so it's never ambiguous which guarantee applies to what you're looking at.
- **`Sink` memoization is safe for a different reason**: its writes are idempotent (`patch_analysis_section` replaces a section wholesale), so skipping a write whose input is byte-identical to the write that already landed changes nothing about the resulting notes doc.
- **`Trigger` is never memoized.** It's cheap (a DB/file lookup, not a model call) and its entire job is reading current external state — memoizing the one node whose point is "what does the world look like right now" would defeat it.
- This is the actual mechanism for "I only changed the Bypass Script prompt, don't re-run everything" — not a second `Trigger`. A second `Trigger` is for a genuinely different, non-overlapping scope (see below); memoization is for cheaply re-running the *same* scope after a small edit.

## The Astérix pipeline (worked example)

```
                  ┌─ Overview ──────┐
                  ├─ Wait Times ─────┤→ Sink(patch_analysis_section) × 4, in parallel
Trigger ──┬───────┤ Opening Hours ──┤
"Full Analysis"   └─ Maps ───────────┘
(ApkContext)
          │
          └───────┌─ Secrets ────────┐
                   ├─ Curl Examples ──┤→ Sink(patch_analysis_section) × 3, in parallel
                   └─ Bypass Script ──┘

Trigger ──────── AgentCall(Diff Summary) ──→ Sink(patch_analysis_section)
"Quick Rescan"
(ApkContext, same schema as "Full Analysis")
```

`Trigger` ("Full Analysis") takes `{ versionId: 431 }` from the APK-analysis-complete hook and expands it into the `ApkContext` struct (`appName: "Parc Astérix"`, `packageName: "fr.parcasterix.appli.android"`, `versionName: "6.10.1"`, …), available to all seven `AgentCall` nodes in its zone via `{{trigger.*}}`. `Overview`'s `instructionTemplate` opens with something like `Analyze {{trigger.appName}} ({{trigger.packageName}}) version {{trigger.versionName}}.` instead of a static string — the same instruction text every version's Overview node gets, but now driven by real data instead of being re-typed per app.

The second `Trigger`, "Quick Rescan," is a disjoint zone of its own — one `AgentCall` that only checks what changed since the last analyzed version, one `Sink`. It declares the identical `ApkContext` output schema as "Full Analysis" (the adopted constraint), so its one `AgentCall`'s template can also use `{{trigger.versionName}}` with no special-casing — but it shares no nodes and no edges with the seven-node zone above it. Firing it marks all seven `Full Analysis`-zone `AgentCall`/`Sink` pairs `inactive` for that run; firing `Full Analysis` marks `Diff Summary` and its `Sink` `inactive`. Neither run's status rollup counts the other zone's nodes.

All seven `Full Analysis` `AgentCall` nodes are High tier. The first four carry the default instruction only. The last three each carry exactly one of the custom rules — expected, going in, to fall back from Opus to Sonnet 5 on every run (that's the known, accepted behavior, not a bug to chase). A decline on `Bypass Script`'s `AgentCall` now produces a `partial` run with six sections written, that one `Sink` skipped (never invoked — its upstream `AgentCall` is the one marked `failed`), and both red in the editor — not a one-paragraph stub standing in for the whole analysis. Re-running with `reuseUnchanged: true` after only editing `Bypass Script`'s template reuses the other six `AgentCall`/`Sink` pairs as `CACHED` and only re-executes `Bypass Script` and its `Sink` fresh.

## Frontend

New route `/ui/settings/ai-jobs` (Settings sidebar, matches where `APK Analysis` settings already live). `@xyflow/react` canvas: a node palette (the six kinds above), click a node to edit its config in a side panel (mirrors the plugin detail drawer pattern — for `AgentCall` that's the prompt editor described above). When a pipeline version has more than one `Trigger`, an entry-point picker next to Run selects which one fires (defaults to the only one when there's just one); a "Reuse unchanged nodes" checkbox next to it sets `reuseUnchanged`. Run first shows a small form built from the fired `Trigger`'s declared input shape — for `apk-analysis`, a picker over tracked APK versions rather than free-typed fields — then POSTs a manual run and streams per-node status over the existing WebSocket channel the way Live Log already does. A node outside the fired `Trigger`'s zone renders dimmed with an `INACTIVE` badge rather than idle/ok/failed styling, so it reads as "not part of this run," not as a stalled node.

## Security

- The new REST surface gates the same way the data it exposes already does: `GET`s require `core.apk:read`, mutating routes (`publish`, `run`) require `core.apk:manage` — matching the scopes `patch_analysis_section`/`read_analysis_notes` already carry (`ai-tool-definitions.ts`). `GET /runs/:runId` in particular must not be left ungated: a `Secrets`/`Bypass Script` node run's `output` column holds the same real credentials and working bypass code the rest of the system already restricts, and this is a second, independently-controlled copy of it.
- **Open question the periodic eval must answer, not assume**: does scoping a trigger instruction into its own small, otherwise-empty `AgentCall` node reduce the chance of a cyber-classifier refusal, or concentrate it? Today that instruction sits inside one long, mostly-benign 30-tool-call conversation; in this design, `Bypass Script`'s entire transcript is nothing but SSL-pinning research and generated exploit code, with no benign content diluting it. If the classifier scores on density of risky content rather than pure presence, scoping could make the *fallback* model (Sonnet 5) more likely to refuse too, not just Opus. The worked example already expects 100% Opus→Sonnet fallback on these three nodes "on every run" and treats that as acceptable — the eval needs to confirm Sonnet's fallback rate on the scoped version isn't *worse* than its fallback rate in today's diluted, whole-run version before calling this a clean win rather than a risk shift.

## API surface

New REST endpoints under `/v1/ai-pipelines`: CRUD on pipelines and versions, `POST /:id/publish`, `POST /:id/run` (body: `{ triggerNodeId, input, reuseUnchanged? }` — `triggerNodeId` required once a version has more than one `Trigger`, optional and inferred when it has exactly one), `GET /runs/:runId` (status + per-node results, including each node's `inactive`/`wasMemoized` state) — scopes as above. The `apk-analysis-complete` hook and `job-registry` call `runPipeline(pipelineId, triggerNodeId, input)` directly (no HTTP hop) — same as the "keep existing triggers" decision; this project does not touch scheduling.

## Migration & rollout

- `apk-analyzer.ts`'s current notes-generation tool-loop is replaced by a call to `runPipeline()` for the Astérix-pattern pipeline. The `patch_analysis_section`/`write_analysis_notes` MCP tools are unchanged — they're the `Sink` implementation, not replaced.
- `apk-diff-engine.ts` and `disney-menus-fetcher` are explicitly **out of scope for this phase** (see Non-goals) — they keep their current implementations. The contracts above are written generally enough for them to adopt later, which is what "general orchestrator from day one" means here: general contracts now, not a forced migration of every job now.
- Roll out behind a setting (`ai_pipelines_enabled` or similar) so the old loop stays available as a fallback until the new pipeline has run clean on real APK versions for a stretch, then remove the old loop.

## Testing

- **Gate tests** (mocked router, <2s): one suite per node kind (`Trigger`, `AgentCall`, `Transform`, `Branch`, `ForEach`, `Sink`), one for template resolution (dotted-path success, unresolved-placeholder throws), one for the concurrent-`Sink`-writes invariant (four concurrent writes to four sections of one run, no lost update), one for executor traversal — linear, branch (adjacent vs. non-adjacent to the failure), forEach (per-item failure stays data, node itself stays `ok`), partial-failure-continues-independent-branches, skip-propagates-transitively — and one for multi-trigger: the graph validator rejects a node reachable from two `Trigger`s, firing one `Trigger` marks the other zone's nodes `inactive` (not counted in rollup), and a memoization hit sets `wasMemoized` and skips re-execution while a miss (changed `inputHash`) runs fresh.
- **Periodic eval**: run the real Astérix pipeline (and at least one more known-good APK) against live models, assert (a) no single node failure empties more than its own `Sink`'s section, (b) total token cost doesn't regress against today's single-run design — now straightforward to check, since `AgentCall` is single-tier with no write-escalation replay burning extra tokens, (c) the benign sections stay on the High tier's top model when the trigger-instruction nodes are the only ones falling back, (d) the Group B fallback rate (see Security) isn't worse scoped than it is in today's diluted whole-run version.
- **E2E** (Playwright): build a small pipeline (`Trigger` → `AgentCall` → `Sink`) in the editor, including a templated prompt referencing a `Trigger` variable, run it against a mocked provider, see per-node status go green and output land in notes — same pattern as the plugins-workspace e2e suite.

## Non-goals

- A new scripting language or freeform code-in-the-DB. `Transform` nodes are pre-registered named functions, not arbitrary script. Prompt templates are dotted-path lookups only — no expressions, no function calls; a job needing computed values puts a `Transform` node in front of the `AgentCall` that needs them.
- Pipeline-owned scheduling/triggers. `job-registry` and the APK-analysis-complete hook keep that role — not to be confused with the `Trigger` *node kind*, which only defines and expands a run's input shape, the same way `Sink` only defines a run's output write; neither owns when a run starts.
- Migrating `apk-diff-engine.ts` or `disney-menus-fetcher` in this phase. `apk-diff-engine.ts` reads the same global settings keys `apk-analyzer.ts` uses today (`analysis_tier_research`/`analysis_tier_write`, `index.ts:566-569`) — those keys stay live and owned by the old (non-pipeline) path until `apk-diff-engine.ts` migrates too; this phase does not retire or repurpose them, even though the new per-node `tier` field replaces their role for the migrated APK-analysis pipeline specifically.
- Reusing or extending `automation-sandbox.ts` — different trust model, wrong fit (see Options considered).
- Multi-input ports on a node. A node needing two independent inputs from upstream is two nodes.
- Reconverging/overlapping `Trigger` zones — a node reachable from two different `Trigger`s in the same graph. The AND-join rule would need to treat an edge from a non-fired `Trigger`'s zone as "not applicable" rather than "failed precondition," which is a real, unresolved semantics question, not a simple extension. Today's answer to "cheaply re-run part of a zone I already ran" is memoization, not a second overlapping `Trigger` — see Open questions.
- Cross-pipeline-version memoization. A cache hit only matches within the same `pipelineVersionId`; editing and republishing the graph starts every node cold again, even for nodes whose config didn't change.

## What changed after the first draft

A background review agent cross-checked every concrete claim in the first draft against the real code and found one contradiction that decided the shape of everything else, plus several places where "none of this is rebuilt" understated the actual implementation surface. Resolved here, not deferred:

1. **The central contradiction**: did `AgentCall` call the write tool itself (today's mechanism, replayed per node), or does `Sink` write deterministically? The first draft asserted both in different sections. Resolved in favor of `Sink` writing deterministically — it's the stronger fix (structurally removes the write-tier-decline flakiness instead of just shrinking its blast radius) and it simplifies the node contract (one tier per `AgentCall`, not a research/write pair, which also closes a real cost-regression risk the ambiguity had opened).
2. Three "none of this is rebuilt" claims corrected: the call chain goes through `ai-agent-factory.ts`'s `BoundAgent` (identity + call-logging), not raw `ai-agent.ts`; an arbitrary tool allowlist per call is new surface on `ai-tools.ts`, not existing; the instruction text is sent as a user turn today, not the `system` role, so "system prompt" in the first draft was imprecise language, not a design claim about where to inject `instructionTemplate`.
3. Schema: cascade deletes, `$type<T>()`, enum-typed status columns added — matches the established pattern and avoids repeating a bug class this project has hit before.
4. Executor semantics: skip now explicitly propagates transitively; `Branch` must be an immediate child of what it's catching, documented as a modeling constraint rather than left implicit; `ForEach` per-item failure is explicitly data, not an executor-level status; the concurrent-`Sink`-write safety that exists today by implementation accident is now a documented, tested invariant.
5. Added a Security section: REST scope gating, and an explicit, unresolved question — does scoping a risky instruction into its own node reduce classifier-refusal risk or concentrate it? — turned into a periodic-eval assertion instead of an assumed win.
6. Non-goals: `apk-diff-engine.ts`'s shared tier-settings keys are explicitly called out as staying live, not silently retired.

Separately, Cube's mid-review feedback added the `Trigger` node kind and prompt-template resolution (Template resolution and the prompt editor, above) — not a response to the audit, a real gap the audit didn't cover: the first draft had no way for a prompt to reference the APK it's actually analyzing short of hardcoding it per pipeline.

## Open questions for later

- Whether `AgentCall` node prompts should support versioned templates independent of the pipeline version (useful once more than one job reuses a prompt fragment) — not needed for the Astérix pipeline, revisit once a second job migrates.
- Human-in-the-loop / approval nodes (pause a run for a manual check before a `Sink` fires) — no current job needs it; noting it so the node-kind enum isn't assumed closed forever.
- Reconverging `Trigger` zones (Non-goals) — if a real job ever needs "two entry points that both legitimately want to re-run the exact same downstream nodes," that's the point to revisit the AND-join rule, not before. Likely needs a per-edge "optional" flag or a redefined join semantics, not a quick patch.
- Cross-version memoization — once pipelines are edited often enough that a full cold re-run after every small edit is annoying, revisit whether a node's cache can survive a version bump when its own config (not just its resolved input) is unchanged. Needs a stable per-node identity across versions first, which the current `nodeId`-within-`graph` model doesn't guarantee today.

## 2026-10-10, later: multi-trigger and memoization

Cube asked two follow-up questions after seeing the mockup: can a pipeline have multiple triggers (with the constraint that they share input variables, for simplicity), and are nodes memoized. Both were real gaps — neither was in the first draft or the review. Added: multiple `Trigger` nodes per pipeline version, each an independent root, constrained to disjoint reachable zones (no node fed by two triggers — reconvergence is a genuinely harder problem, deferred, see Non-goals) and a shared output schema (Cube's proposed constraint, adopted outright); a new `inactive` node-run status for nodes outside the fired trigger's zone, excluded from run-status rollup; and opt-in, per-run memoization (`reuseUnchanged`) keyed on `(nodeId, pipelineVersionId, resolved-input-hash)`, with an explicit caveat that `AgentCall` memoization is a cost tradeoff, not a correctness guarantee, since an LLM isn't a pure function. The two features turned out to answer overlapping intuitions from different angles: multi-trigger is for genuinely disjoint scopes (a full analysis vs. a quick diff-only check); memoization is what actually delivers "cheaply re-run just the node I edited" within one scope, which is a better fit for that need than a second, reconverging trigger would have been.
