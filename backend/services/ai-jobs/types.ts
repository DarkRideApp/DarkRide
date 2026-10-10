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
