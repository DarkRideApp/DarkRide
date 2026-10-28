import { describe, it, expect } from 'vitest';
import { functionTools, toolNamesById } from '../format';
import type { AiMessage, AiToolDefinition } from '../../../../shared/types/ai-chat';

const tool = (name: string, description = `${name} description`): AiToolDefinition => ({
  name, description, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, context: [],
} as AiToolDefinition);

describe('functionTools', () => {
  it('wraps each tool as an OpenAI-style function definition, keeping the schema as it is', () => {
    expect(functionTools([tool('get_apps'), tool('run_it', 'Runs it')])).toEqual([
      { type: 'function', function: { name: 'get_apps', description: 'get_apps description', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } },
      { type: 'function', function: { name: 'run_it', description: 'Runs it', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } },
    ]);
  });

  it('returns an empty list for no tools', () => {
    expect(functionTools([])).toEqual([]);
  });

  it('does not copy fields the wire format does not carry', () => {
    const [def] = functionTools([tool('t')]);
    expect(Object.keys(def)).toEqual(['type', 'function']);
    expect(Object.keys(def.function)).toEqual(['name', 'description', 'parameters']);
  });
});

describe('toolNamesById', () => {
  const messages: AiMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'a', name: 'first', input: {} }] },
    { role: 'tool_result', toolUseId: 'a', content: 'r1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'second', input: {} }, { type: 'tool_use', id: 'c', name: 'third', input: {} }] },
  ] as AiMessage[];

  it('maps every tool_use id in the conversation to its tool name', () => {
    expect([...toolNamesById(messages)]).toEqual([['a', 'first'], ['b', 'second'], ['c', 'third']]);
  });

  it('ignores user text, tool results and text blocks', () => {
    expect(toolNamesById([messages[0], messages[2]]).size).toBe(0);
    expect(toolNamesById([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] as AiMessage[]).size).toBe(0);
  });

  it('is empty for an empty conversation', () => {
    expect(toolNamesById([]).size).toBe(0);
  });

  it('keeps the last name when an id repeats', () => {
    const repeated = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'old', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'new', input: {} }] },
    ] as AiMessage[];
    expect(toolNamesById(repeated).get('x')).toBe('new');
  });
});
