import { describe, it, expect } from 'vitest';
import { nodePins } from './nodePins';
import type { NodeConfig } from '../../../backend/services/ai-jobs/types';

describe('nodePins', () => {
  it('Trigger: no input, one output', () => {
    const config: NodeConfig = { kind: 'Trigger', expandFn: 'x', outputSchema: [] };
    expect(nodePins(config)).toEqual({ inputs: [], outputs: [{ id: 'out' }] });
  });

  it('AgentCall / Transform / ForEach: one input, one output', () => {
    expect(nodePins({ kind: 'AgentCall', tier: 'High', instructionTemplate: '', toolAllowlist: [] })).toEqual({ inputs: [{ id: 'in' }], outputs: [{ id: 'out' }] });
    expect(nodePins({ kind: 'Transform', fn: '' })).toEqual({ inputs: [{ id: 'in' }], outputs: [{ id: 'out' }] });
    expect(nodePins({ kind: 'ForEach', itemFn: '' })).toEqual({ inputs: [{ id: 'in' }], outputs: [{ id: 'out' }] });
  });

  it('Sink: one input, no output', () => {
    const config: NodeConfig = { kind: 'Sink', writeFn: 'x' };
    expect(nodePins(config)).toEqual({ inputs: [{ id: 'in' }], outputs: [] });
  });

  it('Report: one input pin per declared section, labeled by its title, plus one output', () => {
    const config: NodeConfig = {
      kind: 'Report',
      sections: [{ title: 'Overview', from: 'a' }, { title: 'Maps', from: 'b' }],
    };
    expect(nodePins(config)).toEqual({
      inputs: [{ id: 'section-0', label: 'Overview' }, { id: 'section-1', label: 'Maps' }],
      outputs: [{ id: 'out' }],
    });
  });

  it('Report: a blank-titled section still gets a pin, labeled by its position', () => {
    const config: NodeConfig = { kind: 'Report', sections: [{ title: '', from: '' }] };
    expect(nodePins(config)).toEqual({ inputs: [{ id: 'section-0', label: 'Section 1' }], outputs: [{ id: 'out' }] });
  });

  it('Report: zero sections means zero input pins — nothing to wire until one is declared', () => {
    const config: NodeConfig = { kind: 'Report', sections: [] };
    expect(nodePins(config)).toEqual({ inputs: [], outputs: [{ id: 'out' }] });
  });

  it('Branch: one input, one output pin per declared edge label', () => {
    const config: NodeConfig = { kind: 'Branch', predicate: 'x', edges: ['yes', 'no'] };
    expect(nodePins(config)).toEqual({ inputs: [{ id: 'in' }], outputs: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }] });
  });

  it('Branch: zero declared edges means zero output pins', () => {
    const config: NodeConfig = { kind: 'Branch', predicate: 'x', edges: [] };
    expect(nodePins(config)).toEqual({ inputs: [{ id: 'in' }], outputs: [] });
  });
});
