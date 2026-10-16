import type { AiMessage, AiToolDefinition } from '../../../shared/types/ai-chat';

/** The OpenAI-style `{ type: 'function', function }` tool list, which Ollama's native chat API also takes. */
export function functionTools(tools: AiToolDefinition[]): any[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

/** tool_use id -> tool name over a conversation, for wire formats whose tool result names the tool rather than the call. */
export function toolNamesById(messages: AiMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  return names;
}
