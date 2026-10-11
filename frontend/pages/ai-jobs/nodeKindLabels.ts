import type { NodeKind } from '../../../backend/services/ai-jobs/types';

/** Display text per NodeKind — never rename the `kind` strings themselves, they're stored in every pipeline version's graph JSON. */
export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  Trigger: 'Trigger',
  AgentCall: 'Agent Call',
  Transform: 'Transform',
  Branch: 'Branch',
  Report: 'Report',
  ForEach: 'For Each',
  Sink: 'Output',
};

export function nodeKindLabel(kind: string): string {
  return (NODE_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/** One line on what each kind actually does — shown in the node picker so "Transform" or "Branch" isn't just a bare word. */
export const NODE_KIND_DESCRIPTIONS: Record<NodeKind, string> = {
  Trigger: 'Starts a run and supplies its input',
  AgentCall: 'Calls an AI agent with a prompt',
  Transform: 'Runs a registered function to reshape data',
  Branch: 'Routes to one of several named outputs',
  Report: 'Combines several inputs into named sections',
  ForEach: 'Runs its per-item function over a list',
  Sink: 'Writes a result somewhere permanent',
};
