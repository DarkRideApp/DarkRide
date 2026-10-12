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
  /** Static config a predicate reads at call time — e.g. core/field-equals's `{ field, value }`.
   *  Only meaningful to the specific predicate named above; most predicates ignore it entirely. */
  args?: Record<string, string>;
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
  /** {{trigger.field}}-style templates for the notification title/body — only meaningful for the
   *  'core/notify' writeFn. Resolved against the same `input` bag an AgentCall's
   *  instructionTemplate resolves against (see template.ts). */
  titleTemplate?: string;
  bodyTemplate?: string;
}

export interface SchemaField { field: string; type: string; description: string }

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
  /** What this Trigger hands downstream nodes as `{{trigger.field}}`. Each Trigger in a pipeline
   *  owns its own disjoint zone (validator-enforced), so different Triggers in the same graph may
   *  declare entirely different output schemas — only nodes within one Trigger's own zone ever see
   *  its shape. */
  outputSchema: SchemaField[];
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
  /** Canvas position, set once a user drags the node. Absent on nodes never moved — the
   *  frontend falls back to a placeholder grid layout for those. Purely a presentation
   *  concern: never read by the executor or the graph validator. */
  position?: { x: number; y: number };
  /** User-facing display name, editable in the side panel; `id` stays the stable reference edges and `from` fields use. */
  label?: string;
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
