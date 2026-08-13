import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { createTestDb } from '../../test-utils/create-test-db';
import { registerAppEndpoints } from '../apps';
import { getApiRouter, clearEndpoints } from '../api-service';

const { trackedApps } = schema;

/**
 * `autoAnalyse` on POST /v1/apps/track.
 *
 * Migration 0098 split "watch this app's version" from "download and decompile
 * every release" so that tracking costs nothing. The Add App modal now offers
 * the choice at add time, which is only useful if the endpoint persists it —
 * and only SAFE if the default stays off. An endpoint that quietly enabled
 * analysis for every newly added app would undo 0098 through the front door.
 */
describe('POST /v1/apps/track — autoAnalyse', () => {
  let db: AppDatabase;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    clearEndpoints();
    registerAppEndpoints({} as any, db, undefined, undefined, undefined);
    app = express();
    app.use(express.json());
    app.use(getApiRouter());
  });

  const row = (packageName: string) =>
    db.select().from(trackedApps).where(eq(trackedApps.packageName, packageName)).all()[0];

  it('defaults to OFF when the field is absent', async () => {
    const res = await request(app).post('/v1/apps/track').send({ packageName: 'com.example.one' });
    expect(res.status).toBe(201);
    expect(row('com.example.one').autoAnalyse).toBe(false);
  });

  it('stores it when explicitly enabled', async () => {
    const res = await request(app).post('/v1/apps/track')
      .send({ packageName: 'com.example.two', autoAnalyse: true });
    expect(res.status).toBe(201);
    expect(row('com.example.two').autoAnalyse).toBe(true);
  });

  it('only an explicit boolean true enables it', async () => {
    // A truthy string from a hand-written client must not silently opt an app
    // into pulling every APK.
    await request(app).post('/v1/apps/track').send({ packageName: 'com.example.three', autoAnalyse: 'yes' });
    expect(row('com.example.three').autoAnalyse).toBe(false);
  });

  it('updates an already-tracked app when the field is present', async () => {
    // Re-adding through the modal is how stores get changed; the toggle shown
    // there has to mean something on the second pass too.
    await request(app).post('/v1/apps/track').send({ packageName: 'com.example.four' });
    expect(row('com.example.four').autoAnalyse).toBe(false);

    await request(app).post('/v1/apps/track').send({ packageName: 'com.example.four', autoAnalyse: true });
    expect(row('com.example.four').autoAnalyse).toBe(true);
  });

  it('leaves an existing app alone when the field is absent', async () => {
    // Absent means "no opinion", not "turn it off" — otherwise any client that
    // does not know about the field would silently disable analysis on re-add.
    await request(app).post('/v1/apps/track').send({ packageName: 'com.example.five', autoAnalyse: true });
    await request(app).post('/v1/apps/track').send({ packageName: 'com.example.five' });
    expect(row('com.example.five').autoAnalyse).toBe(true);
  });
});
