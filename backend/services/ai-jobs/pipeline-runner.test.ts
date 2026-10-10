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

describe('runPipeline — envelope nodes', () => {
  function branchGraph(): PipelineGraph {
    return {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primary-sink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'fallback-sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'primary-sink', label: 'primary' },
        { from: 'branch', to: 'fallback-sink', label: 'fallback' },
      ],
    };
  }

  it('Branch runs even when its immediate parent failed, and routes only the chosen edge', async () => {
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => { throw new Error('boom'); }),
      Branch: vi.fn((_config, envelope: any) => (envelope.status === 'failed' ? 'fallback' : 'primary')),
    });
    const result = await runPipeline(branchGraph(), 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'agent')!.status).toBe('failed');
    expect(result.nodes.find(n => n.nodeId === 'branch')!.status).toBe('ok'); // envelope node — not skipped
    expect(result.nodes.find(n => n.nodeId === 'fallback-sink')!.status).toBe('ok'); // chosen edge
    // 'inactive', not 'skipped' — a Branch's non-chosen edge was never going to run regardless of
    // whether anything upstream failed; it is structurally outside this run's chosen path, the same
    // concept Task 16 uses for a whole non-fired Trigger zone. This matters for the rollup (see the
    // new test below): if this were 'skipped', a perfectly healthy Branch-routed run would report
    // 'partial' overall purely because one edge was never taken, which is wrong. Caught in Task 13's
    // review, fixed here before this task's code was ever written, not as a later patch.
    expect(result.nodes.find(n => n.nodeId === 'primary-sink')!.status).toBe('inactive'); // not chosen
    expect(executors.Branch).toHaveBeenCalledWith(expect.anything(), { status: 'failed', error: expect.stringContaining('boom') }, {});
  });

  it('a healthy Branch-routed run reports "ok" overall, not "partial" — the non-chosen edge is inactive, not a negative outcome', async () => {
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => ({ text: 'ok' })), // succeeds this time, unlike the test above
      Branch: vi.fn(() => 'primary'),
    });
    const result = await runPipeline(branchGraph(), 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'agent')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'branch')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'primary-sink')!.status).toBe('ok'); // chosen edge
    expect(result.nodes.find(n => n.nodeId === 'fallback-sink')!.status).toBe('inactive'); // not chosen, not a failure
    // The whole point of this test: an untaken branch must never drag a fully healthy run down to
    // 'partial'. Relies on the rollup already excluding 'inactive' from its ok/some-ok/none-ok vote
    // (added as a forward-compatible no-op during Task 13's own fix round, for exactly this case).
    expect(result.status).toBe('ok');
  });

  it('a Branch that is NOT the immediate child of a failure sees "skipped", not "failed" — the adjacency rule in practice', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'transform', config: { kind: 'Transform', fn: 'x' } }, // sits between the failure and the Branch
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary'] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' }, { from: 'agent', to: 'transform' },
        { from: 'transform', to: 'branch' }, { from: 'branch', to: 'sink', label: 'primary' },
      ],
    };
    let seenEnvelope: any;
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => { throw new Error('boom'); }),
      Branch: vi.fn((_c, envelope: any) => { seenEnvelope = envelope; return 'primary'; }),
    });
    await runPipeline(graph, 'trigger', {}, executors, {});
    expect(seenEnvelope).toEqual({ status: 'skipped' }); // not { status: 'failed', error: 'boom' } — transform absorbed it
  });

  it('Report gathers an envelope per section source and assembles once all settle', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'a1', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'ok', toolAllowlist: [] } },
        { id: 'a2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'FAIL', toolAllowlist: [] } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'One', from: 'a1' }, { title: 'Two', from: 'a2' }] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'a1' }, { from: 'trigger', to: 'a2' },
        { from: 'a1', to: 'report' }, { from: 'a2', to: 'report' }, { from: 'report', to: 'sink' },
      ],
    };
    let seenEnvelopes: any;
    const agentCall = vi.fn(async (config: any) => { if (config.instructionTemplate === 'FAIL') throw new Error('nope'); return { text: 'ok' }; });
    const report = vi.fn((_c, envelopes: any) => { seenEnvelopes = envelopes; return { markdown: 'x' }; });
    const result = await runPipeline(graph, 'trigger', {}, fakeExecutors({ AgentCall: agentCall, Report: report }), {});

    expect(result.nodes.find(n => n.nodeId === 'report')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('ok'); // Report's own output always flows onward
    expect(seenEnvelopes).toEqual({
      a1: { status: 'ok', output: { text: 'ok' } },
      a2: { status: 'failed', error: expect.stringContaining('nope') },
    });
  });
});

