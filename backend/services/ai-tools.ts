import type { AiToolDefinition } from '../../shared/types/ai-chat';
import type { AiToolRegistry as IAiToolRegistry } from '@darkrideapp/plugin-sdk';
import { scopeMatches } from '../auth/scope-matcher';

/** Tool registration: schema + execute function */
export interface AiToolRegistration extends AiToolDefinition {
  execute: (params: any) => Promise<any>;
  /** Scope required to use this tool. If unset, the tool is unrestricted. */
  requiredScope?: string;
  /** When true, the agent must get user confirmation before executing this tool. */
  requiresConfirmation?: boolean;
  /**
   * Whether this tool is safe for automated/unattended runs (e.g. APK analysis,
   * diff summaries). Defaults to true. Set to false for tools that execute code
   * on devices — those should only be available in interactive user chat sessions.
   */
  allowUnattended?: boolean;
}

/**
 * Registry for AI tools, keyed by name with context-based lookup.
 *
 * Every call to `getToolDefinitions` / `getToolDefinitionsForContexts`
 * automatically appends the `request_tools` meta-tool so the LLM can
 * discover additional contexts at runtime.
 */
export class AiToolRegistry implements IAiToolRegistry {
  private tools = new Map<string, AiToolRegistration>();

  /** Register a tool (overwrites if name already exists). */
  register(tool: AiToolRegistration): void {
    this.tools.set(tool.name, tool);
  }

  /** Return full registrations whose context array includes `context`. */
  getToolsForContext(context: string): AiToolRegistration[] {
    const result: AiToolRegistration[] = [];
    for (const tool of this.tools.values()) {
      if (tool.context.includes(context)) {
        result.push(tool);
      }
    }
    return result;
  }

  /**
   * Return schema-only definitions (no `execute`) for a single context,
   * plus the `request_tools` meta-tool.
   */
  getToolDefinitions(context: string): AiToolDefinition[] {
    const defs = this.getToolsForContext(context).map(stripExecute);
    defs.push(this.buildRequestToolsDef());
    return defs;
  }

  /**
   * Return deduplicated schema-only definitions for multiple contexts,
   * plus the `request_tools` meta-tool.
   */
  getToolDefinitionsForContexts(contexts: string[]): AiToolDefinition[] {
    const seen = new Set<string>();
    const defs: AiToolDefinition[] = [];

    for (const ctx of contexts) {
      for (const tool of this.getToolsForContext(ctx)) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          defs.push(stripExecute(tool));
        }
      }
    }

    defs.push(this.buildRequestToolsDef());
    return defs;
  }

  /** Check if a tool requires user confirmation. */
  requiresConfirmation(name: string): boolean {
    return this.tools.get(name)?.requiresConfirmation === true;
  }

  /**
   * Execute a registered tool by name.
   * When `userScopes` is provided, the tool's `requiredScope` is checked first.
   * When `unattended` is true, tools with `allowUnattended: false` are blocked.
   * Throws if the tool is unknown, blocked, or the user lacks the required scope.
   */
  async executeTool(name: string, params: any, userScopes?: Set<string>, unattended?: boolean): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    if (userScopes && tool.requiredScope && !scopeMatches(userScopes, tool.requiredScope)) {
      throw new Error(`Insufficient scope: ${tool.requiredScope} required for tool ${name}`);
    }
    if (unattended && tool.allowUnattended === false) {
      throw new Error(`Tool ${name} is not available in unattended mode`);
    }
    return tool.execute(params);
  }

  /** Return every unique context string across all registered tools. */
  listContexts(): string[] {
    const contexts = new Set<string>();
    for (const tool of this.tools.values()) {
      for (const ctx of tool.context) {
        contexts.add(ctx);
      }
    }
    return [...contexts];
  }

  /**
   * Return contexts that have at least one tool accessible given the filter options.
   */
  listAccessibleContexts(userScopes?: Set<string>, unattended?: boolean): string[] {
    const contexts = new Set<string>();
    for (const tool of this.tools.values()) {
      if (!this.toolPassesFilter(tool, userScopes, unattended)) continue;
      for (const ctx of tool.context) {
        contexts.add(ctx);
      }
    }
    return [...contexts];
  }

  /**
   * Return schema-only definitions for a single context, filtered by user scopes
   * and unattended mode. Plus the `request_tools` meta-tool.
   */
  getToolDefinitionsForUser(context: string, userScopes?: Set<string>, unattended?: boolean): AiToolDefinition[] {
    const tools = this.getToolsForContext(context);
    const filtered = tools.filter(t => this.toolPassesFilter(t, userScopes, unattended));
    const defs = filtered.map(stripExecute);
    defs.push(this.buildRequestToolsDef(userScopes, unattended));
    return defs;
  }

  /**
   * Return deduplicated schema-only definitions for multiple contexts,
   * filtered by user scopes and unattended mode, plus the `request_tools` meta-tool.
   */
  getToolDefinitionsForContextsForUser(contexts: string[], userScopes?: Set<string>, unattended?: boolean): AiToolDefinition[] {
    const seen = new Set<string>();
    const defs: AiToolDefinition[] = [];

    for (const ctx of contexts) {
      for (const tool of this.getToolsForContext(ctx)) {
        if (seen.has(tool.name)) continue;
        if (!this.toolPassesFilter(tool, userScopes, unattended)) continue;
        seen.add(tool.name);
        defs.push(stripExecute(tool));
      }
    }

    defs.push(this.buildRequestToolsDef(userScopes, unattended));
    return defs;
  }

  /** Check if a tool passes scope + unattended filters. */
  private toolPassesFilter(tool: AiToolRegistration, userScopes?: Set<string>, unattended?: boolean): boolean {
    if (userScopes && tool.requiredScope && !scopeMatches(userScopes, tool.requiredScope)) return false;
    if (unattended && tool.allowUnattended === false) return false;
    return true;
  }

  // ── private ──────────────────────────────────────────────────────

  private buildRequestToolsDef(userScopes?: Set<string>, unattended?: boolean): AiToolDefinition {
    const contexts = this.listAccessibleContexts(userScopes, unattended);
    return {
      name: 'request_tools',
      description:
        `Request tools from additional contexts. Available contexts: ${JSON.stringify(contexts)}`,
      inputSchema: {
        type: 'object',
        properties: {
          contexts: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['contexts'],
      },
      context: [],
    };
  }
}

/** Strip the `execute` property, returning a plain AiToolDefinition. */
function stripExecute(tool: AiToolRegistration): AiToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    context: tool.context,
  };
}
