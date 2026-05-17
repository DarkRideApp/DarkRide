import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { SystemStateService } from '../../services/system-state-service';
import { clearEndpoints, getApiRouter } from '../api-service';
import { registerSystemEndpoints } from '../system';

function makeApp() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE system_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const db = drizzle(sqlite, { schema });
  const broadcast = vi.fn();
  const service = new SystemStateService(db, broadcast);
  clearEndpoints();
  registerSystemEndpoints(service);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return { app, service };
}

describe('GET /v1/system/status', () => {
  it('returns restartRequired: null when state is unset', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/v1/system/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, restartRequired: null });
  });

  it('returns restartRequired with reason and since when state is set', async () => {
    const { app, service } = makeApp();
    service.setRestartRequired('plugin foo installed');
    const res = await request(app).get('/v1/system/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.restartRequired.reason).toBe('plugin foo installed');
    expect(typeof res.body.restartRequired.since).toBe('number');
  });
});