describe('runPipeline — dead (non-chosen) Branch paths', () => {
  it('a 2-hop-deep non-chosen path stays "inactive" the whole way, not degrading to "skipped" one hop down', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primary-sink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'midAgent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } }, // on the dead edge
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } }, // 2 hops from the dead edge
      ],
      edges: [
        { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'primary-sink', label: 'primary' },
        { from: 'branch', to: 'midAgent', label: 'fallback' },
        { from: 'midAgent', to: 'sink' },
      ],
    };
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => ({ text: 'ok' })),
      Branch: vi.fn(() => 'primary'), // never chooses 'fallback' — midAgent/sink are structurally dead
    });
    const result = await runPipeline(graph, 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'midAgent')!.status).toBe('inactive');
    // The bug this test pins: 'inactive' must propagate as 'inactive', not degrade to 'skipped'
    // once it crosses a hop boundary. sink's only parent is midAgent, which is 'inactive' (a
    // dead branch), not a real failure — sink must stay 'inactive' too.
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('inactive');
    expect(executors.AgentCall).toHaveBeenCalledTimes(1); // only 'agent' ever actually ran
    expect(result.status).toBe('ok'); // nothing failed; the dead path must not drag this to 'partial'
  });

  it('a Branch sitting entirely on a non-chosen edge never executes, and neither do its descendants', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primary-sink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'branch2', config: { kind: 'Branch', predicate: 'x', edges: ['primary'] } }, // entirely on the dead edge
        { id: 'leakSink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'primary-sink', label: 'primary' },
        { from: 'branch', to: 'branch2', label: 'fallback' },
        { from: 'branch2', to: 'leakSink', label: 'primary' },
      ],
    };
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => ({ text: 'ok' })),
      Branch: vi.fn(() => 'primary'), // outer branch never chooses 'fallback' — branch2 is structurally dead
    });
    const result = await runPipeline(graph, 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'branch2')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'leakSink')!.status).toBe('inactive');
    // Being an envelope node exempts a Branch from skip on a REAL ancestor failure — it must
    // NOT also exempt it from a dead path it was never going to be on in the first place.
    expect(executors.Branch).toHaveBeenCalledTimes(1); // only the outer branch — branch2 never runs
    expect(executors.Sink).toHaveBeenCalledTimes(1); // only primary-sink — leakSink never runs
    expect(result.status).toBe('ok');
  });

  it('a Report sitting entirely on a non-chosen edge never executes, and neither does its downstream Sink', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primary-sink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'report2', config: { kind: 'Report', sections: [{ title: 'X', from: 'branch' }] } }, // entirely on the dead edge
        { id: 'sink2', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'primary-sink', label: 'primary' },
        { from: 'branch', to: 'report2', label: 'fallback' },
        { from: 'report2', to: 'sink2' },
      ],
    };
    const report = vi.fn(() => ({ markdown: 'x' }));
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => ({ text: 'ok' })),
      Branch: vi.fn(() => 'primary'), // outer branch never chooses 'fallback' — report2 is structurally dead
      Report: report,
    });
    const result = await runPipeline(graph, 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'report2')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'sink2')!.status).toBe('inactive');
    expect(report).not.toHaveBeenCalled();
    expect(executors.Sink).toHaveBeenCalledTimes(1); // only primary-sink — sink2 never runs
    expect(result.status).toBe('ok');
  });

  it('a Report with a MIX of live and dead-via-branch sources still runs and keeps the live sections — the regression guard for silently dropping good output', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent1', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'one', toolAllowlist: [] } },
        { id: 'agent2', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'two', toolAllowlist: [] } },
        { id: 'branchAgent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primarySink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'deadAgent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'three', toolAllowlist: [] } }, // on the non-chosen edge — would-be 3rd section, never runs
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'One', from: 'agent1' }, { title: 'Two', from: 'agent2' }, { title: 'Three', from: 'deadAgent' }] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent1' }, { from: 'trigger', to: 'agent2' }, { from: 'trigger', to: 'branchAgent' },
        { from: 'branchAgent', to: 'branch' },
        { from: 'branch', to: 'primarySink', label: 'primary' },
        { from: 'branch', to: 'deadAgent', label: 'fallback' },
        { from: 'agent1', to: 'report' }, { from: 'agent2', to: 'report' }, { from: 'deadAgent', to: 'report' },
        { from: 'report', to: 'sink' },
      ],
    };
    let seenEnvelopes: any;
    const agentCall = vi.fn(async (config: any) => ({ text: config.instructionTemplate }));
    const report = vi.fn((_c, envelopes: any) => {
      seenEnvelopes = envelopes;
      return { markdown: 'x' };
    });
    const executors = fakeExecutors({
      AgentCall: agentCall,
      Branch: vi.fn(() => 'primary'), // never chooses 'fallback' — deadAgent/its section are structurally dead
      Report: report,
    });
    const result = await runPipeline(graph, 'trigger', {}, executors, {});

    // The Report executor IS called, unlike the fully-dead case above — a mix of live and dead
    // sources must never be treated the same as all-dead.
    expect(report).toHaveBeenCalledTimes(1);
    expect(result.nodes.find(n => n.nodeId === 'report')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('ok'); // Report's own Sink still fires
    expect(result.nodes.find(n => n.nodeId === 'deadAgent')!.status).toBe('inactive'); // the dead source itself
    // The two live sections' real content must survive — this is the regression guard for the
    // "6 good sections silently dropped" bug: the dead 3rd section becomes an explicit 'inactive'
    // envelope, not a reason to skip the whole Report.
    expect(seenEnvelopes).toEqual({
      agent1: { status: 'ok', output: { text: 'one' } },
      agent2: { status: 'ok', output: { text: 'two' } },
      deadAgent: { status: 'inactive' },
    });
    expect(result.status).toBe('ok');
  });

  it('a Report fed only by a Branch whose predicate throws still runs, with an honest "failed" envelope — not "inactive"', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary'] } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'X', from: 'branch' }] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'report', label: 'primary' },
        { from: 'report', to: 'sink' },
      ],
    };
    let seenEnvelopes: any;
    const report = vi.fn((_c, envelopes: any) => {
      seenEnvelopes = envelopes;
      const markdown = Object.entries(envelopes)
        .map(([title, env]: [string, any]) =>
          env.status === 'ok' ? `${title}: ${env.output.text}` : `${title}: unavailable this run (${env.status}${env.error ? ' — ' + env.error : ''})`)
        .join('\n');
      return { markdown };
    });
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => ({ text: 'ok' })),
      Branch: vi.fn(() => { throw new Error('predicate boom'); }), // the Branch's own logic throws
      Report: report,
    });
    const result = await runPipeline(graph, 'trigger', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'branch')!.status).toBe('failed');
    // Report must still run — a failed Branch is a real, reportable outcome, not a dead edge.
    expect(report).toHaveBeenCalledTimes(1);
    expect(result.nodes.find(n => n.nodeId === 'report')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('ok'); // Report's Sink still fires
    expect(seenEnvelopes).toEqual({ branch: { status: 'failed', error: expect.stringContaining('predicate boom') } });
    // An honest failure placeholder reached the assembled output — not a crash, not a silent drop.
    expect(report.mock.results[0].value.markdown).toContain('unavailable this run (failed');
    expect(report.mock.results[0].value.markdown).toContain('predicate boom');
    expect(result.status).toBe('partial'); // the Branch's genuine failure still counts against the run
  });

  it('a Report mixing one live AgentCall section with a DIRECT non-chosen-Branch-edge section runs correctly, with an inactive placeholder (not the Branch\'s raw output) for the gated one', async () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'liveAgent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'live', toolAllowlist: [] } },
        { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
        { id: 'branch', config: { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] } },
        { id: 'primarySink', config: { kind: 'Sink', writeFn: 'x' } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'Live', from: 'liveAgent' }, { title: 'Gated', from: 'branch' }] } },
        { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
      ],
      edges: [
        { from: 'trigger', to: 'liveAgent' }, { from: 'trigger', to: 'agent' },
        { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'primarySink', label: 'primary' },
        { from: 'branch', to: 'report', label: 'fallback' }, // Report sourced DIRECTLY off the non-chosen edge, no intermediate node
        { from: 'liveAgent', to: 'report' },
        { from: 'report', to: 'sink' },
      ],
    };
    let seenEnvelopes: any;
    const agentCall = vi.fn(async (config: any) => ({ text: config.instructionTemplate }));
    const report = vi.fn((_c, envelopes: any) => {
      seenEnvelopes = envelopes;
      const markdown = Object.entries(envelopes)
        .map(([title, env]: [string, any]) =>
          env.status === 'ok' ? `${title}: ${env.output.text}` : `${title}: unavailable this run (${env.status})`)
        .join('\n');
      return { markdown };
    });
    const executors = fakeExecutors({
      AgentCall: agentCall,
      Branch: vi.fn(() => 'primary'), // never chooses 'fallback' — report's direct 'fallback' edge is dead
      Report: report,
    });
    const result = await runPipeline(graph, 'trigger', {}, executors, {});

    expect(report).toHaveBeenCalledTimes(1);
    expect(result.nodes.find(n => n.nodeId === 'report')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'sink')!.status).toBe('ok');
    // The critical assertion: the gated section's envelope must be an honest {status:'inactive'}
    // placeholder, NOT the Branch's own raw {status:'ok', output:{chosenEdge}} — that raw shape
    // has no .text field and crashes a real assembly function expecting section content.
    expect(seenEnvelopes).toEqual({
      liveAgent: { status: 'ok', output: { text: 'live' } },
      branch: { status: 'inactive' },
    });
    expect(report.mock.results[0].value.markdown).toContain('live');
    expect(report.mock.results[0].value.markdown).toContain('unavailable this run (inactive)');
    expect(result.status).toBe('ok'); // nothing failed — the gated edge is inactive, not a negative outcome
  });
});

