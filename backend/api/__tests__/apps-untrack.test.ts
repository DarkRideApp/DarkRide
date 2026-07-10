import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { createTestDb } from '../../test-utils/create-test-db';
import { registerAppEndpoints } from '../apps';
import { getApiRouter, clearEndpoints } from '../api-service';

const { trackedApps, apkVersions, analysisJobs, apkContents, apkDiffReports, apkNotes, injectedApks } = schema;

// registerAppEndpoints only touches deviceManager on device routes, not on the
// untrack path — a bare stub is enough.
const stubDeviceManager = {} as any;

function makeApp(db: AppDatabase) {
  clearEndpoints();
  registerAppEndpoints(stubDeviceManager, db);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('DELETE /v1/apps/track/:id (untrack)', () => {
  let db: AppDatabase;
  let app: express.Express;

  beforeEach(() => {
    // foreignKeys ON so the delete-order bug reproduces exactly as in prod.
    db = createTestDb(undefined, { foreignKeys: true });
    app = makeApp(db);
  });

  it('untracks an app that has analysed + diffed + injected + noted versions without an FK error', async () => {
    // A fully-exercised app: two versions, an analysis job, stored contents, a
    // diff report between the two versions, user notes, and a Frida-injected
    // build. The state a real app reaches after "add APK → analyse → diff → inject".
    db.insert(trackedApps).values({ id: 1, packageName: 'com.example.app', appName: 'Example', createdAt: new Date() }).run();
    db.insert(apkVersions).values({ id: 10, trackedAppId: 1, versionCode: 100, filename: 'v100.apk', downloadedAt: new Date() }).run();
    db.insert(apkVersions).values({ id: 11, trackedAppId: 1, versionCode: 101, filename: 'v101.apk', downloadedAt: new Date() }).run();
    db.insert(analysisJobs).values({ apkVersionId: 11, status: 'completed', createdAt: new Date() }).run();
    db.insert(apkContents).values({ apkVersionId: 11, apkName: 'base.apk', entriesJson: '[]', createdAt: new Date() }).run();
    db.insert(apkDiffReports).values({ apkVersionId: 11, compareVersionId: 10, status: 'completed', createdAt: new Date() }).run();
    db.insert(apkNotes).values({ versionId: 11, content: 'notes', updatedAt: new Date() }).run();
    db.insert(injectedApks).values({ id: 7, trackedAppId: 1, packageName: 'com.example.app', versionCode: 101, fridaVersion: '17.0.0', filename: 'inj.apk', createdAt: new Date() }).run();

    const res = await request(app).delete('/v1/apps/track/1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // The tracked app and its versions are gone.
    expect(db.select().from(trackedApps).where(eq(trackedApps.id, 1)).all()).toHaveLength(0);
    expect(db.select().from(apkVersions).where(eq(apkVersions.trackedAppId, 1)).all()).toHaveLength(0);
    // Grandchild rows keyed on the deleted versions are gone too (no orphans).
    expect(db.select().from(analysisJobs).all()).toHaveLength(0);
    expect(db.select().from(apkContents).all()).toHaveLength(0);
    expect(db.select().from(apkDiffReports).all()).toHaveLength(0);
    // The injected build survives with its tracked-app link nulled (artifact preserved).
    const injected = db.select().from(injectedApks).all();
    expect(injected).toHaveLength(1);
    expect(injected[0].trackedAppId).toBeNull();
  });

  it('untracks a freshly-pulled app whose only version has a pending analysis job', async () => {
    // Minimal real repro: pulling an APK auto-enqueues analysis, creating an
    // analysis_jobs row that FK-references the version. That alone broke untrack.
    db.insert(trackedApps).values({ id: 2, packageName: 'com.example.fresh', createdAt: new Date() }).run();
    db.insert(apkVersions).values({ id: 20, trackedAppId: 2, versionCode: 5, filename: 'v5.apk', downloadedAt: new Date() }).run();
    db.insert(analysisJobs).values({ apkVersionId: 20, status: 'pending', createdAt: new Date() }).run();

    const res = await request(app).delete('/v1/apps/track/2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.select().from(trackedApps).where(eq(trackedApps.id, 2)).all()).toHaveLength(0);
    expect(db.select().from(analysisJobs).all()).toHaveLength(0);
  });

  it('untracks an app that has no versions yet (added but never pulled)', async () => {
    db.insert(trackedApps).values({ id: 3, packageName: 'com.example.empty', createdAt: new Date() }).run();

    const res = await request(app).delete('/v1/apps/track/3');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.select().from(trackedApps).where(eq(trackedApps.id, 3)).all()).toHaveLength(0);
  });

  it('nulls the maps plugin table apk_version_id when it exists', async () => {
    // map_versions is a plugin-owned table (not in core schema) that FK-references
    // apk_versions. Create it so the raw-SQL IN-clause null-out actually executes
    // against a real table rather than only hitting the try/catch "table may not
    // exist" branch — this is what exercises sql.join for the version-id list.
    db.run(sql`CREATE TABLE map_versions (id INTEGER PRIMARY KEY, apk_version_id INTEGER REFERENCES apk_versions(id))`);

    db.insert(trackedApps).values({ id: 4, packageName: 'com.example.maps', createdAt: new Date() }).run();
    db.insert(apkVersions).values({ id: 40, trackedAppId: 4, versionCode: 1, filename: 'v1.apk', downloadedAt: new Date() }).run();
    db.insert(apkVersions).values({ id: 41, trackedAppId: 4, versionCode: 2, filename: 'v2.apk', downloadedAt: new Date() }).run();
    db.run(sql`INSERT INTO map_versions (id, apk_version_id) VALUES (1, 40), (2, 41)`);

    const res = await request(app).delete('/v1/apps/track/4');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // Map versions survive with apk_version_id nulled (not deleted).
    const rows = db.all<{ id: number; apk_version_id: number | null }>(sql`SELECT id, apk_version_id FROM map_versions ORDER BY id`);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.apk_version_id === null)).toBe(true);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).delete('/v1/apps/track/999');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
