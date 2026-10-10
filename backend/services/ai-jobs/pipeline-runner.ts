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
 * THIS TASK (13) only handles graphs where every node has at most one incoming edge and
 * nothing branches — a straight topological walk in a single pass, no concurrency, no skip
 * propagation beyond "a failed parent skips its child", no envelope wiring for Branch/Report,
 * no multi-trigger zones, no memoization. Tasks 14-17 extend this same function in place:
 *   - Task 14: wave-based concurrent execution + real skip propagation
 *   - Task 15: envelope nodes (Branch/Report) get their Envelope-shaped inputs
 *   - Task 16: multi-trigger zone partitioning (graph-validator.ts already enforces this
 *     statically; the executor still needs to run each zone from its own trigger)
 *   - Task 17: opt-in memoization
 *
 * `triggerNodeId` names which node in `graph.nodes` is the Trigger to seed with `rawInput` —
 * this is the real parameter driving the special-case "seed this node with rawInput instead of
 * its upstream outputs" behavior. It must never be replaced with a literal string: the test
 * fixture's Trigger node happens to be named 'trigger', but that is a coincidence of the fixture,
 * not a contract. A later task adds a fixture with a Trigger node named something else entirely
 * to catch exactly this shortcut.
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

  for (const nodeId of order) {
    const node = byId.get(nodeId)!;
    const incoming = graph.edges.filter(e => e.to === nodeId).map(e => e.from);
    const parentFailed = incoming.some(p => results.get(p)?.status === 'failed' || results.get(p)?.status === 'skipped');

    if (parentFailed) {
      results.set(nodeId, { nodeId, status: 'skipped' });
      continue;
    }

    const input = nodeId === triggerNodeId ? rawInput : buildInput(incoming, outputs);
    try {
      const output = await runOne(node.config, input, executors, ctx);
      results.set(nodeId, { nodeId, status: 'ok', output });
      outputs.set(nodeId, output);
    } catch (err) {
      results.set(nodeId, { nodeId, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // The Trigger's own status is excluded from this rollup: it merely expanded the raw input,
  // which isn't a business outcome, and counting it as "ok" tips the vote the wrong way at
  // both ends. Over just the non-Trigger ("outcome") nodes: every ok -> 'ok'; some ok (mixed
  // with failed/skipped) -> 'partial' (one branch's failure doesn't sink a sibling branch
  // that completed — Task 14's wave-based concurrency depends on this); none ok -> 'failed'
  // (a single-chain failure, e.g. this task's own third test, where the only "ok" left after
  // excluding the Trigger disappears, so it can't rescue the run into 'partial').
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
 * Kahn's algorithm — stable ordering for the linear-chain graphs this task handles.
 * Task 14 replaces this single-pass walk with wave-based concurrent execution, but the
 * ordering contract (a node never runs before any of its direct predecessors) carries over.
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
