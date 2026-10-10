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

  // Regression guard: when outcomeStatuses is empty (a graph with only a Trigger node), the
  // rollup must report the Trigger's own actual status, not a hardcoded 'ok'. A Trigger-only
  // graph whose Trigger itself throws did nothing and failed — reporting 'ok' would be wrong.
  it('reports "failed" for a Trigger-only graph whose Trigger itself throws', async () => {
    const triggerOnlyGraph: PipelineGraph = {
      nodes: [{ id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } }],
      edges: [],
    };
    const executors = fakeExecutors({
      Trigger: vi.fn(async () => { throw new Error('trigger boom'); }),
    });

    const result = await runPipeline(triggerOnlyGraph, 'trigger', {}, executors, {});

    expect(result.status).toBe('failed');
    expect(result.nodes).toEqual([{ nodeId: 'trigger', status: 'failed', error: expect.stringMatching(/trigger boom/) }]);
  });
});

describe('runPipeline — concurrency and transitive skip', () => {
  const fanOutGraph: PipelineGraph = {
    nodes: [
      { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'a1', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'a2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 's1', config: { kind: 'Sink', writeFn: 'x' } },
      { id: 's2', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [
      { from: 'trigger', to: 'a1' }, { from: 'trigger', to: 'a2' },
      { from: 'a1', to: 's1' }, { from: 'a2', to: 's2' },
    ],
  };

  it('runs independent branches concurrently, not sequentially', async () => {
    const order: string[] = [];
    const executors = fakeExecutors({
      AgentCall: vi.fn(async (_c, _i) => {
        order.push('agent-start');
        await new Promise(r => setTimeout(r, 10));
        order.push('agent-end');
        return { text: 'ok' };
      }),
    });
    await runPipeline(fanOutGraph, 'trigger', {}, executors, {});
    // Both agents start before either finishes — sequential execution would interleave start/end/start/end.
    expect(order).toEqual(['agent-start', 'agent-start', 'agent-end', 'agent-end']);
  });

  it('skip propagates transitively through a chain, not just one hop', async () => {
    const chain: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'a', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'transform', config: { kind: 'Transform', fn: 'x' } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [{ from: 'trigger', to: 'a' }, { from: 'a', to: 'transform' }, { from: 'transform', to: 'sink' }],
    };
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { throw new Error('boom'); }) });
    const result = await runPipeline(chain, 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'a')!.status).toBe('failed');
    expect(result.nodes.find(n => n.nodeId === 'transform')!.status).toBe('skipped');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('skipped'); // two hops from the failure
    expect(executors.Transform).not.toHaveBeenCalled();
    expect(executors.Sink).not.toHaveBeenCalled();
  });

  it('one failed branch does not stop the sibling branch from completing (partial-failure-continues)', async () => {
    // Make a1 fail, a2 succeed, by giving each AgentCall a distinguishable config field.
    const graph: PipelineGraph = {
      ...fanOutGraph,
      nodes: fanOutGraph.nodes.map(n =>
        n.id === 'a1' ? { ...n, config: { ...n.config, instructionTemplate: 'FAIL' } as any } : n,
      ),
    };
    const agentCall = vi.fn(async (config: any) => {
      if (config.instructionTemplate === 'FAIL') throw new Error('boom');
      return { text: 'ok' };
    });
    const result = await runPipeline(graph, 'trigger', {}, fakeExecutors({ AgentCall: agentCall }), {});

    expect(result.status).toBe('partial');
    expect(result.nodes.find(n => n.nodeId === 'a1')!.status).toBe('failed');
    expect(result.nodes.find(n => n.nodeId === 's1')!.status).toBe('skipped');
    expect(result.nodes.find(n => n.nodeId === 'a2')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 's2')!.status).toBe('ok'); // sibling branch unaffected
  });

  it('"trigger" resolves for a non-direct descendant, and for a Trigger not literally named "trigger"', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'transform', config: { kind: 'Transform', fn: 'x' } }, // sits between the Trigger and the next AgentCall
        { id: 'agent2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      ],
      edges: [
        { from: 'trigger-full', to: 'agent' }, { from: 'agent', to: 'transform' }, { from: 'transform', to: 'agent2' },
      ],
    };
    const seenInputs: Record<string, unknown>[] = [];
    const executors = fakeExecutors({ AgentCall: vi.fn(async (_c, input) => { seenInputs.push(input); return { text: 'ok' }; }) });
    await runPipeline(graph, 'trigger-full', { versionId: 431 }, executors, {});

    // Direct child — must resolve under the literal key "trigger", not under "trigger-full".
    expect(seenInputs[0].trigger).toEqual({ appName: 'x', versionId: 431 });
    // Two hops from the Trigger, behind a Transform — must still resolve.
    expect(seenInputs[1].trigger).toEqual({ appName: 'x', versionId: 431 });
  });
});
