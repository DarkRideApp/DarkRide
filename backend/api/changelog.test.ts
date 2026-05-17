import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerChangelogEndpoints } from './changelog';

const mockChangelog = {
  total: 3,
  commits: [
    { hash: 'aaa111', shortHash: 'aaa', title: 'feat: first', body: '', author: 'Dev', date: '2026-01-01T00:00:00Z' },
    { hash: 'bbb222', shortHash: 'bbb', title: 'fix: second', body: 'details', author: 'Dev', date: '2026-01-02T00:00:00Z' },
    { hash: 'ccc333', shortHash: 'ccc', title: 'chore: third', body: '', author: 'Dev', date: '2026-01-03T00:00:00Z' },
  ],
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({
      total: 3,
      commits: [
        { hash: 'aaa111', shortHash: 'aaa', title: 'feat: first', body: '', author: 'Dev', date: '2026-01-01T00:00:00Z' },
        { hash: 'bbb222', shortHash: 'bbb', title: 'fix: second', body: 'details', author: 'Dev', date: '2026-01-02T00:00:00Z' },
        { hash: 'ccc333', shortHash: 'ccc', title: 'chore: third', body: '', author: 'Dev', date: '2026-01-03T00:00:00Z' },
      ],
    })),
  };
});

describe('Changelog API (file-based)', () => {
  let app: express.Express;

  beforeAll(() => {
    clearEndpoints();
    registerChangelogEndpoints();
    app = express();
    app.use(express.json());
    app.use(getApiRouter());
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns paginated commits from file', async () => {
    const res = await request(app).get('/v1/changelog?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.limit).toBe(2);
    expect(res.body.data.offset).toBe(0);
    expect(res.body.data.items[0].hash).toBe('aaa111');
  });

  it('respects offset', async () => {
    const res = await request(app).get('/v1/changelog?limit=10&offset=2');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].hash).toBe('ccc333');
  });

  it('returns empty items for offset beyond range', async () => {
    const res = await request(app).get('/v1/changelog?limit=10&offset=100');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
  });

  it('treats limit=0 as default 100', async () => {
    const res = await request(app).get('/v1/changelog?limit=0');
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(100);
  });

  it('clamps negative limit to 1', async () => {
    const res = await request(app).get('/v1/changelog?limit=-5');
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(1);
  });

  it('clamps negative offset to 0', async () => {
    const res = await request(app).get('/v1/changelog?offset=-5');
    expect(res.status).toBe(200);
    expect(res.body.data.offset).toBe(0);
  });

  it('defaults to limit=100 offset=0', async () => {
    const res = await request(app).get('/v1/changelog');
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(100);
    expect(res.body.data.offset).toBe(0);
    expect(res.body.data.items).toHaveLength(3);
  });
});
