import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { aiCallLog, aiCallRequest, settings } from '../db/schema';
import type { AgentIdentity, AgentRequestUsage, HandleMessageParams } from './ai-agent';
import { estimateCostUsd, parseModelPriceOverrides } from '../../shared/lib/ai-model-pricing';

/** Settings key holding per-install price overrides (see shared/lib/ai-model-pricing.ts). */
export const AI_MODEL_PRICES_SETTING = 'ai_model_prices';

export interface AiCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  toolCalls?: number;
  /** Used only when `requests` is absent; otherwise the cost is estimated from the requests. */
  costUsd?: number;
  /** One entry per model request; each becomes an `ai_call_request` row with its estimated cost. */
  requests?: AgentRequestUsage[];
}

export class AiCallLogger {
  constructor(private db: BetterSQLite3Database<any>) {}

  startCall(identity: AgentIdentity, params: Partial<HandleMessageParams>): number {
    const row = this.db.insert(aiCallLog).values({
      startedAt: new Date(),
      identityType: identity.identityType,
      actorUserId: identity.actorUserId,
      onBehalfOfPlugin: identity.onBehalfOfPlugin,
      onBehalfOfService: identity.onBehalfOfService,
      actingForUserId: identity.actingForUserId,
      effectiveScopes: identity.effectiveScopes as any,
      pageContext: params.pageContext,
      contextId: params.contextId,
    } as any).returning({ id: aiCallLog.id }).get();
    return row.id;
  }

  /**
   * Close a run. When `usage.requests` is given, writes one `ai_call_request` row per request (in order,
   * `seq` from 0) and sets the run's `cost_usd` to the sum of the priced requests, or null when none had
   * a known price. Costs are estimates.
   */
  endCall(
    logId: number,
    outcome: 'success' | 'error' | 'aborted',
    usage?: AiCallUsage,
    error?: string,
  ): void {
    const requests = usage?.requests;
    this.db.transaction((tx) => {
      let costUsd: number | null | undefined = usage?.costUsd;
      if (requests) {
        const overrides = this.readPriceOverrides(tx);
        const now = Date.now();
        let sum: number | null = null;
        requests.forEach((req, seq) => {
          const cost = estimateCostUsd(req, overrides);
          if (cost !== null) sum = (sum ?? 0) + cost;
          tx.insert(aiCallRequest).values({
            callId: logId,
            seq,
            startedAt: new Date(req.startedAt ?? now),
            model: req.model ?? null,
            providerType: req.providerType ?? null,
            inputTokens: req.inputTokens,
            cacheReadTokens: req.cacheReadTokens,
            cacheWriteTokens: req.cacheWriteTokens,
            outputTokens: req.outputTokens,
            costUsd: cost,
            fallbacks: req.fallbacks?.length ? req.fallbacks : null,
          }).run();
        });
        costUsd = sum;
      }
      tx.update(aiCallLog).set({
        endedAt: new Date(),
        outcome,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        turns: usage?.turns,
        toolCalls: usage?.toolCalls,
        costUsd,
        error,
      } as any).where(eq(aiCallLog.id, logId)).run();
    });
  }

  private readPriceOverrides(db: Pick<BetterSQLite3Database<any>, 'select'>) {
    const row = db.select().from(settings).where(eq(settings.key, AI_MODEL_PRICES_SETTING)).get() as
      | { value: string }
      | undefined;
    return parseModelPriceOverrides(row?.value);
  }
}
