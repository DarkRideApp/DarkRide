import { describe, it, expect, vi } from 'vitest';
import { describeRule, describeArmed, armedChipLabel, armIntercept, disarmIntercept, interceptHost } from './interceptArm';

describe('describeRule', () => {
  it('renders a compact method + host + path target', () => {
    expect(describeRule({ hostname: '*.stripe.com', method: 'post', path: '/v1/*' })).toBe('POST *.stripe.com/v1/*');
    expect(describeRule({ hostname: 'a.com' })).toBe('a.com');
    expect(describeRule({ method: 'get' })).toBe('GET');
    expect(describeRule({})).toBe('anything');
  });
});

describe('describeArmed', () => {
  it('describes an empty rule list as pausing everything', () => {
    expect(describeArmed({ enabled: true, rules: [], phases: ['request', 'response'] })).toMatch(/pause all requests & responses/i);
  });
  it('describes a single rule inline', () => {
    expect(describeArmed({ enabled: true, rules: [{ hostname: '*.stripe.com', method: 'post' }], phases: ['request'] }))
      .toMatch(/pause requests matching POST \*\.stripe\.com/i);
  });
  it('summarizes multiple rules by count', () => {
    expect(describeArmed({ enabled: true, rules: [{ hostname: 'a.com' }, { hostname: 'b.com' }], phases: ['request', 'response'] }))
      .toMatch(/2 rules/i);
  });
});

describe('armedChipLabel', () => {
  it('is null when disarmed', () => {
    expect(armedChipLabel({ enabled: false, rules: [{ hostname: 'a.com' }], phases: ['request'] })).toBeNull();
  });
  it('shows the single rule target, or a count for many, or "all" for none', () => {
    expect(armedChipLabel({ enabled: true, rules: [{ hostname: 'a.com' }], phases: ['request'] })).toBe('a.com');
    expect(armedChipLabel({ enabled: true, rules: [{ hostname: 'a.com' }, { hostname: 'b.com' }], phases: ['request'] })).toBe('2 rules');
    expect(armedChipLabel({ enabled: true, rules: [], phases: ['request'] })).toBe('all');
  });
});

describe('armIntercept / disarmIntercept', () => {
  it('posts an enabled config with the rules + phases', () => {
    const ws = { sendRestApi: vi.fn().mockResolvedValue({}) };
    armIntercept(ws as any, { rules: [{ hostname: 'a.com' }], phases: ['request'] });
    expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed',
      expect.objectContaining({ enabled: true, rules: [{ hostname: 'a.com' }], phases: ['request'] }));
  });
  it('disarms', () => {
    const ws = { sendRestApi: vi.fn().mockResolvedValue({}) };
    disarmIntercept(ws as any);
    expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/intercept/armed', expect.objectContaining({ enabled: false }));
  });
});

describe('interceptHost', () => {
  it('appends a host rule to the existing armed config', async () => {
    const ws = { sendRestApi: vi.fn().mockImplementation((m: string) =>
      m === 'GET'
        ? Promise.resolve({ body: { data: { enabled: true, rules: [{ hostname: 'a.com', path: null, method: null }], phases: ['request'] } } })
        : Promise.resolve({})) };
    await interceptHost(ws as any, 'b.com');
    expect(ws.sendRestApi).toHaveBeenLastCalledWith('POST', '/v1/intercept/armed', expect.objectContaining({
      enabled: true,
      rules: [{ hostname: 'a.com', path: null, method: null }, { hostname: 'b.com', path: null, method: null }],
      phases: ['request'],
    }));
  });

  it('is idempotent for a host already covered', async () => {
    const ws = { sendRestApi: vi.fn().mockImplementation((m: string) =>
      m === 'GET'
        ? Promise.resolve({ body: { data: { enabled: true, rules: [{ hostname: 'a.com', path: null, method: null }], phases: ['request', 'response'] } } })
        : Promise.resolve({})) };
    await interceptHost(ws as any, 'a.com');
    expect(ws.sendRestApi).toHaveBeenLastCalledWith('POST', '/v1/intercept/armed', expect.objectContaining({
      rules: [{ hostname: 'a.com', path: null, method: null }],
    }));
  });
});
