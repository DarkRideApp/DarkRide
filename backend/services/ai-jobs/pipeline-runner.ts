import type {
  PipelineGraph, PipelineNode, PipelineEdge, NodeConfig, NodeRunStatus, RunStatus, Envelope,
  TriggerConfig, AgentCallConfig, TransformConfig, BranchConfig, ReportConfig, ForEachConfig, SinkConfig,
} from './types';

export type { PipelineGraph };

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

/**
 * Runs a pipeline graph to completion against an injected NodeExecutors map.
 *
 * Runs the graph in waves: each round executes every node whose dependencies are already
 * satisfied, concurrently via Promise.all, then recomputes the next round's ready set. A
 * failed or skipped predecessor marks its successor 'skipped' too, and because a node only
 * becomes ready once every incoming edge's source already has a recorded result, that skip
 * status propagates transitively across however many hops separate it from the failure —
 * not just to the immediate child.
 *
 * `Branch`/`Report` are envelope nodes: they are exempt from the skip above and instead receive
 * an `Envelope` built from `results` (which, unlike `input`, carries failure/skip/inactive
 * info). A `Branch`'s non-chosen outgoing edge marks its target `'inactive'` rather than
 * `'skipped'` — see `unavailabilityStatus` below for why the two must never be conflated.
 *
 * Still outstanding, for Tasks 16-17 to add to this same function in place:
 *   - Task 16: multi-trigger zone partitioning (graph-validator.ts already enforces this
 *     statically; the executor still needs to run each zone from its own trigger)
 *   - Task 17: opt-in memoization
 *
 * `triggerNodeId` names which node in `graph.nodes` is the Trigger to seed with `rawInput` —
 * this is the real parameter driving the special-case "seed this node with rawInput instead of
 * its upstream outputs" behavior, and it is also what every other node's input gets keyed
 * under as `trigger` (see `input.trigger = outputs.get(triggerNodeId)` below). It must never
 * be replaced with a literal string: one test fixture's Trigger node happens to be named
 * 'trigger', but that's a coincidence of that fixture, not a contract — another fixture names
 * its Trigger 'trigger-full' specifically to catch a hardcoded-literal shortcut here.
 */
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

  const order = topologicalOrder(graph);

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
      const unavailability = unavailabilityStatus(nodeId, graph, byId, results);
      const isEnvelopeNode = node.config.kind === 'Branch' || node.config.kind === 'Report';

      // Report gets its OWN eligibility check, separate from the generic unavailabilityStatus
      // used by every other node kind (Branch included). Branch has exactly one logical
      // predecessor, so "any dead input" and "all dead inputs" are the same thing for it —
      // unavailabilityStatus's all-or-nothing answer is correct there. Report is different by
      // design: it's built to assemble a mix of outcomes across many declared sections (the spec
      // is explicit — "it always runs once every `from` node settles... receiving an envelope...
      // per section rather than requiring all-`ok`"). If Report used the generic check, ONE
      // section behind a non-chosen Branch edge among several other genuinely live sections
      // would mark the whole Report 'inactive' and skip it entirely — silently dropping every
      // other section's real output and reporting the run 'ok' regardless, which is exactly the
      // silent-data-loss failure Report exists to prevent. So Report goes 'inactive' only when
      // EVERY incoming edge is dead; if even one is live (ok/failed/skipped all count as live —
      // only 'inactive' counts as dead), Report runs normally and gets its usual per-section
      // envelopes (buildEnvelope already turns a dead section into {status:'inactive'}, which
      // runReport's placeholder logic treats the same as failed/skipped for that one section).
      if (node.config.kind === 'Report') {
        const incomingEdges = graph.edges.filter(e => e.to === nodeId);
        // Per-EDGE liveness, not per-parent: a Report fed directly off a Branch's non-chosen
        // labeled edge has a parent (the Branch) that resolved 'ok' — checking the parent's own
        // collapsed status would miss that this specific edge was never the chosen one. isEdgeDead
        // already accounts for both a dead ('inactive') parent and a Branch-label mismatch on
        // this exact edge, which is what correctly marks that case dead too.
        const allIncomingDead = incomingEdges.length > 0
          && incomingEdges.every(e => isEdgeDead(e, byId, results));
        if (allIncomingDead) {
          results.set(nodeId, { nodeId, status: 'inactive' });
          return;
        }
        // Otherwise fall through and run Report normally, below.
      } else {
        // 'inactive' means this node sits on a path that was structurally never going to run —
        // a dead Branch edge, not a real failure anywhere upstream. That applies to every other
        // node kind (including Branch, per the comment above): the envelope-node exemption below
        // exists so a Branch can still make a decision after a REAL ancestor failure, not so it
        // can run code (including choosing yet another edge) on a path that was never chosen in
        // the first place. Checked before the envelope exemption, not folded into it.
        if (unavailability === 'inactive') {
          results.set(nodeId, { nodeId, status: 'inactive' });
          return;
        }

        // Branch is an envelope node: it runs even when its immediate parent genuinely failed
        // (it receives an Envelope describing what happened instead of being skipped) — but only
        // for a real failure, never for the dead-path case handled above.
        if (unavailability === 'skipped' && !isEnvelopeNode) {
          results.set(nodeId, { nodeId, status: 'skipped' });
          return;
        }
      }

      let branchEnvelope: Envelope | undefined;
      let reportEnvelopes: Record<string, Envelope> | undefined;
      if (node.config.kind === 'Branch') {
        branchEnvelope = buildEnvelope(incoming[0], results);
      } else if (node.config.kind === 'Report') {
        // Edge-aware, not parent-status-based: a section sourced directly from a Branch's
        // non-chosen edge has a parent (the Branch) that resolved 'ok' (it successfully routed),
        // so buildEnvelope(e.from, results) would return {status:'ok', output:{chosenEdge}} —
        // which has no real section content and crashes runReport's assembly, taking every OTHER
        // live section down with it. isEdgeDead already knows this edge specifically was never
        // the chosen one; when it says dead, the section gets an honest {status:'inactive'}
        // placeholder instead of the Branch's raw routing output.
        const reportIncomingEdges = graph.edges.filter(e => e.to === nodeId);
        reportEnvelopes = Object.fromEntries(
          reportIncomingEdges.map(e => [
            e.from,
            isEdgeDead(e, byId, results) ? { status: 'inactive' as const } : buildEnvelope(e.from, results),
          ]),
        );
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
        const output = await runOne(node.config, nodeId === triggerNodeId ? rawInput : input, executors, ctx, branchEnvelope, reportEnvelopes);
        results.set(nodeId, { nodeId, status: 'ok', output });
        outputs.set(nodeId, output);
      } catch (err) {
        results.set(nodeId, { nodeId, status: 'failed', error: String(err instanceof Error ? err.message : err) });
      }
    }));
  }

  // The Trigger's own status is excluded from this rollup: it merely expanded the raw input,
  // which isn't a business outcome, and counting it as "ok" tips the vote the wrong way at
  // both ends. Over just the non-Trigger ("outcome") nodes: every ok -> 'ok'; some ok (mixed
  // with failed/skipped) -> 'partial' (one branch's failure doesn't sink a sibling branch
  // that completed concurrently in the same or a later wave); none ok -> 'failed' (a
  // single-chain failure, where the only "ok" left after excluding the Trigger disappears,
  // so it can't rescue the run into 'partial').
  //
  // 'inactive' is excluded from the same filter alongside Trigger-kind nodes: a Branch's
  // non-chosen edge (Task 15) or a non-fired Trigger zone (Task 16) was never going to run
  // regardless of whether anything failed, so it must not count as a negative outcome — see
  // `unavailabilityStatus` below for the full 'inactive' vs 'skipped' reasoning.
  //
  // Degenerate case: a graph with only a Trigger node (outcomeStatuses is empty) must report the
  // Trigger's own status, not a hardcoded 'ok' — if the sole Trigger node itself threw, the run
  // did nothing and failed, and reporting 'ok' would be a straight-up lie about what happened.
  const statuses = [...results.values()];
  const outcomeStatuses = statuses.filter(
    r => r.status !== 'inactive' && byId.get(r.nodeId)?.config.kind !== 'Trigger',
  );
  const runStatus: RunStatus =
    outcomeStatuses.length === 0 ? (results.get(triggerNodeId)?.status === 'ok' ? 'ok' : 'failed')
    : outcomeStatuses.every(r => r.status === 'ok') ? 'ok'
    : outcomeStatuses.some(r => r.status === 'ok') ? 'partial'
    : 'failed';

  return { status: runStatus, nodes: order.map(id => results.get(id)!) };
}

