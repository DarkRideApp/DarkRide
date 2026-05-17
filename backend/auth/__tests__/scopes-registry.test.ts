import { describe, it, expect } from 'vitest';
import { listSupportedScopes, getScopeMetadata, isSupportedScope } from '../scopes-registry';

describe('scopes registry', () => {
  it('mcp scope is registered with metadata', () => {
    const all = listSupportedScopes();
    expect(all.map(s => s.key)).toContain('mcp');
    const mcp = getScopeMetadata('mcp');
    expect(mcp?.label).toBe('Use MCP tools');
    expect(mcp?.description).toMatch(/call darkride mcp tools/i);
  });

  it('returns undefined for unknown scope', () => {
    expect(getScopeMetadata('nonexistent.scope')).toBeUndefined();
  });

  it('isSupportedScope discriminates known vs unknown', () => {
    expect(isSupportedScope('mcp')).toBe(true);
    expect(isSupportedScope('unknown')).toBe(false);
  });
});
