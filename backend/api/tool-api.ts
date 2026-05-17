import { registerEndpoint } from './api-service';
import type { AiToolRegistry } from '../services/ai-tools';

export function registerToolApiEndpoints(registry: AiToolRegistry): void {
  // List all tools (name, description, contexts only — no execute)
  registerEndpoint('GET', '/v1/tools', (_req, res) => {
    const contexts = registry.listContexts();
    const tools: Array<{ name: string; description: string; contexts: string[] }> = [];
    const seen = new Set<string>();

    for (const ctx of contexts) {
      for (const tool of registry.getToolsForContext(ctx)) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          tools.push({
            name: tool.name,
            description: tool.description,
            contexts: tool.context,
          });
        }
      }
    }
    res.json({ success: true, data: tools });
  });

  // Execute a tool by name
  registerEndpoint('POST', '/v1/tools/:name', async (req, res) => {
    const { name } = req.params;
    try {
      const result = await registry.executeTool(name, req.body);
      res.json({ success: true, data: result });
    } catch (err: any) {
      if (err.message?.startsWith('Unknown tool:')) {
        res.status(404).json({ success: false, error: err.message });
      } else {
        res.status(500).json({ success: false, error: err.message });
      }
    }
  });
}
