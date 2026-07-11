import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../migrator';
import { resolve } from 'path';

describe('migration 0097 — captured_traffic timing columns', () => {
  it('adds duration_ms + timings columns to captured_traffic', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [resolve('./migrations')]);

    const cols = (db.prepare("PRAGMA table_info('captured_traffic')").all() as Array<{ name: string; type: string }>);
    const byName = new Map(cols.map((c) => [c.name, c.type.toUpperCase()]));
    expect(byName.has('duration_ms')).toBe(true);
    expect(byName.has('timings')).toBe(true);
    expect(byName.get('duration_ms')).toContain('INT');
    expect(byName.get('timings')).toContain('TEXT');
  });

  it('round-trips a durationMs + timings JSON on an inserted row', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [resolve('./migrations')]);

    const timings = JSON.stringify({ dns: null, connect: 50, tls: 100, ttfb: 300, download: 100 });
    db.prepare(
      `INSERT INTO captured_traffic (request_method, request_url, response_status, duration_ms, timings, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('GET', 'https://api.example.com/data', 200, 600, timings, Math.floor(Date.now() / 1000));

    const row = db.prepare('SELECT duration_ms, timings FROM captured_traffic').get() as { duration_ms: number; timings: string };
    expect(row.duration_ms).toBe(600);
    expect(JSON.parse(row.timings)).toEqual({ dns: null, connect: 50, tls: 100, ttfb: 300, download: 100 });
  });

  it('leaves duration_ms + timings NULL when not supplied (existing-row default)', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [resolve('./migrations')]);

    db.prepare(
      `INSERT INTO captured_traffic (request_method, request_url, response_status, captured_at)
       VALUES (?, ?, ?, ?)`,
    ).run('GET', 'https://api.example.com/no-timing', 200, Math.floor(Date.now() / 1000));

    const row = db.prepare('SELECT duration_ms, timings FROM captured_traffic').get() as { duration_ms: number | null; timings: string | null };
    expect(row.duration_ms).toBeNull();
    expect(row.timings).toBeNull();
  });
});
