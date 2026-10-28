import { registerEndpoint } from './api-service';
import type { AiToolRegistry } from '../services/ai-tools';

export function registerToolApiEndpoints(registry: AiToolRegistry): void {
  // List the tools the caller may run (name, description, contexts only, no execute)
  registerEndpoint('GET', '/v1/tools', (req, res) => {
    if (!req.authUser) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    res.json({ success: true, data: registry.listTools(req.authUser.effectiveScopes) });
  });

  // Execute a tool by name
  registerEndpoint('POST', '/v1/tools/:name', async (req, res) => {
    const { name } = req.params;
    if (!req.authUser) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    try {
      const result = await registry.executeTool(name, req.body, req.authUser.effectiveScopes);
      res.json({ success: true, data: result });
    } catch (err: any) {
      if (err.message?.startsWith('Unknown tool:')) {
        res.status(404).json({ success: false, error: err.message });
      } else if (err.message?.startsWith('Insufficient scope:')) {
        res.status(403).json({ success: false, error: err.message });
      } else {
        res.status(500).json({ success: false, error: err.message });
      }
    }
  });
}
