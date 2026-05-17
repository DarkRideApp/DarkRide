import { registerEndpoint } from './api-service';
import type { ToolManager, ToolName } from '../services/tool-manager';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('tools-api');

const VALID_TOOL_NAMES: ToolName[] = ['jadx', 'apktool', 'mobsfscan'];

export function registerToolEndpoints(toolManager: ToolManager): void {
  // GET /v1/tools/status -- returns status of all analysis tools
  registerEndpoint('GET', '/v1/tools/status', async (_req, res) => {
    try {
      const status = await toolManager.getStatus();
      res.json({ success: true, data: status });
    } catch (err: any) {
      error(`Failed to get tool status: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /v1/tools/install/:toolName -- downloads/installs a specific tool
  registerEndpoint('POST', '/v1/tools/install/:toolName', async (req, res) => {
    const toolName = req.params.toolName as string;

    if (!VALID_TOOL_NAMES.includes(toolName as ToolName)) {
      res.status(400).json({
        success: false,
        error: `Invalid tool name: ${toolName}. Valid names: ${VALID_TOOL_NAMES.join(', ')}`,
      });
      return;
    }

    try {
      log(`Installing ${toolName}...`);
      await toolManager.downloadTool(toolName as ToolName);
      const status = await toolManager.getStatus();
      res.json({ success: true, data: status });
    } catch (err: any) {
      error(`Failed to install ${toolName}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /v1/tools/install-all -- downloads/installs all missing tools
  registerEndpoint('POST', '/v1/tools/install-all', async (_req, res) => {
    try {
      log('Installing all missing tools...');
      const paths = await toolManager.ensureTools();
      res.json({ success: true, data: paths });
    } catch (err: any) {
      error(`Failed to install tools: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
