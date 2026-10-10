import type {
  PipelineGraph, NodeConfig, NodeRunStatus, RunStatus, Envelope,
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
 * Still outstanding, for Tasks 15-17 to add to this same function in place:
 *   - Task 15: envelope wiring for Branch/Report (they currently throw — see runOne below)
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

  // The Trigger's own status is excluded from this rollup: it merely expanded the raw input,
  // which isn't a business outcome, and counting it as "ok" tips the vote the wrong way at
  // both ends. Over just the non-Trigger ("outcome") nodes: every ok -> 'ok'; some ok (mixed
  // with failed/skipped) -> 'partial' (one branch's failure doesn't sink a sibling branch
  // that completed concurrently in the same or a later wave); none ok -> 'failed' (a
  // single-chain failure, where the only "ok" left after excluding the Trigger disappears,
  // so it can't rescue the run into 'partial').
  //
  // 'inactive' is excluded from the same filter alongside Trigger-kind nodes: nothing produces
  // it yet (Task 15's Branch routing and Task 16's multi-trigger zones are the first to), but
  // it's cheaper to fold the correct exclusion into this line now than to have two later tasks
  // each reopen this block — it's a no-op today since no current test ever produces 'inactive'.
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
): Promise<Record<string, unknown>> {
  switch (config.kind) {
    case 'Trigger': return executors.Trigger(config, input, ctx);
    case 'AgentCall': return executors.AgentCall(config, input, ctx);
    case 'Transform': return executors.Transform(config, input, ctx);
    case 'Sink': await executors.Sink(config, input, ctx); return {};
    case 'ForEach': return { items: await executors.ForEach(config, (input.items as unknown[]) ?? [], ctx) };
    // Branch/Report are envelope nodes — they receive Envelope-shaped predecessor data, not the
    // plain output bag every other node gets. Task 15 wires that up; until then these two kinds
    // are unreachable from any graph this task's tests exercise (no Branch/Report node in
    // linearGraph), so throwing here is correct, not a placeholder to silently fall through.
    case 'Branch': throw new Error('Branch requires envelope wiring — see Task 15');
    case 'Report': throw new Error('Report requires envelope wiring — see Task 15');
  }
}