/**
 * Kahn's algorithm — produces a stable ordering used only for the `nodes` array in the
 * returned RunResult (callers get results in a deterministic, dependency-respecting order).
 * It no longer drives execution order: `runPipeline`'s wave loop above recomputes its own
 * ready set each round from `results`, independently of this ordering.
 */
function topologicalOrder(graph: PipelineGraph): string[] {
  const degreeLeft = new Map<string, number>();
  for (const n of graph.nodes) degreeLeft.set(n.id, 0);
  for (const e of graph.edges) degreeLeft.set(e.to, (degreeLeft.get(e.to) ?? 0) + 1);

  const order: string[] = [];
  const queue = graph.nodes.filter(n => (degreeLeft.get(n.id) ?? 0) === 0).map(n => n.id);

  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges) {
      if (e.from !== id) continue;
      degreeLeft.set(e.to, (degreeLeft.get(e.to) ?? 0) - 1);
      if (degreeLeft.get(e.to) === 0) queue.push(e.to);
    }
  }

  return order;
}

/** Wraps every predecessor's output by its own node id — never a literal key. */
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
  branchEnvelope?: Envelope,
  reportEnvelopes?: Record<string, Envelope>,
): Promise<Record<string, unknown>> {
  switch (config.kind) {
    case 'Trigger': return executors.Trigger(config, input, ctx);
    case 'AgentCall': return executors.AgentCall(config, input, ctx);
    case 'Transform': return executors.Transform(config, input, ctx);
    case 'Sink': await executors.Sink(config, input, ctx); return {};
    case 'ForEach': return { items: await executors.ForEach(config, (input.items as unknown[]) ?? [], ctx) };
    // Branch/Report are envelope nodes — they receive Envelope-shaped predecessor data, not the
    // plain output bag every other node gets. The wave loop builds that envelope (or envelope
    // map) before calling runOne, because it needs `results` (which carries failure info that
    // `input` never does) — see `branchEnvelope`/`reportEnvelopes` above.
    case 'Branch': {
      // Branch has exactly one logical predecessor per the spec (it picks ONE outgoing edge from
      // ONE input) — if a graph somehow wires more than one into a Branch, use the first; the
      // graph validator (Task 12) doesn't currently forbid this, worth a follow-up if it matters.
      const envelope = branchEnvelope!; // the wave loop always builds this before calling runOne for a Branch
      const chosen = executors.Branch(config, envelope, ctx);
      return { chosenEdge: chosen };
    }
    case 'Report': {
      const envelopes = reportEnvelopes!; // the wave loop always builds this before calling runOne for a Report
      return executors.Report(config, envelopes, ctx);
    }
  }
}

