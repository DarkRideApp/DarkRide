import type { NodeConfig } from '../../../backend/services/ai-jobs/types';

export interface Pin { id: string; label?: string }

/**
 * A node's input/output pins. Static for most kinds; derived from the node's own config for
 * Report (one input per declared section) and Branch (one output per declared edge label) — a
 * pin only exists once the field backing it does, same as Report showing zero inputs before its
 * first "+ Add section".
 */
export function nodePins(config: NodeConfig): { inputs: Pin[]; outputs: Pin[] } {
  switch (config.kind) {
    case 'Trigger': return { inputs: [], outputs: [{ id: 'out' }] };
    case 'Sink': return { inputs: [{ id: 'in' }], outputs: [] };
    case 'Report': return { inputs: config.sections.map((s, i) => ({ id: `section-${i}`, label: s.title || `Section ${i + 1}` })), outputs: [{ id: 'out' }] };
    case 'Branch': return { inputs: [{ id: 'in' }], outputs: config.edges.map(label => ({ id: label, label })) };
    case 'AgentCall': return { inputs: [{ id: 'in' }], outputs: [{ id: 'out' }] };
    case 'Transform': return { inputs: [{ id: 'in' }], outputs: [{ id: 'out' }] };
    case 'ForEach': return { inputs: [{ id: 'in' }], outputs: [{ id: 'out' }] };
  }
}
