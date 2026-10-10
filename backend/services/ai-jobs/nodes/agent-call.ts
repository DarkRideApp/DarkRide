import { resolveTemplate } from '../template';
import type { AgentCallConfig } from '../types';
import type { BoundAgent } from '../../ai-agent-factory';
import { AI_ANALYSIS_MAX_TURNS } from '../../ai-agent';

export interface AgentCallCtx {
  agent: BoundAgent;
  contextId: string;
}

/**
 * Runs one scoped AI prompt through a BoundAgent. Throws on template-resolution failure
 * (TemplateResolutionError, before handleMessage is ever called) or when handleMessage
 * reports result.error / result.aborted. Deliberately does not catch anything itself —
 * the executor (Task 13) creates the right BoundAgent and catches this throw to mark the
 * node 'failed', per the envelope-vs-plain-throw split used by every other node kind.
 */
export async function runAgentCall(
  config: AgentCallConfig,
  input: Record<string, unknown>,
  ctx: AgentCallCtx,
): Promise<Record<string, unknown>> {
  const message = resolveTemplate(config.instructionTemplate, input);

  // HandleMessageResult (ai-agent.ts:102-112) has no text field — only conversationId/usage/
  // error/turnLimitReached/aborted/run. The model's text only ever reaches a caller through
  // the streamed onToken callback; accumulate it here rather than reading a field that
  // doesn't exist.
  let text = '';
  const result = await ctx.agent.handleMessage({
    conversationId: null,
    message,
    pageContext: 'apk-analysis',
    contextId: ctx.contextId,
    mode: 'silent',
    maxTurns: AI_ANALYSIS_MAX_TURNS,
    toolAllowlist: config.toolAllowlist,
    onToken: (chunk) => { text += chunk; },
    // Non-optional on HandleMessageParams (ai-agent.ts:37-72) — omitting them fails to
    // compile and would throw at runtime on the first tool use.
    onToolStart: () => {},
    onToolResult: () => {},
  });

  if (result.error) throw new Error(result.error);
  if (result.aborted) throw new Error('AgentCall aborted');

  return { text };
}