/** Builds the Envelope a Branch/Report sees for one predecessor's outcome. */
function buildEnvelope(parentId: string, results: Map<string, NodeRunResult>): Envelope {
  const r = results.get(parentId);
  if (!r) return { status: 'skipped' }; // defensive — shouldn't happen, the wave loop only runs a node once every incoming edge has a result
  if (r.status === 'ok') return { status: 'ok', output: r.output ?? {} };
  if (r.status === 'failed') return { status: 'failed', error: r.error ?? 'unknown error' };
  return { status: r.status === 'inactive' ? 'inactive' : 'skipped' };
}

/**
 * Whether a single incoming edge is "dead" this run — its source never actually fed this edge,
 * either because the source itself is already 'inactive' (a dead path, recursively), or because
 * the source is a Branch and THIS edge's label isn't the one it chose (the source itself may
 * well have resolved 'ok' — a Branch always does when it runs — so checking the source's own
 * collapsed status is not enough; the per-edge label match is what actually decides whether this
 * particular edge carried anything).
 *
 * A 'failed' or 'skipped' source is deliberately NOT "dead" by this definition: those are real,
 * reportable outcomes (Report's whole job is surfacing them, not treating them as absence), only
 * 'inactive' and a lost Branch-label match mean "this edge never had a chance to carry anything."
 *
 * Shared by `unavailabilityStatus` (every node kind's "any dead edge counts" rule) and the
 * `Report`-specific "only ALL-dead counts" rule below — same notion of edge death, two different
 * aggregations over it.
 */
