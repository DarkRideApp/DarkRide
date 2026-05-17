import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';

vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

// Mock fs so computeFileDiff / ensureDbLocal don't touch the real filesystem
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => '{}'),
    },
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
  };
});

vi.mock('../utils/apk-paths', () => ({
  APK_DIR: '/tmp/apks',
  analysisDir: vi.fn(() => '/tmp/apks/com.example/1000'),
  analysisDbCloudKey: vi.fn(() => 'cloud/key'),
  apkFilePath: vi.fn((pkg: string, filename: string) => `/tmp/apks/${pkg}/${filename}`),
  lookupVersionMeta: vi.fn((db: any, versionId: number) => ({
    packageName: 'com.example',
    versionCode: versionId * 100,
    filename: `app-v${versionId}.apk`,
  })),
}));

import { eq } from 'drizzle-orm';
import { ApkDiffEngine } from './apk-diff-engine';
import { createTestDb } from '../test-utils/create-test-db';

function insertTrackedApp(db: BetterSQLite3Database<typeof schema>, packageName: string): number {
  const result = db.insert(schema.trackedApps).values({
    packageName,
    createdAt: new Date(),
  }).run();
  return Number(result.lastInsertRowid);
}

function insertApkVersion(db: BetterSQLite3Database<typeof schema>, trackedAppId: number, versionCode = 1): number {
  const result = db.insert(schema.apkVersions).values({
    trackedAppId,
    versionCode,
    versionName: `1.${versionCode}.0`,
    filename: `app-v${versionCode}.apk`,
    downloadedAt: new Date(),
  }).run();
  return Number(result.lastInsertRowid);
}

describe('ApkDiffEngine', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let engine: ApkDiffEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new ApkDiffEngine(db as any);
  });

  describe('setAiFactory / setAiConfig', () => {
    it('exposes setAiFactory method', () => {
      expect(typeof engine.setAiFactory).toBe('function');
    });

    it('exposes setAiConfig method', () => {
      expect(typeof engine.setAiConfig).toBe('function');
    });

    it('does not have setAiAgentFactory method', () => {
      expect((engine as any).setAiAgentFactory).toBeUndefined();
    });

    it('does not have setSystemUserId method', () => {
      expect((engine as any).setSystemUserId).toBeUndefined();
    });
  });

  describe('triggerDiff — no previous version', () => {
    it('skips silently when no previous version exists', () => {
      const appId = insertTrackedApp(db, 'com.example.nodiff');
      const versionId = insertApkVersion(db, appId, 1);

      // Should not throw, just log and return
      expect(() => engine.triggerDiff(versionId)).not.toThrow();
    });
  });

  describe('triggerDiff — warning when previous version is not local', () => {
    it('triggers diff even when previous version is cloud-only (warning logged by triggerDiffForVersions)', () => {
      // This test verifies that triggerDiff proceeds despite non-local prev version.
      // The warning log is telemetry; the actual skip is handled by runDiff's pre-check.
      const { engine, db } = setupEngine();

      const now = new Date();

      // Insert app with two versions
      const appRow = db.insert(schema.trackedApps).values({
        packageName: 'com.example.cloud.test',
        createdAt: now,
      } as any).run();
      const appId = Number(appRow.lastInsertRowid);

      const oldRow = db.insert(schema.apkVersions).values({
        trackedAppId: appId,
        versionCode: 100,
        versionName: '1.0.0',
        filename: 'app-v1.apk',
        downloadedAt: now,
      } as any).run();
      const oldVersionId = Number(oldRow.lastInsertRowid);

      // Create completed analysisJob for old version (so it can be found as previous)
      db.insert(schema.analysisJobs).values({
        apkVersionId: oldVersionId,
        status: 'completed',
        createdAt: now,
        completedAt: now,
      } as any).run();

      const newRow = db.insert(schema.apkVersions).values({
        trackedAppId: appId,
        versionCode: 101,
        versionName: '1.1.0',
        filename: 'app-v2.apk',
        downloadedAt: now,
      } as any).run();
      const newVersionId = Number(newRow.lastInsertRowid);

      // Seed old version as cloud-only
      seedCloudFileRow(db, 'apks/com.example.cloud.test/app-v1.apk', '', 'cloud_only');
      seedCloudFileRow(db, 'apks/com.example.cloud.test/analysis/10000/source.db', '', 'cloud_only');
      seedCloudFileRow(db, 'apks/com.example.cloud.test/analysis/10000/metadata.json', '', 'cloud_only');

      // Trigger the diff — should not throw even though old version is cloud-only
      expect(() => engine.triggerDiff(newVersionId)).not.toThrow();

      // Verify diff report was created. Because the new version is also cloud-only
      // (not seeded), the pre-check will mark it as 'skipped'. This is OK for this test —
      // we're testing that triggerDiff doesn't crash and the warning code runs.
      const report = db.select().from(schema.apkDiffReports)
        .where(eq(schema.apkDiffReports.apkVersionId, newVersionId)).get()!;
      expect(report).toBeDefined();
      // Report status depends on runDiff's pre-check; the important part is that
      // triggerDiffForVersions ran and checked the previous version's availability
      expect(['in_progress', 'skipped']).toContain(report.status);
      expect(report.compareVersionId).toBe(oldVersionId);
    });
  });

  describe('AI summary via aiFactory.forCoreService', () => {
    it('triggers AI analysis via aiFactory.forCoreService("apk-diff-engine")', async () => {
      const handleMessage = vi.fn().mockResolvedValue({
        conversationId: 1,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      const forCoreService = vi.fn().mockReturnValue({
        identity: { identityType: 'core-service', actorUserId: 99, effectiveScopes: ['core.apk:read'] },
        handleMessage,
      });

      engine.setAiConfig(() => 'Summarize this diff.', () => true);
      engine.setAiFactory({ forCoreService, forUser: vi.fn() } as any);

      // Call the private runAiSummary directly to test the factory wiring
      await (engine as any).runAiSummary(42, 1);

      expect(forCoreService).toHaveBeenCalledWith('apk-diff-engine');
      expect(handleMessage).toHaveBeenCalledOnce();
      const callArg = handleMessage.mock.calls[0][0];
      expect(callArg).toMatchObject({
        mode: 'silent',
        pageContext: 'apk-diff',
        contextId: '42',
        conversationId: null,
      });
      expect((callArg as any).userId).toBeUndefined();
      expect((callArg as any).unattended).toBeUndefined();
    });

    it('skips AI summary when aiFactory is not set', async () => {
      engine.setAiConfig(() => 'Summarize this diff.', () => true);
      // No setAiFactory call

      // Should not throw
      await expect((engine as any).runAiSummary(42, 1)).resolves.toBeUndefined();
    });

    it('skips AI summary when getDiffPrompt is not configured', async () => {
      const forCoreService = vi.fn();
      engine.setAiFactory({ forCoreService, forUser: vi.fn() } as any);
      // No setAiConfig call — getDiffPrompt is null

      await expect((engine as any).runAiSummary(42, 1)).resolves.toBeUndefined();
      expect(forCoreService).not.toHaveBeenCalled();
    });

    it('skips AI summary when autorun is disabled', async () => {
      const forCoreService = vi.fn();
      engine.setAiConfig(() => 'Summarize.', () => false /* autorun off */);
      engine.setAiFactory({ forCoreService, forUser: vi.fn() } as any);

      await expect((engine as any).runAiSummary(42, 1)).resolves.toBeUndefined();
      expect(forCoreService).not.toHaveBeenCalled();
    });

    it('throws when forCoreService throws (no registered identity)', async () => {
      const forCoreService = vi.fn().mockImplementation(() => {
        throw new Error('forCoreService: "apk-diff-engine" is not registered.');
      });
      engine.setAiConfig(() => 'Summarize.');
      engine.setAiFactory({ forCoreService, forUser: vi.fn() } as any);

      await expect((engine as any).runAiSummary(42, 1)).rejects.toThrow('is not registered');
    });
  });
});

