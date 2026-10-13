import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { aiConversations } from '../db/schema';
import type { AiMessage } from '../../shared/types/ai-chat';
import type { AgentIdentity } from './ai-agent';

export const INTERRUPTED_NOTE = 'The previous reply was interrupted before it finished.';
export const INTERRUPTED_TOOL_RESULT = 'Interrupted: this tool call was cut off before it returned a result.';

type ConversationRow = typeof aiConversations.$inferSelect;

/** Whose chat this is. Automated runs, services and plain plugins have no owner, so every user can see theirs. */
export function ownerOf(identity: AgentIdentity, automated: boolean): number | null {
  if (automated) return null;
  if (identity.identityType === 'user') return identity.actorUserId;
  if (identity.identityType === 'plugin-acting-for-user') return identity.actingForUserId ?? null;
  return null;
}

/** The stored conversation a run continues, or nothing when the id is new, gone, or someone else's. */
export function loadForRun(db: AppDatabase, conversationId: number | null, ownerId: number | null): ConversationRow | undefined {
  if (conversationId === null) return undefined;
  const row = db.select().from(aiConversations).where(eq(aiConversations.id, conversationId)).get();
  if (!row) return undefined;
  if (ownerId !== null && row.userId !== null && row.userId !== ownerId) return undefined;
  return row;
}

/** Gives every tool call that has no result one, so a run stopped mid-tool does not make the next request invalid. */
function closeOpenToolCalls(messages: AiMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    out.push(message);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const callIds = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    if (callIds.length === 0) continue;
    const answered = new Set<string>();
    while (i + 1 < messages.length) {
      const next = messages[i + 1];
      if (next.role !== 'tool_result') break;
      answered.add(next.toolUseId);
      out.push(next);
      i++;
    }
    for (const id of callIds) {
      if (!answered.has(id)) out.push({ role: 'tool_result', toolUseId: id, content: INTERRUPTED_TOOL_RESULT });
    }
  }
  return out;
}

/** Adds the user's message, with a note first when the last run never reached a reply. */
export function appendUserMessage(messages: AiMessage[], text: string): AiMessage[] {
  const next = closeOpenToolCalls(messages);
  const last = next[next.length - 1];
  if (last && last.role !== 'assistant') {
    next.push({ role: 'assistant', content: [{ type: 'text', text: INTERRUPTED_NOTE }] });
  }
  next.push({ role: 'user', content: text });
  return next;
}

export interface RunStart {
  conversationId: number | null;
  ownerId: number | null;
  automated: boolean;
  pageContext: string;
  contextId: string;
  originPath?: string;
  title: string;
  messages: AiMessage[];
}

/** Saves the user's message before the model is called, so a crash or dropped connection loses nothing. Returns the conversation id. */
export function saveRunStart(db: AppDatabase, run: RunStart): number {
  const now = new Date();
  if (run.conversationId !== null) {
    const { changes } = db
      .update(aiConversations)
      .set({ messages: JSON.stringify(run.messages), unfinished: true, updatedAt: now })
      .where(eq(aiConversations.id, run.conversationId))
      .run();
    if (changes > 0) return run.conversationId;
  }
  const result = db
    .insert(aiConversations)
    .values({
      pageContext: run.pageContext,
      contextId: run.contextId,
      title: run.title,
      messages: JSON.stringify(run.messages),
      userId: run.ownerId,
      originPath: run.originPath ?? null,
      unfinished: true,
      automated: run.automated,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return Number(result.lastInsertRowid);
}

export interface RunEnd {
  messages: AiMessage[];
  inputTokens: number;
  outputTokens: number;
  /** The run was cancelled, failed, or stopped at the turn limit. */
  unfinished: boolean;
  claudeSessionId?: string | null;
}

/** Saves the finished (or stopped) run. A conversation deleted during the run stays deleted. */
export function saveRunEnd(db: AppDatabase, conversationId: number, run: RunEnd): void {
  db.update(aiConversations)
    .set({
      messages: JSON.stringify(run.messages),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      unfinished: run.unfinished,
      ...(run.claudeSessionId !== undefined ? { claudeSessionId: run.claudeSessionId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(aiConversations.id, conversationId))
    .run();
}
