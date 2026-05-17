import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from '../api-service';
import { registerToolApiEndpoints } from '../tool-api';
import { AiToolRegistry } from '../../services/ai-tools';

vi.mock('../../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function createApp(registry: AiToolRegistry): express.Express {
  clearEndpoints();
  registerToolApiEndpoints(registry);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function createRegistry(): AiToolRegistry {
  const registry = new AiToolRegistry();

  registry.register({
    name: 'get_weather',
    description: 'Get current weather for a city',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    context: ['general', 'travel'],
    execute: vi.fn().mockResolvedValue({ temp: 22, condition: 'sunny' }),
  });

  registry.register({
    name: 'search_flights',
    description: 'Search for flights',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    context: ['travel'],
    execute: vi.fn().mockResolvedValue({ flights: [] }),
  });

  registry.register({
    name: 'run_analysis',
    description: 'Run data analysis',
    inputSchema: {
      type: 'object',
      properties: { dataset: { type: 'string' } },
    },
    context: ['general'],
    execute: vi.fn().mockResolvedValue({ rows: 100 }),
  });

  return registry;
}

describe('Tool API Endpoints', () => {
  let registry: AiToolRegistry;
  let app: express.Express;

  beforeEach(() => {
    registry = createRegistry();
    app = createApp(registry);
  });

  describe('GET /v1/tools', () => {
    it('should list all registered tools', async () => {
      const res = await request(app).get('/v1/tools');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data).toHaveLength(3);

      const names = res.body.data.map((t: any) => t.name);
      expect(names).toContain('get_weather');
      expect(names).toContain('search_flights');
      expect(names).toContain('run_analysis');
    });

    it('should include name, description, and contexts for each tool', async () => {
      const res = await request(app).get('/v1/tools');

      const weatherTool = res.body.data.find((t: any) => t.name === 'get_weather');
      expect(weatherTool).toBeDefined();
      expect(weatherTool.description).toBe('Get current weather for a city');
      expect(weatherTool.contexts).toEqual(['general', 'travel']);
    });

    it('should deduplicate tools that appear in multiple contexts', async () => {
      // get_weather is in both 'general' and 'travel' contexts
      // The endpoint iterates contexts and deduplicates by name
      const res = await request(app).get('/v1/tools');

      const weatherOccurrences = res.body.data.filter((t: any) => t.name === 'get_weather');
      expect(weatherOccurrences).toHaveLength(1);
    });

    it('should return empty array when no tools are registered', async () => {
      const emptyRegistry = new AiToolRegistry();
      app = createApp(emptyRegistry);

      const res = await request(app).get('/v1/tools');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /v1/tools/:name', () => {
    it('should execute a known tool and return the result', async () => {
      const res = await request(app)
        .post('/v1/tools/get_weather')
        .send({ city: 'London' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ temp: 22, condition: 'sunny' });
    });

    it('should pass request body as params to the tool', async () => {
      const params = { from: 'NYC', to: 'LAX' };

      await request(app)
        .post('/v1/tools/search_flights')
        .send(params);

      const tool = registry.getToolsForContext('travel').find(t => t.name === 'search_flights');
      expect(tool?.execute).toHaveBeenCalledWith(params);
    });

    it('should return 404 for unknown tool', async () => {
      const res = await request(app)
        .post('/v1/tools/nonexistent_tool')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Unknown tool: nonexistent_tool');
    });

    it('should return 500 when tool execution fails', async () => {
      // Override the execute mock to throw
      const failingRegistry = new AiToolRegistry();
      failingRegistry.register({
        name: 'failing_tool',
        description: 'A tool that always fails',
        inputSchema: { type: 'object', properties: {} },
        context: ['test'],
        execute: vi.fn().mockRejectedValue(new Error('Database connection lost')),
      });
      app = createApp(failingRegistry);

      const res = await request(app)
        .post('/v1/tools/failing_tool')
        .send({});

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Database connection lost');
    });

    it('should pass empty object as params when no body is sent', async () => {
      await request(app)
        .post('/v1/tools/run_analysis')
        .send();

      const tool = registry.getToolsForContext('general').find(t => t.name === 'run_analysis');
      // Express parses missing body as empty object when using express.json()
      expect(tool?.execute).toHaveBeenCalledWith({});
    });

    it('should handle tool that returns null', async () => {
      const registryWithNull = new AiToolRegistry();
      registryWithNull.register({
        name: 'null_tool',
        description: 'Returns null',
        inputSchema: { type: 'object', properties: {} },
        context: ['test'],
        execute: vi.fn().mockResolvedValue(null),
      });
      app = createApp(registryWithNull);

      const res = await request(app)
        .post('/v1/tools/null_tool')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeNull();
    });

    it('should handle tool that returns a string', async () => {
      const registryWithString = new AiToolRegistry();
      registryWithString.register({
        name: 'string_tool',
        description: 'Returns a string',
        inputSchema: { type: 'object', properties: {} },
        context: ['test'],
        execute: vi.fn().mockResolvedValue('hello world'),
      });
      app = createApp(registryWithString);

      const res = await request(app)
        .post('/v1/tools/string_tool')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBe('hello world');
    });

    it('should handle tool execution error without message property', async () => {
      const failingRegistry = new AiToolRegistry();
      failingRegistry.register({
        name: 'bad_error_tool',
        description: 'Throws a weird error',
        inputSchema: { type: 'object', properties: {} },
        context: ['test'],
        execute: vi.fn().mockRejectedValue(new Error('')),
      });
      app = createApp(failingRegistry);

      const res = await request(app)
        .post('/v1/tools/bad_error_tool')
        .send({});

      // The api-service catch wrapper handles empty message
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });
});
