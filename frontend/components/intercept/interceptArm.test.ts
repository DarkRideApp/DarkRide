import { describe, it, expect, vi } from 'vitest';
import { describeScope, scopeChipLabel, armIntercept, disarmIntercept } from './interceptArm';

describe('describeScope', () => {
  it('describes an unscoped arm as pausing everything', () => {
    expect(describeScope({ phases: ['request', 'response'] })).toMatch(/pause all requests & responses/i);
  });

  it('describes a host + method + request scope in plain English', () => {
    expect(describeScope({ matchHostname: '*.stripe.com', matchMethod: 'post', phases: ['request'] }))
      .toMatch(/pause POST requests to \*\.stripe\.com/i);
  });

  it('includes the path when set', () => {
    expect(describeScope({ matchHostname: 'api.x.com', matchPath: '/v1/*', phases: ['request', 'response'] }))
      .toContain('api.x.com/v1/*');
  });

  it('handles response-only phase wording', () => {
    expect(describeScope({ matchHostname: 'a.com', phases: ['response'] })).toMatch(/responses to a\.com/i);
  });
});

describe('scopeChipLabel', () => {
  it('returns null when disarmed or unscoped', () => {
    expect(scopeChipLabel({ enabled: false, phases: ['request'] })).toBeNull();
    expect(scopeChipLabel({ enabled: true, phases: ['request'] })).toBeNull();
  });
  it('prefers hostname, then path, then method', () => {
    expect(scopeChipLabel({ enabled: true, matchHostname: 'a.com', matchPath: '/x', phases: ['request'] })).toBe('a.com');
    expect(scopeChipLabel({ enabled: true, matchPath: '/x', phases: ['request'] })).toBe('/x');
    expect(scopeChipLabel({ enabled: true, matchMethod: 'get', phases: ['request'] })).toBe('GET');
  });
});

describe('armIntercept / disarmIntercept', () => {
  it('posts an enabled config with the scope', () => {
    const ws = { sendRestApi: vi.fn().mockResolvedValue({}) };
    armIntercept(ws as any, { matchHostname: 'a.com', phases: ['request'] });
    expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed',
      expect.objectContaining({ enabled: true, matchHostname: 'a.com', phases: ['request'] }));
  });
  it('posts a disabled config on disarm', () => {
    const ws = { sendRestApi: vi.fn().mockResolvedValue({}) };
    disarmIntercept(ws as any);
    expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed',
      expect.objectContaining({ enabled: false }));
  });
});
