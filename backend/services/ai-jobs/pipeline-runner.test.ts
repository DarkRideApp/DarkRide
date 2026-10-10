import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from './pipeline-runner';
import type { PipelineGraph, NodeExecutors } from './pipeline-runner';

function fakeExecutors(overrides: Partial<NodeExecutors> = {}): NodeExecutors {
  return {
    Trigger: vi.fn(async (_c, rawInput) => ({ appName: 'x', ...rawInput })),
    AgentCall: vi.fn(async () => ({ text: 'ok' })),
    Transform: vi.fn(() => ({})),
    Branch: vi.fn(() => 'default'),
    Report: vi.fn(() => ({ markdown: '' })),
    ForEach: vi.fn(async () => []),
    Sink: vi.fn(async () => {}),
    ...overrides,
  };
}

const linearGraph: PipelineGraph = {
  nodes: [
    { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
    { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
    { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
  ],
  edges: [{ from: 'trigger', to: 'agent' }, { from: 'agent', to: 'sink' }],
};

describe('runPipeline — linear chain', () => {
  it('runs trigger, then agent, then sink, in order, every node ok', async () => {
    const executors = fakeExecutors();
    const result = await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {});

    expect(result.status).toBe('ok');
    expect(result.nodes.map(n => n.nodeId)).toEqual(['trigger', 'agent', 'sink']);
    expect(result.nodes.every(n => n.status === 'ok')).toBe(true);
    expect(executors.Trigger).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Trigger' }), { versionId: 431 }, {});
  });

  it('passes the Trigger output to the next node keyed as "trigger"', async () => {
    const seenInput: unknown[] = [];
    const executors = fakeExecutors({
      AgentCall: vi.fn(async (_c, input) => { seenInput.push(input); return { text: 'ok' }; }),
    });
    await runPipeline(linearGraph, 'trigger', { versionId: 431 }, executors, {});
    expect(seenInput[0]).toEqual({ trigger: { appName: 'x', versionId: 431 } });
  });

  it('marks the run failed when a node throws and nothing downstream runs', async () => {
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { throw new Error('boom'); }) });
    const result = await runPipeline(linearGraph, 'trigger', {}, executors, {});
    expect(result.status).toBe('failed');
    const agentResult = result.nodes.find(n => n.nodeId === 'agent')!;
    expect(agentResult.status).toBe('failed');
    expect(agentResult.error).toMatch(/boom/);
    expect(executors.Sink).not.toHaveBeenCalled();
  });
});
