import type { PythonBridgeManager } from './python-bridge';
import { createLoggers } from '../logs';

const { log, error: logError } = createLoggers('frida-bridge');

/**
 * Make a JSON-RPC call to the per-device Python bridge that fronts Frida.
 *
 * Extracted from api/frida.ts so MCP/AI tools can invoke Frida operations
 * directly instead of looping back through the host's own HTTP routes. The
 * loopback pattern (`fetch('http://localhost:PORT/v1/frida/...')`) carried
 * no session cookie or API key and the host's auth middleware rejected it
 * as unauthenticated, even though the original MCP caller WAS authenticated.
 *
 * The bridge port (`bridge.port`) is the Python sidecar, NOT the host's own
 * port, so this fetch is a legitimate process-to-process RPC — not a
 * loopback into the host's Express stack.
 */
export async function callFridaBridge(
  bridgeManager: PythonBridgeManager,
  deviceId: string,
  method: string,
  params: Record<string, any> = {},
): Promise<any> {
  log(`${method} on ${deviceId}`);
  const bridge = await bridgeManager.getBridge(deviceId);
  const response = await fetch(`http://localhost:${bridge.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now().toString() }),
  });
  const result = (await response.json()) as any;
  if (result.error) {
    logError(`${method} failed on ${deviceId}: ${result.error.message}`);
    throw new Error(result.error.message);
  }
  return result.result;
}
