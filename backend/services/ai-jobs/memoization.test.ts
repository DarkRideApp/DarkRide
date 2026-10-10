import { describe, it, expect } from 'vitest';
import { computeInputHash } from './memoization';

describe('computeInputHash', () => {
  it('is stable for the same config + input regardless of key order', () => {
    const a = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: ['a', 'b'] }, { trigger: { appName: 'x', versionName: '1' } });
    const b = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: ['a', 'b'] }, { trigger: { versionName: '1', appName: 'x' } });
    expect(a).toBe(b);
  });

  it('changes when the input changes', () => {
    const config = { kind: 'AgentCall' as const, tier: 'High', instructionTemplate: 'x', toolAllowlist: [] };
    const a = computeInputHash(config, { trigger: { versionName: '6.10.1' } });
    const b = computeInputHash(config, { trigger: { versionName: '6.10.2' } });
    expect(a).not.toBe(b);
  });

  it('changes when the config changes, even with identical input', () => {
    const input = { trigger: { versionName: '1' } };
    const a = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'old prompt', toolAllowlist: [] }, input);
    const b = computeInputHash({ kind: 'AgentCall', tier: 'High', instructionTemplate: 'new prompt', toolAllowlist: [] }, input);
    expect(a).not.toBe(b);
  });
});
