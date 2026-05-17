import { describe, it, expect, vi } from 'vitest';
import { AiToolRegistry, type AiToolRegistration } from './ai-tools';

function makeTool(overrides: Partial<AiToolRegistration> = {}): AiToolRegistration {
  return {
    name: overrides.name ?? 'test-tool',
    description: overrides.description ?? 'A test tool',
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
    context: overrides.context ?? ['devices'],
    execute: overrides.execute ?? (async () => 'ok'),
    ...(overrides.requiredScope !== undefined && { requiredScope: overrides.requiredScope }),
    ...(overrides.requiresConfirmation !== undefined && { requiresConfirmation: overrides.requiresConfirmation }),
    ...(overrides.allowUnattended !== undefined && { allowUnattended: overrides.allowUnattended }),
  };
}

describe('AiToolRegistry', () => {
  // ── getToolsForContext ─────────────────────────────────────────

  it('returns tools registered for a given context', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));
    registry.register(makeTool({ name: 'b', context: ['automations'] }));

    const result = registry.getToolsForContext('devices');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('a');
  });

  it('returns empty array for unknown context', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));

    expect(registry.getToolsForContext('nonexistent')).toEqual([]);
  });

  it('returns tool belonging to multiple contexts in both', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'multi', context: ['devices', 'automations'] }));

    expect(registry.getToolsForContext('devices')).toHaveLength(1);
    expect(registry.getToolsForContext('automations')).toHaveLength(1);
    expect(registry.getToolsForContext('devices')[0].name).toBe('multi');
    expect(registry.getToolsForContext('automations')[0].name).toBe('multi');
  });

  // ── getToolDefinitions ─────────────────────────────────────────

  it('returns definitions without the execute property', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));

    const defs = registry.getToolDefinitions('devices');
    const toolDef = defs.find((d) => d.name === 'a')!;
    expect(toolDef).toBeDefined();
    expect(toolDef.name).toBe('a');
    expect(toolDef.description).toBe('A test tool');
    expect((toolDef as any).execute).toBeUndefined();
  });

  it('always includes request_tools in definitions', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));

    const defs = registry.getToolDefinitions('devices');
    const meta = defs.find((d) => d.name === 'request_tools');
    expect(meta).toBeDefined();
    expect(meta!.context).toEqual([]);
    expect(meta!.inputSchema).toEqual({
      type: 'object',
      properties: { contexts: { type: 'array', items: { type: 'string' } } },
      required: ['contexts'],
    });
  });

  it('includes request_tools even for unknown context', () => {
    const registry = new AiToolRegistry();
    const defs = registry.getToolDefinitions('unknown');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('request_tools');
  });

  // ── getToolDefinitionsForContexts ──────────────────────────────

  it('deduplicates tools appearing in multiple requested contexts', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'shared', context: ['devices', 'automations'] }));
    registry.register(makeTool({ name: 'only-auto', context: ['automations'] }));

    const defs = registry.getToolDefinitionsForContexts(['devices', 'automations']);
    const names = defs.map((d) => d.name);

    // shared + only-auto + request_tools
    expect(names).toHaveLength(3);
    expect(names.filter((n) => n === 'shared')).toHaveLength(1); // no duplicate
    expect(names).toContain('only-auto');
    expect(names).toContain('request_tools');
  });

  // ── executeTool ────────────────────────────────────────────────

  it('calls the correct execute function and returns result', async () => {
    const registry = new AiToolRegistry();
    const fn = vi.fn().mockResolvedValue({ status: 'done' });
    registry.register(makeTool({ name: 'runner', execute: fn }));

    const result = await registry.executeTool('runner', { foo: 1 });
    expect(fn).toHaveBeenCalledWith({ foo: 1 });
    expect(result).toEqual({ status: 'done' });
  });

  it('throws for unknown tool name', async () => {
    const registry = new AiToolRegistry();
    await expect(registry.executeTool('nope', {})).rejects.toThrow('Unknown tool: nope');
  });

  // ── listContexts ──────────────────────────────────────────────

  it('returns all unique contexts across registered tools', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices', 'automations'] }));
    registry.register(makeTool({ name: 'b', context: ['automations', 'traffic'] }));

    const contexts = registry.listContexts();
    expect(contexts).toHaveLength(3);
    expect(contexts).toContain('devices');
    expect(contexts).toContain('automations');
    expect(contexts).toContain('traffic');
  });

  it('returns empty array when no tools are registered', () => {
    const registry = new AiToolRegistry();
    expect(registry.listContexts()).toEqual([]);
  });

  // ── request_tools description includes contexts ────────────────

  it('request_tools description lists available contexts', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));
    registry.register(makeTool({ name: 'b', context: ['traffic'] }));

    const defs = registry.getToolDefinitions('devices');
    const meta = defs.find((d) => d.name === 'request_tools')!;
    expect(meta.description).toContain('devices');
    expect(meta.description).toContain('traffic');
  });

  // ── Duplicate registration ──────────────────────────────────────

  it('should overwrite tool when registered with same name twice', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'test', description: 'first', context: ['devices'] }));
    registry.register(makeTool({ name: 'test', description: 'second', context: ['devices'] }));

    const tools = registry.getToolsForContext('devices');
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe('second');
  });

  it('should use latest execute function for duplicate names', async () => {
    const registry = new AiToolRegistry();
    const fn1 = vi.fn().mockResolvedValue('first');
    const fn2 = vi.fn().mockResolvedValue('second');
    registry.register(makeTool({ name: 'dup', execute: fn1 }));
    registry.register(makeTool({ name: 'dup', execute: fn2 }));

    const result = await registry.executeTool('dup', {});
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledWith({});
    expect(result).toBe('second');
  });

  // ── Empty/edge cases ────────────────────────────────────────────

  it('should handle tool with empty context array', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'no-context', context: [] }));

    // Tool exists (can be executed) but never returned by getToolsForContext
    expect(registry.getToolsForContext('devices')).toEqual([]);
    expect(registry.getToolsForContext('automations')).toEqual([]);
    // Still executable by name
    await expect(registry.executeTool('no-context', {})).resolves.toBe('ok');
  });

  it('should include only request_tools for context with no tools', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));

    const defs = registry.getToolDefinitions('empty');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('request_tools');
  });

  it('should handle getToolDefinitionsForContexts with empty array', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));

    const defs = registry.getToolDefinitionsForContexts([]);
    // Only request_tools is appended
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('request_tools');
  });

  it('should handle getToolDefinitionsForContexts deduplication', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'shared', context: ['contextA', 'contextB'] }));

    const defs = registry.getToolDefinitionsForContexts(['contextA', 'contextB']);
    const sharedDefs = defs.filter((d) => d.name === 'shared');
    expect(sharedDefs).toHaveLength(1);
    // request_tools + shared = 2
    expect(defs).toHaveLength(2);
  });

  // ── Error handling ──────────────────────────────────────────────

  it('should propagate tool execute rejection', async () => {
    const registry = new AiToolRegistry();
    const error = new Error('something broke');
    registry.register(makeTool({ name: 'fail', execute: async () => { throw error; } }));

    await expect(registry.executeTool('fail', {})).rejects.toThrow('something broke');
    await expect(registry.executeTool('fail', {})).rejects.toBe(error);
  });

  it('should propagate non-Error throws from tool', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({
      name: 'fail-string',
      execute: async () => { throw 'failed'; },
    }));

    await expect(registry.executeTool('fail-string', {})).rejects.toBe('failed');
  });

  it('should handle tool that returns a promise resolving to undefined', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({
      name: 'undef',
      execute: async () => undefined,
    }));

    const result = await registry.executeTool('undef', {});
    expect(result).toBeUndefined();
  });

  // ── request_tools meta-tool ─────────────────────────────────────

  it('should list all unique contexts in request_tools description', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));
    registry.register(makeTool({ name: 'b', context: ['automations'] }));
    registry.register(makeTool({ name: 'c', context: ['traffic'] }));

    const defs = registry.getToolDefinitions('devices');
    const meta = defs.find((d) => d.name === 'request_tools')!;
    expect(meta.description).toContain('devices');
    expect(meta.description).toContain('automations');
    expect(meta.description).toContain('traffic');
  });

  it('should have correct inputSchema for request_tools', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'a', context: ['devices'] }));

    const defs = registry.getToolDefinitions('devices');
    const meta = defs.find((d) => d.name === 'request_tools')!;
    expect(meta.inputSchema).toEqual({
      type: 'object',
      properties: {
        contexts: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['contexts'],
    });
  });

  // ── Large scale ─────────────────────────────────────────────────

  // ── Scope-gating (executeTool) ──────────────────────────────────

  it('executeTool succeeds when userScopes include the required scope', async () => {
    const registry = new AiToolRegistry();
    const fn = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({ name: 'scoped', requiredScope: 'devices:read', execute: fn }));

    const result = await registry.executeTool('scoped', { x: 1 }, new Set(['devices:read']));
    expect(fn).toHaveBeenCalledWith({ x: 1 });
    expect(result).toBe('ok');
  });

  it('executeTool throws when userScopes do not include the required scope', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'scoped', requiredScope: 'devices:write' }));

    await expect(
      registry.executeTool('scoped', {}, new Set(['devices:read'])),
    ).rejects.toThrow('Insufficient scope');
  });

  it('executeTool succeeds when userScopes is undefined (no auth)', async () => {
    const registry = new AiToolRegistry();
    const fn = vi.fn().mockResolvedValue('allowed');
    registry.register(makeTool({ name: 'scoped', requiredScope: 'devices:write', execute: fn }));

    const result = await registry.executeTool('scoped', {});
    expect(fn).toHaveBeenCalled();
    expect(result).toBe('allowed');
  });

  it('executeTool succeeds with wildcard scope core.admin:*', async () => {
    const registry = new AiToolRegistry();
    const fn = vi.fn().mockResolvedValue('admin-ok');
    registry.register(makeTool({ name: 'protected', requiredScope: 'plugin.demo-plugin:write', execute: fn }));

    const result = await registry.executeTool('protected', {}, new Set(['core.admin:*']));
    expect(fn).toHaveBeenCalled();
    expect(result).toBe('admin-ok');
  });

  // ── Unattended mode ───────────────────────────────────────────────

  it('executeTool throws when unattended=true on tool with allowUnattended: false', async () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'dangerous', allowUnattended: false }));

    await expect(
      registry.executeTool('dangerous', {}, undefined, true),
    ).rejects.toThrow('not available in unattended mode');
  });

  it('executeTool succeeds when unattended=true on tool with allowUnattended: true', async () => {
    const registry = new AiToolRegistry();
    const fn = vi.fn().mockResolvedValue('safe');
    registry.register(makeTool({ name: 'safe-tool', allowUnattended: true, execute: fn }));

    const result = await registry.executeTool('safe-tool', {}, undefined, true);
    expect(fn).toHaveBeenCalled();
    expect(result).toBe('safe');
  });

  it('executeTool succeeds when unattended=true on tool with allowUnattended undefined (default)', async () => {
    const registry = new AiToolRegistry();
    const fn = vi.fn().mockResolvedValue('default-ok');
    registry.register(makeTool({ name: 'default-tool', execute: fn }));

    const result = await registry.executeTool('default-tool', {}, undefined, true);
    expect(fn).toHaveBeenCalled();
    expect(result).toBe('default-ok');
  });

  it('getToolDefinitionsForUser with unattended=true filters out allowUnattended: false tools', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'safe', context: ['devices'], allowUnattended: true }));
    registry.register(makeTool({ name: 'dangerous', context: ['devices'], allowUnattended: false }));

    const defs = registry.getToolDefinitionsForUser('devices', undefined, true);
    const names = defs.map((d) => d.name);
    expect(names).toContain('safe');
    expect(names).not.toContain('dangerous');
    expect(names).toContain('request_tools');
  });

  it('listAccessibleContexts with unattended=true excludes contexts with only blocked tools', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'safe', context: ['analytics'], allowUnattended: true }));
    registry.register(makeTool({ name: 'dangerous', context: ['device-control'], allowUnattended: false }));

    const contexts = registry.listAccessibleContexts(undefined, true);
    expect(contexts).toContain('analytics');
    expect(contexts).not.toContain('device-control');
  });

  // ── requiresConfirmation ──────────────────────────────────────────

  it('requiresConfirmation returns true for tool with flag set', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'confirm-me', requiresConfirmation: true }));

    expect(registry.requiresConfirmation('confirm-me')).toBe(true);
  });

  it('requiresConfirmation returns false for tool without flag', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'no-confirm' }));

    expect(registry.requiresConfirmation('no-confirm')).toBe(false);
  });

  it('requiresConfirmation returns false for nonexistent tool', () => {
    const registry = new AiToolRegistry();

    expect(registry.requiresConfirmation('nonexistent')).toBe(false);
  });

  // ── Scope-filtered tool definitions ───────────────────────────────

  it('getToolDefinitionsForUser returns only tools matching scopes', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'allowed', context: ['devices'], requiredScope: 'devices:read' }));
    registry.register(makeTool({ name: 'blocked', context: ['devices'], requiredScope: 'devices:write' }));
    registry.register(makeTool({ name: 'unrestricted', context: ['devices'] }));

    const defs = registry.getToolDefinitionsForUser('devices', new Set(['devices:read']));
    const names = defs.map((d) => d.name);
    expect(names).toContain('allowed');
    expect(names).toContain('unrestricted');
    expect(names).not.toContain('blocked');
    expect(names).toContain('request_tools');
  });

  it('getToolDefinitionsForContextsForUser deduplicates and filters', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'shared', context: ['devices', 'traffic'], requiredScope: 'core:read' }));
    registry.register(makeTool({ name: 'blocked', context: ['devices'], requiredScope: 'core:admin' }));
    registry.register(makeTool({ name: 'open', context: ['traffic'] }));

    const defs = registry.getToolDefinitionsForContextsForUser(
      ['devices', 'traffic'],
      new Set(['core:read']),
    );
    const names = defs.map((d) => d.name);
    // shared appears once (deduplicated), blocked is filtered out, open is unrestricted
    expect(names.filter((n) => n === 'shared')).toHaveLength(1);
    expect(names).not.toContain('blocked');
    expect(names).toContain('open');
    expect(names).toContain('request_tools');
  });

  it('buildRequestToolsDef only lists contexts with accessible tools', () => {
    const registry = new AiToolRegistry();
    registry.register(makeTool({ name: 'readable', context: ['devices'], requiredScope: 'devices:read' }));
    registry.register(makeTool({ name: 'admin-only', context: ['admin'], requiredScope: 'core:admin' }));

    const defs = registry.getToolDefinitionsForUser('devices', new Set(['devices:read']));
    const requestTools = defs.find((d) => d.name === 'request_tools')!;
    expect(requestTools.description).toContain('devices');
    expect(requestTools.description).not.toContain('admin');
  });

  // ── Large scale ─────────────────────────────────────────────────

  it('should handle many tools registered efficiently', () => {
    const registry = new AiToolRegistry();
    for (let i = 0; i < 50; i++) {
      registry.register(makeTool({
        name: `tool-${i}`,
        context: i % 2 === 0 ? ['even'] : ['odd'],
      }));
    }

    const evenTools = registry.getToolsForContext('even');
    const oddTools = registry.getToolsForContext('odd');
    expect(evenTools).toHaveLength(25);
    expect(oddTools).toHaveLength(25);

    // Every even-indexed tool should be in 'even' context
    for (let i = 0; i < 50; i += 2) {
      expect(evenTools.find((t) => t.name === `tool-${i}`)).toBeDefined();
    }
    // Every odd-indexed tool should be in 'odd' context
    for (let i = 1; i < 50; i += 2) {
      expect(oddTools.find((t) => t.name === `tool-${i}`)).toBeDefined();
    }

    // Contexts should list both
    const contexts = registry.listContexts();
    expect(contexts).toHaveLength(2);
    expect(contexts).toContain('even');
    expect(contexts).toContain('odd');
  });
});
