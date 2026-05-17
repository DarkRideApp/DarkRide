import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import { aiConversations } from '../db/schema';
import type { ClaudeCliProvider } from './claude-cli-provider';
import { buildSystemPrompt, generateTitle, DEFAULT_MAX_TURNS, type AiAgentInterface, type AgentIdentity, type HandleMessageParams, type HandleMessageResult } from './ai-agent';
import { createLoggers } from '../logs';
import type { AiMessage, AiAssistantMessage, AiTextBlock, AiToolUseBlock } from '../../shared/types/ai-chat';

const { log, error: logError } = createLoggers('claude-cli-agent');

export class ClaudeCliAgent implements AiAgentInterface {
  constructor(
    private db: AppDatabase,
    private cliProvider: ClaudeCliProvider,
    private model: string,
  ) {}

  public async handleMessage(_params: HandleMessageParams): Promise<HandleMessageResult> {
    throw new Error(
      'handleMessage called directly without AgentIdentity. ' +
      'Callers must obtain an agent via AiAgentFactory (aiFactory.forUser / forCoreService) ' +
      'or ctx.ai (agent / forUser) — never by constructing an AiAgent directly.',
    );
  }

  public async handleMessageWithIdentity(identity: AgentIdentity, params: HandleMessageParams): Promise<HandleMessageResult> {
    return this._runMessage(identity, params);
  }

  private async _runMessage(identity: AgentIdentity, params: HandleMessageParams): Promise<HandleMessageResult> {
    const {
      message,
      pageContext,
      contextId,
      onToken,
      onToolStart,
      onToolResult,
      signal,
      maxTurns,
    } = params;

    let { conversationId } = params;

    // 1. Load existing conversation to get claudeSessionId for resume
    let messages: AiMessage[] = [];
    let existingSessionId: string | null = null;

    if (conversationId !== null) {
      const row = this.db
        .select()
        .from(aiConversations)
        .where(eq(aiConversations.id, conversationId))
        .get();
      if (row) {
        messages = JSON.parse(row.messages);
        existingSessionId = row.claudeSessionId ?? null;
      }
    }

    // 2. Append user message
    messages.push({ role: 'user', content: message });

    // 3. Build system prompt — pass empty tools list since MCP exposes them
    const systemPrompt = buildSystemPrompt(pageContext, contextId, [], maxTurns);

    // 4. Accumulate assistant content blocks and track state
    const assistantTextChunks: string[] = [];
    const assistantToolUses: AiToolUseBlock[] = [];
    const toolResults: Array<{ toolUseId: string; toolName: string; content: string }> = [];

    let toolUseCount = 0;
    let cliSessionId: string | null = existingSessionId;
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let turnLimitReached = false;

    // 5. Call CLI provider
    let cliError: string | undefined;
    try {
      const result = await this.cliProvider.sendMessage(
        message,
        {
          onText: (text) => {
            assistantTextChunks.push(text);
            onToken(text);
          },
          onToolStart: (toolUseId, toolName, input) => {
            toolUseCount++;
            assistantToolUses.push({ type: 'tool_use', id: toolUseId, name: toolName, input });
            onToolStart(toolUseId, toolName, input, toolUseCount, 0);
          },
          onToolResult: (toolUseId, toolName, result) => {
            toolResults.push({ toolUseId, toolName, content: result });
            onToolResult(toolUseId, toolName, result, 0);
          },
          onUsage: (inputTokens, outputTokens) => {
            totalUsage.inputTokens = inputTokens;
            totalUsage.outputTokens = outputTokens;
          },
          onSessionInit: (sessionId) => {
            cliSessionId = sessionId;
            log(`CLI session initialised: ${sessionId}`);
          },
        },
        {
          sessionId: existingSessionId ?? undefined,
          model: this.model,
          signal,
          systemPrompt,
          identity,
        },
      );

      if (result.usage) {
        totalUsage = result.usage;
      }
      if (result.error) {
        cliError = result.error;
      }
      if (result.sessionId) {
        cliSessionId = result.sessionId;
      }
      const effectiveMaxTurns = maxTurns ?? DEFAULT_MAX_TURNS;
      if (result.numTurns >= effectiveMaxTurns) {
        turnLimitReached = true;
      }
    } catch (err: any) {
      logError(`ClaudeCliAgent sendMessage error: ${err.message}`);
      cliError = `Error: ${err.message || String(err)}`;
    }

    // 6. Build assistant message with content blocks
    const assistantContent: Array<AiTextBlock | AiToolUseBlock> = [];
    const fullText = assistantTextChunks.join('');
    if (fullText) {
      assistantContent.push({ type: 'text', text: fullText });
    }
    for (const tu of assistantToolUses) {
      assistantContent.push(tu);
    }
    if (cliError && assistantContent.length === 0) {
      assistantContent.push({ type: 'text', text: `Error: ${cliError}` });
    }

    if (assistantContent.length > 0) {
      const assistantMsg: AiAssistantMessage = { role: 'assistant', content: assistantContent };
      messages.push(assistantMsg);
    }

    // Append tool results as tool_result messages
    for (const tr of toolResults) {
      messages.push({ role: 'tool_result', toolUseId: tr.toolUseId, content: tr.content });
    }

    // 7. Persist conversation to DB
    // Note: the messages array here is for display/audit purposes only.
    // Session continuity is handled by the CLI via --resume using claudeSessionId,
    // not by replaying these messages.
    const title = generateTitle(message);
    const now = new Date();

    if (conversationId !== null) {
      this.db
        .update(aiConversations)
        .set({
          messages: JSON.stringify(messages),
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          claudeSessionId: cliSessionId,
          updatedAt: now,
        })
        .where(eq(aiConversations.id, conversationId))
        .run();
    } else {
      const result = this.db
        .insert(aiConversations)
        .values({
          pageContext,
          contextId,
          title,
          messages: JSON.stringify(messages),
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          claudeSessionId: cliSessionId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      conversationId = Number(result.lastInsertRowid);
    }

    // 8. Return result
    return {
      conversationId,
      usage: totalUsage,
      error: cliError,
      turnLimitReached,
    };
  }
}
