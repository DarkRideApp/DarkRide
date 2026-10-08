// backend/services/ai/__tests__/ollama.dialect.test.ts
// fixtures: hand-written from https://docs.ollama.com/api/chat (wire shape only)
import { describe, it, expect } from 'vitest';
import { ollamaDialect } from '../dialects/ollama-chat';
import { makeCtx } from '../test-ctx';
import { ndjsonResponse, collect } from '../test-helpers';
import { AiProviderError } from '../errors';

const run = (lines: unknown[]) => collect(ollamaDialect.parseStream(ndjsonResponse(lines), makeCtx('ollama')));
const req = { messages: [{ role: 'user' as const, content: 'hi' }], systemPrompt: 'sys', tools: [] };

describe('buildChat', () => {
  it('posts to /api/chat with system first, no auth header', () => {
    const b: any = ollamaDialect.buildChat(makeCtx('ollama'), req, { stream: true });
    expect(b.url).toBe('http://localhost:11434/api/chat');
    expect(b.headers.Authorization).toBeUndefined();
    expect(b.body).toMatchObject({ model: 'llama3.1', stream: true });
    expect(b.body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
  it('maps options only when limits are set', () => {
    const b: any = ollamaDialect.buildChat(makeCtx('ollama'), { ...req, maxOutputTokens: 256, stopSequences: ['x'], temperature: 0 }, { stream: true });
    expect(b.body.options).toEqual({ num_predict: 256, stop: ['x'], temperature: 0 });
    expect((ollamaDialect.buildChat(makeCtx('ollama'), req, { stream: true }) as any).body.options).toBeUndefined();
  });
  it('tool results carry tool_name and tool_call_id; empty assistant content is preserved as an empty string', () => {
    const b: any = ollamaDialect.buildChat(makeCtx('ollama'), {
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }] },
        { role: 'tool_result', toolUseId: 'c1', content: 'done' },
      ],
    }, { stream: true });
    expect(b.body.messages[2]).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] });
    expect(b.body.messages[3]).toEqual({ role: 'tool', content: 'done', tool_call_id: 'c1', tool_name: 'f' });
  });
});

describe('parseStream', () => {
  it('yields text, tool calls with synthesised ids (arguments as object or string), and usage on done', async () => {
    const events = await run([
      { message: { content: 'Hi' } },
      { message: { tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }, { id: 'given', function: { name: 'g', arguments: '{"b":2}' } }] } },
      { done: true, prompt_eval_count: 9, eval_count: 3 },
    ]);
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool_use', id: 'id-1', name: 'f', input: { a: 1 } },
      { type: 'tool_use', id: 'given', name: 'g', input: { b: 2 } },
      { type: 'usage', inputTokens: 9, outputTokens: 3 },
    ]);
  });
  it('a {"error": "..."} line throws', async () => {
    await expect(run([{ error: 'model "x" not found' }])).rejects.toThrow(/Ollama stream error: model "x" not found/);
    await expect(run([{ error: 'x' }])).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('models', () => {
  it('lists /api/tags', () => {
    expect(ollamaDialect.buildListModels!(makeCtx('ollama')).url).toBe('http://localhost:11434/api/tags');
    expect(ollamaDialect.parseModels!({ models: [{ name: 'llama3.1:latest', model: 'llama3.1:latest' }, { name: 'q' }] }).models)
      .toEqual([{ id: 'llama3.1:latest', name: 'llama3.1:latest' }, { id: 'q', name: 'q' }]);
  });
});
