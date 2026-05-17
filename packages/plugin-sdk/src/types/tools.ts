/** Unified tool — registered once, available to AI, MCP, REST, SKILL.md, automation */
export interface PluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  contexts: string[];
  execute: (params: any) => Promise<unknown>;
}

export interface PluginToolContext {
  id: string;
  label: string;
  tools: string[];
  urlPattern?: string;       // Route pattern, e.g. '/my-plugin/:id/detail/:detailId'
  contextIdParam?: string;   // Which URL param is the contextId, e.g. 'diffId'
}
