import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index';
import { aiPipelineVersions } from '../../db/schema';
import type { NodeExecutors, ExecutionCtx } from './pipeline-runner';
import type { PipelineGraph } from './types';
import { startPipelineRun, notifyPipelineFailure } from './run-executor';
import { createLoggers } from '../../logs';

const { log, error } = createLoggers('ai-jobs-hook-dispatch');

interface Binding {
  pipelineVersionId: number;
  graph: PipelineGraph;
  triggerNodeId: string;
}

type HookBusLike = {
  on(name: string, handler: (...args: any[]) => void): void;
  off(name: string, handler: (...args: any[]) => void): void;
};

/**
 * Subscribes every published pipeline version's event-sourced Trigger nodes to HookBus, and
 * starts a run (via the same `startPipelineRun` the REST /run endpoint and apk-analyzer.ts's own
 * auto-trigger path both use) whenever its bound event fires. See
 * docs/specs/2026-10-11-ai-pipelines-typed-triggers-design.md.
 */
export class HookTriggerDispatcher {
  private hookBus: HookBusLike | null = null;
  /** One handler per event name, reused across refresh() calls — HookBusImpl.on dedupes by
   *  handler reference via a Set, so refresh() must never create a fresh closure for an event
   *  name it's already subscribed to, or two refreshes would double-fire every bound run. */
  private handlersByEvent = new Map<string, (payload: Record<string, unknown>) => void>();

  constructor(private deps: {
    db: AppDatabase;
    executors: NodeExecutors;
    buildCtx: (eventPayload: Record<string, unknown>) => ExecutionCtx;
    notificationService?: { emit: (event: { type: string; title: string; body: string; sourceType?: string; sourceId?: string; url?: string }) => void };
  }) {}

  attach(hookBus: HookBusLike): void {
    this.hookBus = hookBus;
  }

  /** Re-scans every published version's graph; subscribes newly-bound event names, unsubscribes ones no longer bound by anything published. */
  refresh(): void {
    if (!this.hookBus) return;
    const bindingsByEvent = this.collectBindings();

    for (const eventName of bindingsByEvent.keys()) {
      if (this.handlersByEvent.has(eventName)) continue;
      const handler = (payload: Record<string, unknown>) => this.handleFire(eventName, payload);
      this.handlersByEvent.set(eventName, handler);
      this.hookBus.on(eventName, handler);
    }

    for (const [eventName, handler] of [...this.handlersByEvent.entries()]) {
      if (bindingsByEvent.has(eventName)) continue;
      this.hookBus.off(eventName, handler);
      this.handlersByEvent.delete(eventName);
    }
  }

  private collectBindings(): Map<string, Binding[]> {
    const result = new Map<string, Binding[]>();
    const published = this.deps.db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.status, 'published')).all();
    for (const version of published) {
      const graph = version.graph as unknown as PipelineGraph;
      for (const node of graph.nodes) {
        const config = node.config as { kind: string; source?: string; eventName?: string };
        if (config.kind !== 'Trigger' || config.source !== 'event' || !config.eventName) continue;
        const list = result.get(config.eventName) ?? [];
        list.push({ pipelineVersionId: version.id, graph, triggerNodeId: node.id });
        result.set(config.eventName, list);
      }
    }
    return result;
  }

  private handleFire(eventName: string, payload: Record<string, unknown>): void {
    // Re-collect at fire time, not from a closure captured at subscribe time — always reflects
    // whatever was most recently published.
    const bindings = this.collectBindings().get(eventName) ?? [];
    for (const binding of bindings) {
      const started = startPipelineRun({
        db: this.deps.db,
        pipelineVersionId: binding.pipelineVersionId,
        graph: binding.graph,
        triggerNodeId: binding.triggerNodeId,
        input: payload,
        triggeredBy: 'event',
        executors: this.deps.executors,
        buildCtx: () => this.deps.buildCtx(payload),
        onSettled: (result, crashError) => {
          if (result.status === 'failed') {
            error(`Event-fired run for pipeline version ${binding.pipelineVersionId} ("${eventName}") failed: ${crashError ?? result.nodes.filter(n => n.status === 'failed').map(n => `${n.nodeId}: ${n.error}`).join('; ')}`);
            notifyPipelineFailure(this.deps.notificationService, this.deps.db, binding.pipelineVersionId, result, crashError);
          } else {
            log(`Event-fired run for pipeline version ${binding.pipelineVersionId} ("${eventName}") finished: ${result.status}`);
          }
        },
      });
      if (!started.ok) {
        error(`Could not start event-fired run for pipeline version ${binding.pipelineVersionId} ("${eventName}"): ${started.error}`);
      }
    }
  }
}
