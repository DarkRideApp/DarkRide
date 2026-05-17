import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { aiCallLog } from '../db/schema';
import type { AgentIdentity, HandleMessageParams } from './ai-agent';

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

  endCall(
    logId: number,
    outcome: 'success' | 'error' | 'aborted',
    usage?: { inputTokens?: number; outputTokens?: number; turns?: number; costUsd?: number },
    error?: string,
  ): void {
    this.db.update(aiCallLog).set({
      endedAt: new Date(),
      outcome,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      turns: usage?.turns,
      costUsd: usage?.costUsd,
      error,
    } as any).where(eq(aiCallLog.id, logId)).run();
  }
}
