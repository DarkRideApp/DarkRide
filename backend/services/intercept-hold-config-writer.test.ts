import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'fs';
import { getInterceptHoldConfigPath, writeHoldConfig } from './intercept-hold-config-writer';

describe('intercept-hold-config-writer', () => {
  afterEach(() => {
    const p = getInterceptHoldConfigPath();
    if (existsSync(p)) rmSync(p);
  });

  it('writes the armed config to the well-known path as JSON', () => {
    const path = writeHoldConfig({
      enabled: true,
      matchHostname: '*.example.com',
      matchPath: null,
      matchMethod: 'POST',
      phases: ['request'],
    });
    expect(path).toBe(getInterceptHoldConfigPath());
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.enabled).toBe(true);
    expect(written.matchHostname).toBe('*.example.com');
    expect(written.matchMethod).toBe('POST');
    expect(written.phases).toEqual(['request']);
  });

  it('round-trips a disabled config', () => {
    const path = writeHoldConfig({
      enabled: false,
      matchHostname: null,
      matchPath: null,
      matchMethod: null,
      phases: ['request', 'response'],
    });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.enabled).toBe(false);
    expect(written.phases).toEqual(['request', 'response']);
  });
});
