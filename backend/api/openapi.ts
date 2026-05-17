import { getRegisteredEndpoints } from './api-service';

/**
 * Auto-generate an OpenAPI 3.1 spec from the registered endpoints.
 *
 * Path parameters are extracted from Express `:param` patterns.
 * Endpoints are tagged by their URL prefix group (/v1/{group}/...).
 * Response schemas use the standard { success, data?, error? } envelope.
 */
export function generateOpenApiSpec(baseUrl: string): object {
  const endpoints = getRegisteredEndpoints();

  // Collect unique tags from URL prefixes
  const tagSet = new Set<string>();
  for (const ep of endpoints) {
    const match = ep.path.match(/^\/v1\/([^/]+)/);
    if (match) tagSet.add(match[1]);
  }

  const tags = [...tagSet].sort().map(t => ({
    name: t,
    description: `${t.charAt(0).toUpperCase() + t.slice(1).replace(/-/g, ' ')} endpoints`,
  }));

  // Build paths
  const paths: Record<string, Record<string, object>> = {};

  for (const ep of endpoints) {
    // Convert Express :param to OpenAPI {param}
    const openApiPath = ep.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');

    // Extract path parameters
    const paramMatches = [...ep.path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)];
    const parameters = paramMatches.map(m => ({
      name: m[1],
      in: 'path' as const,
      required: true,
      schema: { type: 'string' },
    }));

    // Determine tag
    const tagMatch = ep.path.match(/^\/v1\/([^/]+)/);
    const tag = tagMatch ? tagMatch[1] : 'other';

    // Build operation
    const operation: Record<string, any> = {
      tags: [tag],
      operationId: buildOperationId(ep.method, ep.path),
      responses: {
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApiSuccessResponse' },
            },
          },
        },
        '400': {
          description: 'Bad request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApiErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApiErrorResponse' },
            },
          },
        },
      },
    };

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Add request body for methods that typically have one
    if (['POST', 'PUT', 'PATCH'].includes(ep.method)) {
      operation.requestBody = {
        content: {
          'application/json': {
            schema: { type: 'object' },
          },
        },
      };
    }

    if (!paths[openApiPath]) paths[openApiPath] = {};
    paths[openApiPath][ep.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'DarkRide API',
      description: 'Phone automation and traffic analysis platform. Auto-generated from the endpoint registry.',
      version: '1.0.0',
    },
    servers: [{ url: baseUrl }],
    tags,
    paths,
    components: {
      schemas: {
        ApiSuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [true] },
            data: { description: 'Response payload (shape varies by endpoint)' },
          },
          required: ['success'],
        },
        ApiErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: { type: 'string' },
          },
          required: ['success', 'error'],
        },
        PaginatedResponse: {
          type: 'object',
          properties: {
            items: { type: 'array', items: {} },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
          required: ['items', 'total', 'limit', 'offset'],
        },
      },
    },
  };
}

/** Build a camelCase operationId from method + path, e.g. GET /v1/apps/:id → getAppsById */
function buildOperationId(method: string, path: string): string {
  const verb = method.toLowerCase();
  const segments = path
    .replace(/^\/v1\//, '')
    .split('/')
    .map(s => {
      if (s.startsWith(':')) return 'By' + capitalize(s.slice(1));
      return capitalize(s.replace(/-/g, '_')).replace(/_/g, '');
    });
  return verb + segments.join('');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
