import { registerEndpoint } from './api-service';
import type { AppDatabase } from '../db/index';
import {
  listEndpoints,
  getEndpoint,
  deleteEndpoint,
  clearEndpoints as clearAllEndpoints,
  assignGroup,
  getEndpointSessionsRaw,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  assignHostnameToGroup,
  listHostnames,
  listGroupPatterns,
  addGroupPattern,
  removeGroupPattern,
  applyGroupPatterns,
  compilePattern,
  getEndpointResponseBodies,
  storeResponseSpec,
} from '../services/api-catalogue';
import { inferResponseSpec } from '../services/response-spec-inferrer';

export function registerApiCatalogueEndpoints(db: AppDatabase): void {
  // GET /v1/api-catalogue/endpoints — list with filters
  registerEndpoint('GET', '/v1/api-catalogue/endpoints', (req, res) => {
    const filters = {
      method: req.query.method as string | undefined,
      hostname: req.query.hostname as string | undefined,
      pathPattern: req.query.pathPattern as string | undefined,
      groupId: req.query.groupId === 'ungrouped' ? 'ungrouped' as const
        : req.query.groupId ? parseInt(req.query.groupId as string, 10) : undefined,
      sessionId: req.query.sessionId ? parseInt(req.query.sessionId as string, 10) : undefined,
      statusCode: req.query.statusCode ? parseInt(req.query.statusCode as string, 10) : undefined,
      from: req.query.from ? parseInt(req.query.from as string, 10) : undefined,
      to: req.query.to ? parseInt(req.query.to as string, 10) : undefined,
      bodySearch: req.query.bodySearch as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = listEndpoints(db, filters);
    res.json({ data: result });
  });

  // GET /v1/api-catalogue/endpoints/:id — detail
  registerEndpoint('GET', '/v1/api-catalogue/endpoints/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid endpoint id' });
      return;
    }
    const endpoint = getEndpoint(db, id);
    if (!endpoint) {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
      return;
    }
    res.json({ success: true, data: endpoint });
  });

  // DELETE /v1/api-catalogue/endpoints/:id — delete one
  registerEndpoint('DELETE', '/v1/api-catalogue/endpoints/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid endpoint id' });
      return;
    }
    if (deleteEndpoint(db, id)) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
    }
  });

  // DELETE /v1/api-catalogue/endpoints — clear all
  registerEndpoint('DELETE', '/v1/api-catalogue/endpoints', (_req, res) => {
    clearAllEndpoints(db);
    res.json({ success: true });
  });

  // PATCH /v1/api-catalogue/endpoints/:id — assign/unassign group
  registerEndpoint('PATCH', '/v1/api-catalogue/endpoints/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid endpoint id' });
      return;
    }
    const { groupId } = req.body;
    if (assignGroup(db, id, groupId ?? null)) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
    }
  });

  // GET /v1/api-catalogue/endpoints/:id/sessions — sessions for endpoint
  registerEndpoint('GET', '/v1/api-catalogue/endpoints/:id/sessions', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid endpoint id' });
      return;
    }
    const sessions = getEndpointSessionsRaw(db, id);
    res.json({ success: true, data: sessions });
  });

  // POST /v1/api-catalogue/endpoints/:id/infer-spec — infer response schema from captured traffic
  registerEndpoint('POST', '/v1/api-catalogue/endpoints/:id/infer-spec', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid endpoint id' });
      return;
    }
    const endpoint = getEndpoint(db, id);
    if (!endpoint) {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
      return;
    }
    const bodies = getEndpointResponseBodies(db, id);
    const spec = inferResponseSpec(bodies);
    storeResponseSpec(db, id, spec);
    res.json({ success: true, data: { spec, responseCount: bodies.length } });
  });

  // GET /v1/api-catalogue/groups — list groups
  registerEndpoint('GET', '/v1/api-catalogue/groups', (_req, res) => {
    const groups = listGroups(db);
    res.json({ success: true, data: groups });
  });

  // POST /v1/api-catalogue/groups — create group
  registerEndpoint('POST', '/v1/api-catalogue/groups', (req, res) => {
    const { name, description, notes } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }
    try {
      const group = createGroup(db, name.trim(), description, notes);
      res.status(201).json({ success: true, data: group });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        res.status(409).json({ success: false, error: 'Group name already exists' });
      } else {
        throw err;
      }
    }
  });

  // PUT /v1/api-catalogue/groups/:id — update group
  registerEndpoint('PUT', '/v1/api-catalogue/groups/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }
    const { name, description, notes } = req.body;
    try {
      if (updateGroup(db, id, { name, description, notes })) {
        res.json({ success: true });
      } else {
        res.status(404).json({ success: false, error: 'Group not found' });
      }
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        res.status(409).json({ success: false, error: 'Group name already exists' });
      } else {
        throw err;
      }
    }
  });

  // DELETE /v1/api-catalogue/groups/:id — delete group
  registerEndpoint('DELETE', '/v1/api-catalogue/groups/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }
    if (deleteGroup(db, id)) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Group not found' });
    }
  });

  // POST /v1/api-catalogue/groups/:id/assign-hostname — bulk assign hostname
  registerEndpoint('POST', '/v1/api-catalogue/groups/:id/assign-hostname', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }
    const { hostname } = req.body;
    if (!hostname || typeof hostname !== 'string') {
      res.status(400).json({ success: false, error: 'hostname is required' });
      return;
    }
    const count = assignHostnameToGroup(db, hostname, id);
    res.json({ success: true, count });
  });

  // GET /v1/api-catalogue/groups/:id/patterns — list patterns
  registerEndpoint('GET', '/v1/api-catalogue/groups/:id/patterns', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }
    const patterns = listGroupPatterns(db, id);
    res.json({ success: true, data: patterns });
  });

  // POST /v1/api-catalogue/groups/:id/patterns — add pattern
  registerEndpoint('POST', '/v1/api-catalogue/groups/:id/patterns', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }
    const { pattern, patternType = 'exact' } = req.body;
    if (!pattern || typeof pattern !== 'string') {
      res.status(400).json({ success: false, error: 'pattern is required' });
      return;
    }
    if (!['exact', 'wildcard', 'regex'].includes(patternType)) {
      res.status(400).json({ success: false, error: 'patternType must be exact, wildcard, or regex' });
      return;
    }
    // Validate regex
    if (patternType === 'regex') {
      try {
        new RegExp(pattern);
      } catch {
        res.status(400).json({ success: false, error: 'Invalid regex pattern' });
        return;
      }
    }
    try {
      const result = addGroupPattern(db, id, pattern.trim(), patternType);
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        res.status(409).json({ success: false, error: 'Pattern already exists for this group' });
      } else {
        throw err;
      }
    }
  });

  // DELETE /v1/api-catalogue/groups/:id/patterns/:patternId — remove pattern
  registerEndpoint('DELETE', '/v1/api-catalogue/groups/:id/patterns/:patternId', (req, res) => {
    const patternId = parseInt(req.params.patternId, 10);
    if (isNaN(patternId)) {
      res.status(400).json({ success: false, error: 'Invalid pattern id' });
      return;
    }
    if (removeGroupPattern(db, patternId)) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Pattern not found' });
    }
  });

  // POST /v1/api-catalogue/groups/:id/apply-patterns — bulk apply patterns
  registerEndpoint('POST', '/v1/api-catalogue/groups/:id/apply-patterns', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id' });
      return;
    }
    const count = applyGroupPatterns(db, id);
    res.json({ success: true, count });
  });

  // GET /v1/api-catalogue/hostnames — distinct hostnames
  registerEndpoint('GET', '/v1/api-catalogue/hostnames', (_req, res) => {
    const hostnames = listHostnames(db);
    res.json({ success: true, data: hostnames });
  });
}
