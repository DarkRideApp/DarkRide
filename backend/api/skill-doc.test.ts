import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AiToolRegistry } from '../services/ai-tools';
import { generateSkillDoc } from './skill-doc';
import { clearEndpoints, registerEndpoint } from './api-service';

describe('generateSkillDoc', () => {
  let registry: AiToolRegistry;

  beforeEach(() => {
    clearEndpoints();

    registry = new AiToolRegistry();

    // Register two fake tools across two contexts
    registry.register({
      name: 'list_devices',
      description: 'List all connected Android and iOS devices.',
      context: ['devices'],
      inputSchema: {
        type: 'object' as const,
        properties: {
          platform: {
            type: 'string',
            description: 'Filter by platform: android or ios',
          },
        },
        required: [],
      },
      execute: async () => [],
    });

    registry.register({
      name: 'run_automation',
      description: 'Trigger an automation by ID.',
      context: ['automations'],
      inputSchema: {
        type: 'object' as const,
        properties: {
          automationId: {
            type: 'number',
            description: 'The automation to run',
          },
        },
        required: ['automationId'],
      },
      execute: async () => ({}),
    });

    // Register a few REST endpoints
    registerEndpoint('GET', '/v1/devices/list', (_req, res) => res.json({ success: true, data: [] }));
    registerEndpoint('POST', '/v1/automations/create', (_req, res) => res.json({ success: true }));
  });

  afterEach(() => {
    clearEndpoints();
  });

  it('contains MCP connection config with the correct base URL', () => {
    const doc = generateSkillDoc(registry, 'http://192.168.1.50:3000');

    expect(doc).toContain('## MCP Connection');
    expect(doc).toContain('"url": "http://192.168.1.50:3000/mcp"');
    expect(doc).toContain('darkride');
  });

  it('lists tool names from the registry', () => {
    const doc = generateSkillDoc(registry, 'http://localhost:3000');

    expect(doc).toContain('list_devices');
    expect(doc).toContain('run_automation');
    expect(doc).toContain('List all connected Android and iOS devices.');
    expect(doc).toContain('Trigger an automation by ID.');
  });

  it('includes registered REST endpoint paths', () => {
    const doc = generateSkillDoc(registry, 'http://localhost:3000');

    expect(doc).toContain('/v1/devices/list');
    expect(doc).toContain('/v1/automations/create');
    expect(doc).toContain('## REST API');
  });

  it('contains the capabilities summary section', () => {
    const doc = generateSkillDoc(registry, 'http://localhost:3000');

    expect(doc).toContain('## Capabilities Summary');
    expect(doc).toContain('Device Management');
    expect(doc).toContain('Traffic Capture');
    expect(doc).toContain('Automation');
  });
});
