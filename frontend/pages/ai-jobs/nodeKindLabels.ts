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