describe('runPipeline — multi-trigger zones', () => {
  const twoTriggerGraph: PipelineGraph = {
    nodes: [
      { id: 'full', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'rescan', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'agent-full', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink-full', config: { kind: 'Sink', writeFn: 'x' } },
      { id: 'agent-rescan', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink-rescan', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [
      { from: 'full', to: 'agent-full' }, { from: 'agent-full', to: 'sink-full' },
      { from: 'rescan', to: 'agent-rescan' }, { from: 'agent-rescan', to: 'sink-rescan' },
    ],
  };

  it('firing "rescan" marks every node in the "full" zone inactive, and never calls their executors', async () => {
    const executors = fakeExecutors();
    const result = await runPipeline(twoTriggerGraph, 'rescan', {}, executors, {});

    expect(result.nodes.find(n => n.nodeId === 'full')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'agent-full')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'sink-full')!.status).toBe('inactive');
    expect(result.nodes.find(n => n.nodeId === 'rescan')!.status).toBe('ok');
    expect(result.nodes.find(n => n.nodeId === 'agent-rescan')!.status).toBe('ok');
    // The Trigger executor is called once per run (the fired one), never for the inactive zone's Trigger.
    expect(executors.Trigger).toHaveBeenCalledTimes(1);
  });

  it('run status rolls up over the active zone only — inactive nodes never count toward ok/partial/failed', async () => {
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { throw new Error('boom'); }) });
    const result = await runPipeline(twoTriggerGraph, 'rescan', {}, executors, {});
    // agent-rescan fails, sink-rescan skips — the "full" zone (4 inactive nodes) must not turn this into "partial"
    // via some leftover inactive-counts-as-ok logic, nor silently inflate node totals.
    expect(result.status).toBe('failed'); // the whole (2-node) active zone produced nothing
    const activeZoneNodes = result.nodes.filter(n => n.status !== 'inactive');
    expect(activeZoneNodes.map(n => n.nodeId).sort()).toEqual(['agent-rescan', 'rescan', 'sink-rescan']);
  });

  it('throws on a triggerNodeId that does not name a real Trigger node, rather than silently reporting ok', async () => {
    const executors = fakeExecutors();
    await expect(runPipeline(twoTriggerGraph, 'not-a-real-node', {}, executors, {})).rejects.toThrow(/not a Trigger node/);
    await expect(runPipeline(twoTriggerGraph, 'agent-full', {}, executors, {})).rejects.toThrow(/not a Trigger node/); // a real node, but not a Trigger
  });
});
