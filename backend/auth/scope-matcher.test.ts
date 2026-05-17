import { describe, it, expect } from 'vitest';
import { scopeMatches, scopeCovers, scopeIntersect } from './scope-matcher';

describe('scopeCovers', () => {
  describe('Rule 1: exact match', () => {
    it('matches identical strings', () => {
      expect(scopeCovers('core.settings:read', 'core.settings:read')).toBe(true);
    });
    it('rejects different strings', () => {
      expect(scopeCovers('core.settings:read', 'core.settings:write')).toBe(false);
    });
    it('rejects partial prefix match', () => {
      expect(scopeCovers('core.settings', 'core.settings:read')).toBe(false);
    });
  });

  describe('Rule 2: verb wildcard', () => {
    it('core.settings:* covers core.settings:read', () => {
      expect(scopeCovers('core.settings:*', 'core.settings:read')).toBe(true);
    });
    it('core.settings:* covers core.settings:write', () => {
      expect(scopeCovers('core.settings:*', 'core.settings:write')).toBe(true);
    });
    it('core.settings:* does NOT cover core.automations:read', () => {
      expect(scopeCovers('core.settings:*', 'core.automations:read')).toBe(false);
    });
    it('plugin.alpha.feature_a:* covers any verb on that area', () => {
      expect(scopeCovers('plugin.alpha.feature_a:*', 'plugin.alpha.feature_a:write')).toBe(true);
    });
  });

  describe('Rule 3: subtree wildcard', () => {
    it('plugin.alpha.*:read covers plugin.alpha.feature_a:read', () => {
      expect(scopeCovers('plugin.alpha.*:read', 'plugin.alpha.feature_a:read')).toBe(true);
    });
    it('plugin.alpha.*:read does NOT cover plugin.alpha.feature_a:write', () => {
      expect(scopeCovers('plugin.alpha.*:read', 'plugin.alpha.feature_a:write')).toBe(false);
    });
    it('core.*:read covers core.settings:read', () => {
      expect(scopeCovers('core.*:read', 'core.settings:read')).toBe(true);
    });
    it('core.*:read does NOT cover core.settings:write', () => {
      expect(scopeCovers('core.*:read', 'core.settings:write')).toBe(false);
    });
  });

  describe('Rule 4: plugin-wide (prefix + verb wildcard)', () => {
    it('plugin.alpha:* covers plugin.alpha.feature_a:read', () => {
      expect(scopeCovers('plugin.alpha:*', 'plugin.alpha.feature_a:read')).toBe(true);
    });
    it('plugin.alpha:* covers plugin.alpha.feature_b:trigger', () => {
      expect(scopeCovers('plugin.alpha:*', 'plugin.alpha.feature_b:trigger')).toBe(true);
    });
    it('plugin.alpha:* does NOT cover plugin.beta.tiles:read', () => {
      expect(scopeCovers('plugin.alpha:*', 'plugin.beta.tiles:read')).toBe(false);
    });
    it('core.automations:* covers core.automations.rules:edit', () => {
      expect(scopeCovers('core.automations:*', 'core.automations.rules:edit')).toBe(true);
    });
  });

  describe('Rule 5: universal escape hatch', () => {
    it('core.admin:* covers any core scope', () => {
      expect(scopeCovers('core.admin:*', 'core.settings:read')).toBe(true);
      expect(scopeCovers('core.admin:*', 'core.host:shell')).toBe(true);
    });
    it('core.admin:* covers any plugin scope', () => {
      expect(scopeCovers('core.admin:*', 'plugin.alpha.feature_a:read')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('empty grant covers nothing', () => {
      expect(scopeCovers('', 'core.settings:read')).toBe(false);
    });
    it('grant without verb separator does not match', () => {
      expect(scopeCovers('core.settings', 'core.settings:read')).toBe(false);
    });
    it('required without verb separator does not match', () => {
      expect(scopeCovers('core.settings:read', 'core.settings')).toBe(false);
    });
    it('deeply nested subtree works', () => {
      expect(scopeCovers('plugin.alpha:*', 'plugin.alpha.a.b.c:deep')).toBe(true);
    });
    it('subtree wildcard with verb wildcard', () => {
      expect(scopeCovers('plugin.alpha.*:*', 'plugin.alpha.feature_a:write')).toBe(true);
    });
    // MG-1: degenerate edge case — both strings are empty
    it('empty string matches empty string (degenerate case)', () => {
      expect(scopeCovers('', '')).toBe(true);
    });
  });
});

describe('scopeMatches', () => {
  it('returns true if any grant covers the required scope', () => {
    const grants = new Set(['core.settings:read', 'core.automations:execute']);
    expect(scopeMatches(grants, 'core.settings:read')).toBe(true);
    expect(scopeMatches(grants, 'core.automations:execute')).toBe(true);
  });

  it('returns false if no grant covers the required scope', () => {
    const grants = new Set(['core.settings:read']);
    expect(scopeMatches(grants, 'core.settings:write')).toBe(false);
  });

  it('core.admin:* covers everything', () => {
    const grants = new Set(['core.admin:*']);
    expect(scopeMatches(grants, 'core.host:shell')).toBe(true);
    expect(scopeMatches(grants, 'plugin.alpha.feature_a:write')).toBe(true);
  });

  it('empty grants covers nothing', () => {
    const grants = new Set<string>();
    expect(scopeMatches(grants, 'core.settings:read')).toBe(false);
  });

  it('wildcard grant covers all matching scopes', () => {
    const grants = new Set(['core.automations:*']);
    expect(scopeMatches(grants, 'core.automations:read')).toBe(true);
    expect(scopeMatches(grants, 'core.automations:edit')).toBe(true);
    expect(scopeMatches(grants, 'core.automations:execute')).toBe(true);
    expect(scopeMatches(grants, 'core.settings:read')).toBe(false);
  });
});

describe('scopeIntersect', () => {
  it('keeps only plugin scopes the user covers', () => {
    const user = new Set(['core.apk:read']);
    const plugin = ['core.apk:read', 'core.apk:manage', 'core.devices:read'];
    expect(scopeIntersect(user, plugin)).toEqual(['core.apk:read']);
  });

  it('user admin covers everything plugin asks for', () => {
    const user = new Set(['core.admin:*']);
    const plugin = ['core.apk:read', 'core.devices:read'];
    expect(scopeIntersect(user, plugin).sort())
      .toEqual(['core.apk:read', 'core.devices:read'].sort());
  });

  it('wildcard user scope covers matching plugin scopes', () => {
    const user = new Set(['core.apk:*']);
    const plugin = ['core.apk:read', 'core.apk:manage', 'core.devices:read'];
    expect(scopeIntersect(user, plugin).sort())
      .toEqual(['core.apk:manage', 'core.apk:read']);
  });

  it('returns empty when there is no overlap', () => {
    const user = new Set(['core.traffic:read']);
    const plugin = ['core.apk:read'];
    expect(scopeIntersect(user, plugin)).toEqual([]);
  });

  it('preserves plugin scope strings as declared (never widens)', () => {
    const user = new Set(['core.admin:*']);
    const plugin = ['core.apk:read'];
    const result = scopeIntersect(user, plugin);
    expect(result).toEqual(['core.apk:read']);
    expect(result).not.toContain('core.admin:*');
  });
});
