import type { Request, Response } from 'express';
import { registerEndpoint } from './api-service';
import type { ToolManager, ToolName } from '../services/tool-manager';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('tools-api');

const VALID_TOOL_NAMES: ToolName[] = ['jadx', 'apktool', 'mobsfscan'];

// Installs run on first APK analysis anyway, so they need the same scope as triggering one.
const READ_SCOPE = { requires: ['core.apk:read'] };
const INSTALL_SCOPE = { requires: ['core.apk:manage'] };

/** The scope check skips requests with no identity, so answer 401 here rather than run the handler. */
function signedIn(req: Request, res: Response): boolean {
  if (req.authUser) return true;
  res.status(401).json({ success: false, error: 'Authentication required' });
  return false;
}

export function registerToolEndpoints(toolManager: ToolManager): void {
  // GET /v1/tools/status -- returns status of all analysis tools
  registerEndpoint('GET', '/v1/tools/status', async (req, res) => {
    if (!signedIn(req, res)) return;
    try {
      const status = await toolManager.getStatus();
      res.json({ success: true, data: status });
    } catch (err: any) {
      error(`Failed to get tool status: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, READ_SCOPE);

  // POST /v1/tools/install/:toolName -- downloads/installs a specific tool
  registerEndpoint('POST', '/v1/tools/install/:toolName', async (req, res) => {
    if (!signedIn(req, res)) return;
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
  }, INSTALL_SCOPE);

  // POST /v1/tools/install-all -- downloads/installs all missing tools
  registerEndpoint('POST', '/v1/tools/install-all', async (req, res) => {
    if (!signedIn(req, res)) return;
    try {
      log('Installing all missing tools...');
      const paths = await toolManager.ensureTools();
      res.json({ success: true, data: paths });
    } catch (err: any) {
      error(`Failed to install tools: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, INSTALL_SCOPE);
}
