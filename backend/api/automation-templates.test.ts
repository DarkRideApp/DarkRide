import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerAutomationTemplateEndpoints } from './automation-templates';
import { clearEndpoints, getApiRouter } from './api-service';
import { templates } from './automation-template-data';

describe('Automation Templates API', () => {
  let app: express.Express;

  beforeEach(() => {
    clearEndpoints();
    registerAutomationTemplateEndpoints();

    app = express();
    app.use(express.json());
    app.use(getApiRouter());
  });

  describe('GET /v1/automation/templates', () => {
    it('returns all templates without code', async () => {
      const res = await request(app).get('/v1/automation/templates');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(templates.length);
      // Verify code is not included in list response
      for (const t of res.body.data) {
        expect(t).not.toHaveProperty('code');
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('description');
        expect(t).toHaveProperty('category');
        expect(t).toHaveProperty('tags');
      }
    });

    it('includes all expected categories', async () => {
      const res = await request(app).get('/v1/automation/templates');
      const categories = new Set(res.body.data.map((t: any) => t.category));
      expect(categories).toContain('login');
      expect(categories).toContain('navigation');
      expect(categories).toContain('data-extraction');
      expect(categories).toContain('maintenance');
    });
  });

  describe('GET /v1/automation/template/:id', () => {
    it('returns a single template with code', async () => {
      const res = await request(app).get('/v1/automation/template/login-generic-form');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('login-generic-form');
      expect(res.body.data.name).toBe('Generic Login Form');
      expect(res.body.data.code).toBeDefined();
      expect(res.body.data.code).toContain('export default async function');
    });

    it('returns 404 for unknown template id', async () => {
      const res = await request(app).get('/v1/automation/template/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