function isEdgeDead(e: PipelineEdge, byId: Map<string, PipelineNode>, results: Map<string, NodeRunResult>): boolean {
  const parentResult = results.get(e.from);
  // A failed/skipped Branch has no output.chosenEdge at all, so every one of its outgoing edges
  // would otherwise look "dead" via the label-mismatch check below (chosenEdge !== e.label is
  // true when chosenEdge is undefined) — that's wrong, this is a genuine failure, not a routing
  // decision that went the other way. Must be checked before the Branch-label check, not after.
  if (parentResult?.status === 'failed' || parentResult?.status === 'skipped') return false;
  if (parentResult?.status === 'inactive') return true;
  if (byId.get(e.from)?.config.kind === 'Branch' && e.label) {
    const chosenEdge = (parentResult?.output as { chosenEdge?: string } | undefined)?.chosenEdge;
    return chosenEdge !== e.label;
  }
  return false;
}

/**
 * Decides whether a node is unavailable this run, and if so, which of the two distinct
 * negative statuses applies:
 *   - 'skipped' — a REAL ancestor failure/skip fed this node (at least one incoming edge's
 *     source actually threw, or was itself 'skipped' for the same reason). A genuine negative
 *     outcome; counts against the run in the ok/partial/failed rollup.
 *   - 'inactive' — every contributing reason is either a Branch choosing a different edge, or
 *     an already-'inactive' ancestor (which itself traces back to nothing but branch mismatches,
 *     recursively) — nothing about this node's own incoming edges reflects an actual failure
 *     anywhere upstream. This node was never going to run regardless of whether anything
 *     failed — structurally outside this run's chosen path (the same concept Task 16 uses for a
 *     whole non-fired Trigger zone). Excluded from the rollup entirely, and the caller must
 *     treat it as unavailable for EVERY node kind, including Branch/Report (see the wave loop:
 *     'inactive' is checked and applied before the envelope-node exemption, not folded into it —
 *     a Branch/Report sitting on a dead edge must never itself run, nor leak into its own
 *     descendants, just because its kind is normally exempt from skip on a real failure).
 *
 * Mixing the two is the bug this function exists to prevent, in two different ways:
 *   1. If a Branch-mismatch ever produced 'skipped' instead of 'inactive', a perfectly healthy
 *      Branch-routed run (nothing failed, Branch just chose one of its valid edges) would
 *      incorrectly report 'partial' overall, purely because the other edge was never taken.
 *   2. If an 'inactive' ancestor ever produced 'skipped' one hop downstream (treating it the
 *      same as a real failure instead of propagating 'inactive'), the same false-'partial' bug
 *      reappears two-plus hops deep on a dead Branch path, and an envelope node (Branch/Report)
 *      sitting entirely on that dead path would wrongly qualify for the real-failure exemption
 *      and run anyway — a Branch making a second, phantom routing decision, or a Report
 *      assembling and a Sink writing on a path that was never live.
 * Both were caught during Task 15's review, after the first version of this function only
 * handled case 1.
 */
function unavailabilityStatus(
  nodeId: string,
  graph: PipelineGraph,
  byId: Map<string, PipelineNode>,
  results: Map<string, NodeRunResult>,
): 'skipped' | 'inactive' | null {
  const incomingEdges = graph.edges.filter(e => e.to === nodeId);
  let anyUnavailable = false;
  let branchMismatchOnly = true; // flips to false the moment a REAL ancestor failure/skip is found
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
    // another dead edge, recursively) further up the chain, never a real failure.
    if (isEdgeDead(e, byId, results)) {
      anyUnavailable = true;
    }
  }
  if (!anyUnavailable) return null;
  return branchMismatchOnly ? 'inactive' : 'skipped';
}
