import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import type { Express, Request, Response } from 'express';
import type { AiToolRegistry } from './ai-tools';
import type { AppDatabase } from '../db/index';
import { settings } from '../db/schema';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('mcp');

interface AuthUser {
  userId: number;
  username: string;
  effectiveScopes: Set<string>;
  via: string;
}

/**
 * Produce a one-line description of an MCP JSON-RPC request body for logging.
 * Handles both single requests and batched arrays. For tools/call we include
 * the tool name + a brief preview of arguments (truncated to keep logs readable
 * and avoid leaking large payloads).
 */
export function describeMcpRequest(body: unknown): string {
  if (!body) return 'method=<missing>';
  const items = Array.isArray(body) ? body : [body];
  return items.map(describeOneRequest).join(', ');
}

function describeOneRequest(req: any): string {
  if (!req || typeof req !== 'object') return 'method=<malformed>';
  const method = req.method ?? '<no-method>';
  if (method === 'tools/call') {
    const name = req.params?.name ?? '<no-name>';
    const args = req.params?.arguments;
    const argPreview = args ? truncate(JSON.stringify(args), 200) : '';
    return `tools/call name=${name}${argPreview ? ` args=${argPreview}` : ''}`;
  }
  // For other methods (tools/list, resources/list, prompts/list, ping, etc.),
  // just log the method name. Params are usually trivial.
  return `method=${method}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Marker shape a tool returns when its result is an image rather than text.
 * The MCP result layer detects this and emits an `image` content block so the
 * client renders it as a picture instead of a giant base64 JSON string.
 */
export interface ImageToolResult {
  _mcpImage: true;
  /** Base64-encoded image bytes (no data: URI prefix). */
  data: string;
  /** MIME type of the image, e.g. `image/png`. */
  mimeType: string;
}

/** Narrow an arbitrary tool result to an ImageToolResult. */
export function isImageToolResult(x: unknown): x is ImageToolResult {
  return (
    !!x &&
    typeof x === 'object' &&
    (x as any)._mcpImage === true &&
    typeof (x as any).data === 'string' &&
    typeof (x as any).mimeType === 'string'
  );
}

/**
 * Convert a tool's raw return value into MCP `content` blocks.
 *
 * Image results (see ImageToolResult) become a single `image` block; every
 * other value is serialised to text — strings verbatim, objects as pretty JSON.
 */
export function toMcpToolContent(
  result: unknown,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (isImageToolResult(result)) {
    return [{ type: 'image', data: result.data, mimeType: result.mimeType }];
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return [{ type: 'text', text }];
}

/**
 * Mount an MCP HTTP Streamable server on the given Express app at `/mcp`.
 *
 * Uses stateless mode — each POST request gets its own transport + Server instance.
 * Compatible with Claude CLI 2.x which uses the MCP HTTP Streamable protocol.
 */
export function mountMcpSseServer(app: Express, registry: AiToolRegistry, db: AppDatabase): void {
  log(`MCP: ${registry.listContexts().length} contexts registered`);

  // Factory: each request gets its own Server instance (stateless mode)
  // Uses the authenticated user's scopes to filter tools
  function createMcpServer(userScopes?: Set<string>): Server {
    const server = new Server(
      { name: 'darkride', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    // Build scope-filtered tool list (exclude request_tools meta-tool)
    const allContexts = registry.listContexts();
    const toolDefs = registry.getToolDefinitionsForContextsForUser(allContexts, userScopes)
      .filter(t => t.name !== 'request_tools');

    // tools/list — return scope-filtered tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    // tools/call — execute with scope enforcement
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const result = await registry.executeTool(name, args ?? {}, userScopes);
        return { content: toMcpToolContent(result) };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  // POST /mcp — handle MCP HTTP Streamable requests (stateless, one transport per request)
  // Auth middleware has already run — extract scopes from the authenticated user
  app.post('/mcp', async (req: Request, res: Response) => {
    // Check if MCP is enabled
    const enabledSetting = db.select().from(settings).where(eq(settings.key, 'mcp_enabled')).get();
    if (enabledSetting?.value === 'false') {
      res.status(503).json({ error: 'MCP server is disabled' });
      return;
    }

    const authUser = (req as any).authUser as AuthUser | undefined;
    if (!authUser) {
      const proto = req.protocol;
      const host = req.get('host') ?? 'localhost';
      const resourceMetadataUrl = `${proto}://${host}/.well-known/oauth-protected-resource`;
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const userScopes = authUser?.effectiveScopes;

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transport.onerror = (err) => error(`MCP transport error: ${err.message}`);

    try {
      const server = createMcpServer(userScopes);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      log(`MCP request handled (user: ${authUser?.username ?? 'no-auth'}) ${describeMcpRequest(req.body)}`);
    } catch (err: any) {
      error(`MCP request error: ${err.message} (req: ${describeMcpRequest(req.body)})`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  log('MCP HTTP server mounted at /mcp');
}
