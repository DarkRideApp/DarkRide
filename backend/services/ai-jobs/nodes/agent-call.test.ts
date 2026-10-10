import { describe, it, expect, vi } from 'vitest';
import { runAgentCall } from './agent-call';
import type { AgentCallConfig } from '../types';

function makeFakeAgent(handleMessageImpl: (p: any) => Promise<any>) {
  return { identity: { identityType: 'core-service' as const }, handleMessage: vi.fn(handleMessageImpl) };
}

describe('runAgentCall', () => {
  const config: AgentCallConfig = {
    tier: 'High',
    instructionTemplate: 'Analyze {{trigger.appName}} v{{trigger.versionName}}.',
    toolAllowlist: ['get_apk_overview'],
  };

  it('resolves the template against input and sends it as the message', async () => {
    const agent = makeFakeAgent(async () => ({ run: { requests: [] } }));
    await runAgentCall(config, { trigger: { appName: 'Parc Astérix', versionName: '6.10.1' } }, { agent: agent as any, contextId: '431' });

    expect(agent.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Analyze Parc Astérix v6.10.1.',
      toolAllowlist: ['get_apk_overview'],
      contextId: '431',
      mode: 'silent',
    }));
  });

  it('throws when the template cannot resolve, before ever calling handleMessage', async () => {
    const agent = makeFakeAgent(async () => ({ run: { requests: [] } }));
    await expect(
      runAgentCall({ ...config, instructionTemplate: '{{trigger.missingField}}' }, { trigger: { appName: 'x' } }, { agent: agent as any, contextId: '431' }),
    ).rejects.toThrow(/missingField/);
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('throws when handleMessage reports an error', async () => {
    const agent = makeFakeAgent(async () => ({ error: 'ModelRefusedError: cyber', run: { requests: [] } }));
    await expect(
      runAgentCall(config, { trigger: { appName: 'x', versionName: '1' } }, { agent: agent as any, contextId: '431' }),
    ).rejects.toThrow(/ModelRefusedError/);
  });

  it('accumulates streamed onToken chunks into the returned text — HandleMessageResult has no text field to read instead', async () => {
    const agent = makeFakeAgent(async (p: any) => {
      p.onToken('Summary: ');
      p.onToken('a React Native app.');
      return { run: { requests: [] } };
    });
    const result = await runAgentCall(config, { trigger: { appName: 'x', versionName: '1' } }, { agent: agent as any, contextId: '431' });
    expect(result).toEqual({ text: 'Summary: a React Native app.' });
  });

  it('supplies onToolStart and onToolResult — both are non-optional on HandleMessageParams', async () => {
    const agent = makeFakeAgent(async (p: any) => {
      expect(typeof p.onToolStart).toBe('function');
      expect(typeof p.onToolResult).toBe('function');
      p.onToolStart('id1', 'get_apk_overview', {}, 1, 49); // must not throw
      p.onToolResult('id1', 'get_apk_overview', '{}', 10); // must not throw
      return { run: { requests: [] } };
    });
    await runAgentCall(config, { trigger: { appName: 'x', versionName: '1' } }, { agent: agent as any, contextId: '431' });
  });
});
