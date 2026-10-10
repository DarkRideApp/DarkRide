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

  // Regression guard: Task 14 adds wave-based concurrency and a
  // "partial-failure-continues" test over a fan-out graph — one branch failing must not sink
  // a sibling branch that completed. The run-status rollup must exclude the Trigger's own
  // 'ok' status from the vote: including it would let the Trigger's success rescue a
  // single-chain total failure (this file's own previous test, above) into 'partial' instead
  // of 'failed'. This test pins the correct three-way split (ok / partial / failed) using only
  // non-Trigger nodes, before Task 14 exists to test it structurally.
  it('treats one failed branch as "partial", not "failed", when a sibling branch completes', async () => {
    const twoBranchGraph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agentA', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'sinkA', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'agentB', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'sinkB', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agentA' }, { from: 'agentA', to: 'sinkA' },
        { from: 'trigger', to: 'agentB' }, { from: 'agentB', to: 'sinkB' },
      ],
    };

    // Exactly one of the two AgentCall invocations fails — which node it lands on doesn't
    // matter for this assertion, only that one branch fails while the other completes.
    let calls = 0;
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('branch A boom');
        return { text: 'ok' };
      }),
    });

    const result = await runPipeline(twoBranchGraph, 'trigger', {}, executors, {});

    expect(result.status).toBe('partial');
    const failedBranchNodes = result.nodes.filter(n => n.status === 'failed');
    const skippedBranchNodes = result.nodes.filter(n => n.status === 'skipped');
    const okOutcomeNodes = result.nodes.filter(n => n.status === 'ok' && n.nodeId !== 'trigger');
    expect(failedBranchNodes).toHaveLength(1);
    expect(skippedBranchNodes).toHaveLength(1);
    expect(okOutcomeNodes).toHaveLength(2); // the surviving branch's AgentCall + Sink
  });
});
