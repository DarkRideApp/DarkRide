import type { AiToolRegistry } from '../services/ai-tools';
import { getRegisteredEndpoints } from './api-service';

/**
 * Generate a comprehensive AI agent skill document describing
 * the DarkRide web service — its REST API and MCP tools.
 */
export function generateSkillDoc(registry: AiToolRegistry, baseUrl: string): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────
  lines.push('# DarkRide — AI Agent Skill');
  lines.push('');
  lines.push('DarkRide is a phone automation and traffic analysis platform for Android and iOS devices.');
  lines.push('This document describes how to interact with the service programmatically.');
  lines.push('');
  lines.push(`**Base URL:** \`${baseUrl}\``);
  lines.push('');

  // ── MCP Connection ────────────────────────────────────────────────
  lines.push('## MCP Connection');
  lines.push('');
  lines.push('DarkRide exposes tools via the Model Context Protocol (MCP) HTTP Streamable transport.');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    mcpServers: {
      darkride: {
        type: 'http',
        url: `${baseUrl}/mcp`,
      },
    },
  }, null, 2));
  lines.push('```');
  lines.push('');

  // ── MCP Tools ─────────────────────────────────────────────────────
  const contexts = registry.listContexts().sort();
  const allTools = registry.getToolDefinitionsForContexts(contexts)
    .filter(t => t.name !== 'request_tools');

  lines.push(`## MCP Tools (${allTools.length} tools across ${contexts.length} contexts)`);
  lines.push('');
  lines.push('Tools are grouped by page context. An agent can use `request_tools` to load tools for a specific context.');
  lines.push('');

  for (const ctx of contexts) {
    const tools = registry.getToolDefinitionsForContexts([ctx])
      .filter(t => t.name !== 'request_tools');
    if (tools.length === 0) continue;

    lines.push(`### Context: \`${ctx}\``);
    lines.push('');

    for (const tool of tools) {
      lines.push(`#### \`${tool.name}\``);
      lines.push('');
      lines.push(tool.description);
      lines.push('');

      // Parameters
      const schema = tool.inputSchema;
      const props = schema?.properties;
      const required = new Set<string>(schema?.required || []);

      if (props && Object.keys(props).length > 0) {
        lines.push('**Parameters:**');
        lines.push('');
        lines.push('| Name | Type | Required | Description |');
        lines.push('|------|------|----------|-------------|');
        for (const [name, prop] of Object.entries(props) as [string, any][]) {
          const type = prop.enum ? prop.enum.map((v: string) => `\`${v}\``).join(' \\| ') : (prop.type || 'any');
          const req = required.has(name) ? 'Yes' : 'No';
          const desc = (prop.description || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
          lines.push(`| \`${name}\` | ${type} | ${req} | ${desc} |`);
        }
        lines.push('');
      }
    }
  }

  // ── REST API ──────────────────────────────────────────────────────
  const endpoints = getRegisteredEndpoints();

  // Group by prefix
  const groups = new Map<string, typeof endpoints>();
  for (const ep of endpoints) {
    // Extract group from path: /v1/{group}/...
    const match = ep.path.match(/^\/v1\/([^/]+)/);
    const group = match ? match[1] : 'other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(ep);
  }

  lines.push(`## REST API (${endpoints.length} endpoints)`);
  lines.push('');
  lines.push('All endpoints return JSON with `{ success: boolean, data?: ..., error?: string }` format.');
  lines.push('');

  for (const [group, eps] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${group}`);
    lines.push('');
    lines.push('| Method | Path |');
    lines.push('|--------|------|');
    for (const ep of eps) {
      lines.push(`| \`${ep.method}\` | \`${ep.path}\` |`);
    }
    lines.push('');
  }

  // ── Capabilities Summary ──────────────────────────────────────────
  lines.push('## Capabilities Summary');
  lines.push('');
  lines.push('- **Device Management:** List, monitor, and control Android/iOS devices over USB');
  lines.push('- **Traffic Capture:** Intercept HTTP/HTTPS/WebSocket traffic via mitmproxy with WireGuard tunnels');
  lines.push('- **Automation:** Create and run JavaScript automation scripts on connected devices');
  lines.push('- **APK Analysis:** Decompile, search code/assets, find security issues, diff versions');
  lines.push('- **Notifications:** Multi-channel alerts (Discord, Slack, Telegram, Email, Webhook, ntfy, Gotify)');
  lines.push('- **AI Chat:** Built-in AI assistant with tool access to all platform data');
  lines.push('');

  return lines.join('\n');
}