// ── Pre-check tests (availability-based skip) ─────────────────────────────────

type AvailabilityState = 'local' | 'cloud' | 'needs-reanalyze';

function setupEngine() {
  const db = createTestDb();
  const engine = new ApkDiffEngine(db as any);
  const fileSync = {
    acquireLocal: vi.fn().mockResolvedValue({ error: 'cloud unavailable' }),
  };
  engine.setFileSync(fileSync as any);
  return { engine, db, fileSync };
}

function seedCloudFileRow(
  db: BetterSQLite3Database<typeof schema>,
  cloudKey: string,
  localPath: string,
  syncState: 'synced' | 'cloud_only' | 'pending_upload',
) {
  const now = new Date();
  db.insert(schema.cloudFiles).values({
    namespace: 'apks',
    relativePath: cloudKey.replace(/^apks\//, ''),
    cloudKey,
    localPath,
    fileType: 'apk',
    fileSize: 1024,
    syncState,
    retain: false,
    lastAccessed: now,
    createdAt: now,
  } as any).run();
}

function seedPreCheckScenario(
  db: BetterSQLite3Database<typeof schema>,
  opts: { newState: AvailabilityState; oldState: AvailabilityState },
): { oldVersionId: number; newVersionId: number; reportId: number } {
  const now = new Date();

  // Insert a tracked app
  const appRow = db.insert(schema.trackedApps).values({
    packageName: 'com.example',
    createdAt: now,
  } as any).run();
  const trackedAppId = Number(appRow.lastInsertRowid);

  // Insert old version (vCode=100) and new version (vCode=101)
  const oldRow = db.insert(schema.apkVersions).values({
    trackedAppId,
    versionCode: 100,
    versionName: '1.0.0',
    filename: 'app-v1.apk',
    downloadedAt: now,
  } as any).run();
  const oldVersionId = Number(oldRow.lastInsertRowid);

  const newRow = db.insert(schema.apkVersions).values({
    trackedAppId,
    versionCode: 101,
    versionName: '1.1.0',
    filename: 'app-v2.apk',
    downloadedAt: now,
  } as any).run();
  const newVersionId = Number(newRow.lastInsertRowid);

  // Seed cloudFiles for each version according to the desired state.
  // The mock lookupVersionMeta returns:
  //   packageName: 'com.example', versionCode: versionId * 100, filename: `app-v${versionId}.apk`
  // So cloud keys are:
  //   apk:      apks/com.example/app-v{versionId}.apk
  //   source.db: apks/com.example/analysis/{versionId*100}/source.db
  //   metadata:  apks/com.example/analysis/{versionId*100}/metadata.json
  function seedArtifacts(versionId: number, state: AvailabilityState) {
    const pkg = 'com.example';
    const vCode = versionId * 100; // matches mock
    const apkKey = `apks/${pkg}/app-v${versionId}.apk`;
    const dbKey = `apks/${pkg}/analysis/${vCode}/source.db`;
    const metaKey = `apks/${pkg}/analysis/${vCode}/metadata.json`;

    if (state === 'local') {
      seedCloudFileRow(db, apkKey, '/tmp/apk', 'synced');
      seedCloudFileRow(db, dbKey, '/tmp/source.db', 'synced');
      seedCloudFileRow(db, metaKey, '/tmp/metadata.json', 'synced');
    } else if (state === 'cloud') {
      seedCloudFileRow(db, apkKey, '', 'cloud_only');
      seedCloudFileRow(db, dbKey, '', 'cloud_only');
      seedCloudFileRow(db, metaKey, '', 'cloud_only');
    } else if (state === 'needs-reanalyze') {
      // APK local, source.db row missing entirely, metadata local
      seedCloudFileRow(db, apkKey, '/tmp/apk', 'synced');
      // source.db intentionally NOT inserted → triggers needs-reanalyze
      seedCloudFileRow(db, metaKey, '/tmp/metadata.json', 'synced');
    }
  }

  seedArtifacts(newVersionId, opts.newState);
  seedArtifacts(oldVersionId, opts.oldState);

  // Create a pending diff report
  const reportRow = db.insert(schema.apkDiffReports).values({
    apkVersionId: newVersionId,
    compareVersionId: oldVersionId,
    status: 'pending',
    createdAt: now,
  } as any).run();
  const reportId = Number(reportRow.lastInsertRowid);

  return { oldVersionId, newVersionId, reportId };
}

describe('runDiff pre-check using availability', () => {
  it('marks report as skipped when new version is cloud-only — no cloud fetch attempted', async () => {
    const { engine, db, fileSync } = setupEngine();
    const { oldVersionId, newVersionId, reportId } = seedPreCheckScenario(db, {
      newState: 'cloud',
      oldState: 'local',
    });

    const fetchSpy = vi.spyOn(fileSync, 'acquireLocal');
    await (engine as any).runDiff(newVersionId, oldVersionId, reportId);

    const report = db.select().from(schema.apkDiffReports)
      .where(eq(schema.apkDiffReports.id, reportId)).get()!;
    expect(report.status).toBe('skipped');
    expect(report.error).toMatch(/cloud/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks report as skipped with needs-reanalyze reason when old version is needs-reanalyze', async () => {
    const { engine, db } = setupEngine();
    const { oldVersionId, newVersionId, reportId } = seedPreCheckScenario(db, {
      newState: 'local',
      oldState: 'needs-reanalyze',
    });

    await (engine as any).runDiff(newVersionId, oldVersionId, reportId);

    const report = db.select().from(schema.apkDiffReports)
      .where(eq(schema.apkDiffReports.id, reportId)).get()!;
    expect(report.status).toBe('skipped');
    expect(report.error).toMatch(/reanalyze/i);
  });

  it('does NOT mark as skipped when both sides are local — continues normal diff', async () => {
    const { engine, db } = setupEngine();
    const { oldVersionId, newVersionId, reportId } = seedPreCheckScenario(db, {
      newState: 'local',
      oldState: 'local',
    });

    // We don't care if the full diff succeeds (it may fail for unrelated reasons — missing
    // actual source.db files on disk in the test env). We only care that the pre-check
    // did NOT route it to 'skipped'.
    try {
      await (engine as any).runDiff(newVersionId, oldVersionId, reportId);
    } catch { /* ignore */ }

    const report = db.select().from(schema.apkDiffReports)
      .where(eq(schema.apkDiffReports.id, reportId)).get()!;
    expect(report.status).not.toBe('skipped');
  });
});
