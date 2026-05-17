import path from 'path';
import fs from 'fs';
import { eq, and, desc, lt } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import * as schema from '../db/schema';
import type { AppDatabase } from '../db/index';
import { AI_DIFF_MAX_TURNS, type TierConfig } from './ai-agent';
import type { AiAgentFactory } from './ai-agent-factory';
import type { FileStorageService } from './file-storage';
import { APK_DIR, analysisDir as getAnalysisDir, analysisDbCloudKey, lookupVersionMeta } from '../utils/apk-paths';
import { computeVersionAvailability } from './apk-availability';

const { log, error } = createLoggers('apk-diff-engine');
export const DEFAULT_DIFF_PROMPT = `You are comparing two versions of an Android APK.

Call get_diff_overview first to retrieve the pre-computed structural diff (permissions, manifest, libraries, findings, file stats).

Then produce a concise, structured markdown summary covering:
- Notable permission changes and what they imply
- New or resolved security findings (focus on critical/high severity; call get_diff_new_findings for details)
- Framework or library changes of interest
- Overall assessment: major structural change, new feature, bug fix, or minor update?

Use get_diff_changed_files if you want to spot-check specific file changes. Keep the summary brief and actionable.
Call write_diff_summary when done.`;

export interface ApkDiffResult {
  newVersionName: string | null;
  oldVersionName: string | null;
  newFileSize: number | null;
  oldFileSize: number | null;
  minSdk: { old: number | null; new: number | null };
  targetSdk: { old: number | null; new: number | null };
  permissions: { added: string[]; removed: string[] };
  activities: { added: string[]; removed: string[] };
  services: { added: string[]; removed: string[] };
  receivers: { added: string[]; removed: string[] };
  providers: { added: string[]; removed: string[] };
  libraries: { added: string[]; removed: string[] };
  frameworkChanges: string | null;
  findings: {
    newCount: number;
    resolvedCount: number;
    persistentCount: number;
    bySeverity: Array<{ severity: string; newCount: number; resolvedCount: number }>;
  };
  files: {
    added: number;
    removed: number;
    modified: number | null;
    totalNew: number;
    totalOld: number;
    hasContentHash: boolean;
  };
  /** Relative path to the on-disk file change list JSON, relative to APK_DIR/{packageName} */
  fileListPath: string | null;
}

export interface ApkDiffReportRow {
  id: number;
  apkVersionId: number;
  compareVersionId: number;
  status: string;
  diffResult: ApkDiffResult | null;
  aiSummary: string | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export class ApkDiffEngine {
  private aiFactory: AiAgentFactory | null = null;
  private getDiffPrompt: (() => string) | null = null;
  private getDiffAutorun: (() => boolean) | undefined = undefined;
  private getTierConfig: (() => TierConfig | null) | null = null;
  private fileSync: FileStorageService | null = null;
  private activeRuns = new Set<number>(); // keyed by newVersionId

  constructor(private db: AppDatabase) {}

  setAiFactory(factory: AiAgentFactory): void {
    this.aiFactory = factory;
  }

  setAiConfig(getPrompt: () => string, getAutorun?: () => boolean, getTierConfig?: () => TierConfig | null): void {
    this.getDiffPrompt = getPrompt;
    this.getDiffAutorun = getAutorun;
    this.getTierConfig = getTierConfig ?? null;
  }

  setFileSync(sync: FileStorageService): void {
    this.fileSync = sync;
  }

  private resolveAnalysisDir(versionId: number): { dir: string; packageName: string; versionCode: number } | null {
    const meta = lookupVersionMeta(this.db, versionId);
    if (!meta) return null;
    return {
      dir: getAnalysisDir(meta.packageName, meta.versionCode),
      packageName: meta.packageName,
      versionCode: meta.versionCode,
    };
  }

  /** Find the most recent previous version of the same app with a completed analysis. */
  private findPreviousVersion(newVersionId: number): typeof schema.apkVersions.$inferSelect | null {
    const newVersion = this.db.select().from(schema.apkVersions).where(eq(schema.apkVersions.id, newVersionId)).all()[0];
    if (!newVersion) return null;

    const candidates = this.db
      .select()
      .from(schema.apkVersions)
      .where(and(
        eq(schema.apkVersions.trackedAppId, newVersion.trackedAppId),
        lt(schema.apkVersions.versionCode, newVersion.versionCode),
      ))
      .orderBy(desc(schema.apkVersions.versionCode))
      .all();

    for (const candidate of candidates) {
      const job = this.db
        .select()
        .from(schema.analysisJobs)
        .where(and(
          eq(schema.analysisJobs.apkVersionId, candidate.id),
          eq(schema.analysisJobs.status, 'completed'),
        ))
        .all()[0];
      if (job) return candidate;
    }
    return null;
  }

  /** Ensure source.db is available locally; download from cloud if needed. */
  private async ensureDbLocal(versionId: number): Promise<string | null> {
    const resolved = this.resolveAnalysisDir(versionId);
    if (!resolved) return null;

    const dbPath = path.join(resolved.dir, 'source.db');
    if (fs.existsSync(dbPath)) return dbPath;

    if (!this.fileSync) return null;

    try {
      const cloudKey = analysisDbCloudKey(resolved.packageName, resolved.versionCode);
      const result = await this.fileSync.acquireLocal(cloudKey, 'apk-diff-engine', dbPath);
      if ('error' in result) {
        log(`Cloud DB unavailable for ${cloudKey}: ${(result as any).error}`);
        return null;
      }
      return (result as { path: string }).path;
    } catch (err: any) {
      log(`Failed to download source.db for version ${versionId}: ${err.message}`);
      return null;
    }
  }

  private openDb(dbPath: string): Database.Database | null {
    try {
      return new Database(dbPath, { readonly: true });
    } catch (err: any) {
      error(`Failed to open DB at ${dbPath}: ${err.message}`);
      return null;
    }
  }

  private readManifest(db: Database.Database): Record<string, any> {
    const manifest: Record<string, any> = {};
    try {
      for (const row of db.prepare('SELECT key, value FROM manifest').all() as any[]) {
        try { manifest[row.key] = JSON.parse(row.value); } catch { manifest[row.key] = row.value; }
      }
    } catch {}
    return manifest;
  }

  private readMetadata(analysisDir: string): any {
    const metaPath = path.join(analysisDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) return null;
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return null; }
  }

  private diffArrays(oldArr: string[], newArr: string[]): { added: string[]; removed: string[] } {
    const oldSet = new Set(oldArr);
    const newSet = new Set(newArr);
    return {
      added: newArr.filter(x => !oldSet.has(x)),
      removed: oldArr.filter(x => !newSet.has(x)),
    };
  }

  private hasColumn(db: Database.Database, table: string, column: string): boolean {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      return cols.some((c: any) => c.name === column);
    } catch { return false; }
  }

  private computeFileDiff(
    newDb: Database.Database,
    oldDb: Database.Database,
    hasContentHash: boolean,
    packageName: string,
    newVCode: number,
    oldVCode: number,
  ): {
    added: number; removed: number; modified: number | null;
    totalNew: number; totalOld: number; fileListPath: string | null;
  } {
    type FileRow = { path: string; source: string; content_hash?: string };

    const newRows = hasContentHash
      ? (newDb.prepare('SELECT path, source, content_hash FROM files').all() as FileRow[])
      : (newDb.prepare('SELECT path, source FROM files').all() as FileRow[]);
    const oldRows = hasContentHash
      ? (oldDb.prepare('SELECT path, source, content_hash FROM files').all() as FileRow[])
      : (oldDb.prepare('SELECT path, source FROM files').all() as FileRow[]);

    const newMap = new Map<string, string>(); // key -> hash
    const oldMap = new Map<string, string>();
    for (const r of newRows) newMap.set(`${r.source}:${r.path}`, r.content_hash ?? '');
    for (const r of oldRows) oldMap.set(`${r.source}:${r.path}`, r.content_hash ?? '');

    const addedList: Array<{ source: string; path: string }> = [];
    const removedList: Array<{ source: string; path: string }> = [];
    const modifiedList: Array<{ source: string; path: string }> = [];

    const parseKey = (key: string) => {
      const i = key.indexOf(':');
      return { source: key.slice(0, i), path: key.slice(i + 1) };
    };

    for (const [key, hash] of newMap) {
      if (!oldMap.has(key)) {
        addedList.push(parseKey(key));
      } else if (hasContentHash && hash && oldMap.get(key) !== hash) {
        modifiedList.push(parseKey(key));
      }
    }
    for (const key of oldMap.keys()) {
      if (!newMap.has(key)) removedList.push(parseKey(key));
    }

    // Write file list to disk
    let fileListPath: string | null = null;
    try {
      const diffsDir = path.join(APK_DIR, packageName, 'diffs');
      fs.mkdirSync(diffsDir, { recursive: true });
      const filename = `${newVCode}_vs_${oldVCode}.json`;
      fs.writeFileSync(
        path.join(diffsDir, filename),
        JSON.stringify({
          added: addedList,
          removed: removedList,
          modified: hasContentHash ? modifiedList : null,
        }),
        'utf-8',
      );
      fileListPath = `diffs/${filename}`;
    } catch (err: any) {
      error(`Failed to write file diff list: ${err.message}`);
    }

    return {
      added: addedList.length,
      removed: removedList.length,
      modified: hasContentHash ? modifiedList.length : null,
      totalNew: newMap.size,
      totalOld: oldMap.size,
      fileListPath,
    };
  }

  private async computeDiff(
    newVersionId: number,
    oldVersionId: number,
    newDbPath: string,
    oldDbPath: string,
    newAnalysisDir: string,
    oldAnalysisDir: string,
    packageName: string,
  ): Promise<ApkDiffResult> {
    const newDb = this.openDb(newDbPath);
    const oldDb = this.openDb(oldDbPath);

    if (!newDb || !oldDb) {
      newDb?.close();
      oldDb?.close();
      throw new Error('Could not open one or both analysis databases');
    }

    try {
      const newManifest = this.readManifest(newDb);
      const oldManifest = this.readManifest(oldDb);
      const newMeta = this.readMetadata(newAnalysisDir);
      const oldMeta = this.readMetadata(oldAnalysisDir);

      const newVersion = this.db.select().from(schema.apkVersions).where(eq(schema.apkVersions.id, newVersionId)).all()[0];
      const oldVersion = this.db.select().from(schema.apkVersions).where(eq(schema.apkVersions.id, oldVersionId)).all()[0];

      // Manifest diffs
      const toArr = (v: any) => (Array.isArray(v) ? v : []);
      const permissions = this.diffArrays(toArr(oldManifest.permissions), toArr(newManifest.permissions));
      const activities = this.diffArrays(toArr(oldManifest.activities), toArr(newManifest.activities));
      const services = this.diffArrays(toArr(oldManifest.services), toArr(newManifest.services));
      const receivers = this.diffArrays(toArr(oldManifest.receivers), toArr(newManifest.receivers));
      const providers = this.diffArrays(toArr(oldManifest.providers), toArr(newManifest.providers));

      // Library diffs from metadata.json
      const newLibs = (newMeta?.frameworks?.libraries ?? []).map((l: any) => l.name as string);
      const oldLibs = (oldMeta?.frameworks?.libraries ?? []).map((l: any) => l.name as string);
      const libraries = this.diffArrays(oldLibs, newLibs);

      // Framework changes
      const newFw = (newMeta?.frameworks?.detected ?? []).map((f: any) => f.name as string);
      const oldFw = (oldMeta?.frameworks?.detected ?? []).map((f: any) => f.name as string);
      const fwAdded = newFw.filter((f: string) => !oldFw.includes(f));
      const fwRemoved = oldFw.filter((f: string) => !newFw.includes(f));
      let frameworkChanges: string | null = null;
      if (fwAdded.length > 0 || fwRemoved.length > 0) {
        const parts: string[] = [];
        if (fwAdded.length > 0) parts.push(`Added: ${fwAdded.join(', ')}`);
        if (fwRemoved.length > 0) parts.push(`Removed: ${fwRemoved.join(', ')}`);
        frameworkChanges = parts.join(' · ');
      }

      // Findings diff by fingerprint (rule_id + file_path)
      type FindingRow = { rule_id: string; severity: string; file_path: string | null };
      const newFindings = newDb.prepare(
        `SELECT f.rule_id, f.severity, fi.path as file_path FROM findings f LEFT JOIN files fi ON f.file_id = fi.id`,
      ).all() as FindingRow[];
      const oldFindings = oldDb.prepare(
        `SELECT f.rule_id, f.severity, fi.path as file_path FROM findings f LEFT JOIN files fi ON f.file_id = fi.id`,
      ).all() as FindingRow[];

      const fKey = (f: FindingRow) => `${f.rule_id}:${f.file_path ?? ''}`;
      const newFKeys = new Set(newFindings.map(fKey));
      const oldFKeys = new Set(oldFindings.map(fKey));

      const newCount = newFindings.filter(f => !oldFKeys.has(fKey(f))).length;
      const resolvedCount = oldFindings.filter(f => !newFKeys.has(fKey(f))).length;
      const persistentCount = newFindings.filter(f => oldFKeys.has(fKey(f))).length;

      const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
      const bySeverity = SEVERITIES
        .map(sev => ({
          severity: sev,
          newCount: newFindings.filter(f => f.severity === sev && !oldFKeys.has(fKey(f))).length,
          resolvedCount: oldFindings.filter(f => f.severity === sev && !newFKeys.has(fKey(f))).length,
        }))
        .filter(s => s.newCount > 0 || s.resolvedCount > 0);

      // File stats
      const newHasHash = this.hasColumn(newDb, 'files', 'content_hash');
      const oldHasHash = this.hasColumn(oldDb, 'files', 'content_hash');
      const hasContentHash = newHasHash && oldHasHash;

      const fileDiff = this.computeFileDiff(
        newDb, oldDb, hasContentHash,
        packageName,
        newVersion?.versionCode ?? newVersionId,
        oldVersion?.versionCode ?? oldVersionId,
      );

      return {
        newVersionName: newVersion?.versionName ?? null,
        oldVersionName: oldVersion?.versionName ?? null,
        newFileSize: newVersion?.fileSize ?? null,
        oldFileSize: oldVersion?.fileSize ?? null,
        minSdk: {
          old: oldManifest.min_sdk != null ? Number(oldManifest.min_sdk) : null,
          new: newManifest.min_sdk != null ? Number(newManifest.min_sdk) : null,
        },
        targetSdk: {
          old: oldManifest.target_sdk != null ? Number(oldManifest.target_sdk) : null,
          new: newManifest.target_sdk != null ? Number(newManifest.target_sdk) : null,
        },
        permissions,
        activities,
        services,
        receivers,
        providers,
        libraries,
        frameworkChanges,
        findings: { newCount, resolvedCount, persistentCount, bySeverity },
        files: {
          added: fileDiff.added,
          removed: fileDiff.removed,
          modified: fileDiff.modified,
          totalNew: fileDiff.totalNew,
          totalOld: fileDiff.totalOld,
          hasContentHash,
        },
        fileListPath: fileDiff.fileListPath,
      };
    } finally {
      newDb.close();
      oldDb.close();
    }
  }

  private async runDiff(newVersionId: number, oldVersionId: number, reportId: number): Promise<void> {
    // Pre-check: if either side isn't local, skip without fetching.
    const newAvail = computeVersionAvailability(this.db, newVersionId);
    const oldAvail = computeVersionAvailability(this.db, oldVersionId);

    if (newAvail.state !== 'local' || oldAvail.state !== 'local') {
      const sides: string[] = [];
      if (newAvail.state !== 'local') sides.push(`new version (${newAvail.state})`);
      if (oldAvail.state !== 'local') sides.push(`old version (${oldAvail.state})`);
      const reason = `${sides.join(' and ')} not local; restore before running`;
      this.db.update(schema.apkDiffReports).set({
        status: 'skipped',
        error: reason,
        completedAt: new Date(),
      }).where(eq(schema.apkDiffReports.id, reportId)).run();
      log(`Diff skipped for report ${reportId}: ${reason}`);
      return;
    }

    const newResolved = this.resolveAnalysisDir(newVersionId);
    const oldResolved = this.resolveAnalysisDir(oldVersionId);

    if (!newResolved || !oldResolved) {
      throw new Error('Could not resolve analysis directories');
    }

    const [newDbPath, oldDbPath] = await Promise.all([
      this.ensureDbLocal(newVersionId),
      this.ensureDbLocal(oldVersionId),
    ]);

    if (!newDbPath) throw new Error(`Analysis database not available for version ${newVersionId}`);
    if (!oldDbPath) throw new Error(`Analysis database not available for previous version ${oldVersionId}`);

    const diffResult = await this.computeDiff(
      newVersionId, oldVersionId,
      newDbPath, oldDbPath,
      newResolved.dir, oldResolved.dir,
      newResolved.packageName,
    );

    // Structural diff complete — mark completed and broadcast
    this.db.update(schema.apkDiffReports)
      .set({ status: 'completed', diffJson: JSON.stringify(diffResult), completedAt: new Date() })
      .where(eq(schema.apkDiffReports.id, reportId))
      .run();

    broadcastToAll({ type: 'apk:diff-update', versionId: newVersionId, reportId, status: 'completed' });

    // AI summary (fire-and-forget within the run — errors don't fail the structural diff)
    this.runAiSummary(reportId, newVersionId)
      .catch((err: any) => {
        error(`AI diff summary failed for report ${reportId}: ${err.message}`);
      })
      .finally(() => {
        // Always broadcast completed so the frontend spinner stops,
        // even if the AI agent never called write_diff_summary or threw an error.
        broadcastToAll({ type: 'apk:diff-update', versionId: newVersionId, reportId, status: 'completed' });
      });
  }

  private async runAiSummary(reportId: number, newVersionId: number): Promise<void> {
    if (!this.aiFactory || !this.getDiffPrompt) {
      log(`Skipping AI diff summary for report ${reportId} — no AI factory configured`);
      return;
    }

    // Check autorun setting (defaults to true if no getter configured)
    if (this.getDiffAutorun && !this.getDiffAutorun()) {
      log(`Skipping AI diff summary for report ${reportId} — autorun disabled`);
      return;
    }

    const prompt = this.getDiffPrompt();
    const tierConfig = this.getTierConfig?.() ?? undefined;

    log(`Starting AI diff summary for report ${reportId}`);

    const agent = this.aiFactory.forCoreService('apk-diff-engine');
    const result = await agent.handleMessage({
      conversationId: null,
      message: prompt,
      pageContext: 'apk-diff',
      contextId: String(reportId),
      mode: 'silent',
      maxTurns: AI_DIFF_MAX_TURNS,
      tierConfig,
      compactInputToolNames: ['write_diff_summary'],
      onToken: () => {},
      onToolStart: (_id, name, _input, count, remaining) => {
        log(`AI diff tool #${count}: ${name} [${remaining} turns left] (report ${reportId})`);
      },
      onToolResult: (_id, name, _output, ms) => {
        log(`AI diff result: ${name} (${ms}ms) (report ${reportId})`);
      },
      onContextUsage: (percent) => {
        broadcastToAll({ type: 'apk:diff-update', versionId: newVersionId, reportId, status: 'running', contextPercent: percent });
      },
    });

    log(`AI diff summary completed for report ${reportId} (${result.usage?.inputTokens ?? 0} input, ${result.usage?.outputTokens ?? 0} output tokens)`);
    broadcastToAll({ type: 'apk:diff-update', versionId: newVersionId, reportId, status: 'completed', usage: result.usage });
  }

  getDiffReport(versionId: number): ApkDiffReportRow | null {
    const row = this.db
      .select()
      .from(schema.apkDiffReports)
      .where(eq(schema.apkDiffReports.apkVersionId, versionId))
      .orderBy(desc(schema.apkDiffReports.createdAt))
      .all()[0];

    if (!row) return null;
    return {
      id: row.id,
      apkVersionId: row.apkVersionId,
      compareVersionId: row.compareVersionId,
      status: row.status,
      diffResult: row.diffJson ? (JSON.parse(row.diffJson) as ApkDiffResult) : null,
      aiSummary: row.aiSummary,
      error: row.error,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  /** Auto-trigger after analysis completes. Finds previous version automatically. */
  triggerDiff(newVersionId: number): void {
    const prev = this.findPreviousVersion(newVersionId);
    if (!prev) {
      log(`No previous version found for ${newVersionId}, skipping diff`);
      return;
    }
    this.triggerDiffForVersions(newVersionId, prev.id);
  }

  /** Manual trigger for the rerun button. */
  triggerDiffManual(newVersionId: number): { started: boolean; reason?: string } {
    if (this.activeRuns.has(newVersionId)) {
      return { started: false, reason: 'Diff already running for this version' };
    }
    const prev = this.findPreviousVersion(newVersionId);
    if (!prev) {
      return { started: false, reason: 'No previous version with completed analysis found' };
    }
    this.triggerDiffForVersions(newVersionId, prev.id);
    return { started: true };
  }

  private triggerDiffForVersions(newVersionId: number, oldVersionId: number): void {
    if (this.activeRuns.has(newVersionId)) return;

    // Upsert the diff report row
    const existing = this.db
      .select()
      .from(schema.apkDiffReports)
      .where(and(
        eq(schema.apkDiffReports.apkVersionId, newVersionId),
        eq(schema.apkDiffReports.compareVersionId, oldVersionId),
      ))
      .all()[0];

    let reportId: number;
    if (existing) {
      this.db.update(schema.apkDiffReports)
        .set({ status: 'in_progress', error: null, diffJson: null, aiSummary: null, completedAt: null })
        .where(eq(schema.apkDiffReports.id, existing.id))
        .run();
      reportId = existing.id;
    } else {
      const ins = this.db.insert(schema.apkDiffReports)
        .values({ apkVersionId: newVersionId, compareVersionId: oldVersionId, status: 'in_progress', createdAt: new Date() })
        .run();
      reportId = Number(ins.lastInsertRowid);
    }

    // Verify that previous version is local (retention floor guarantee)
    const prevAvail = computeVersionAvailability(this.db, oldVersionId);
    if (prevAvail.state !== 'local') {
      error(
        `APK auto-diff: previous version ${oldVersionId} is ${prevAvail.state}, not local. ` +
        `This should not happen under the retention floor — investigate.`,
      );
    }

    this.activeRuns.add(newVersionId);
    broadcastToAll({ type: 'apk:diff-update', versionId: newVersionId, reportId, status: 'running' });

    this.runDiff(newVersionId, oldVersionId, reportId)
      .then(() => {
        log(`Diff run complete for version ${newVersionId} (AI summary may still be running)`);
      })
      .catch((err: any) => {
        error(`Diff failed for version ${newVersionId}: ${err.message}`);
        this.db.update(schema.apkDiffReports)
          .set({ status: 'failed', error: err.message })
          .where(eq(schema.apkDiffReports.id, reportId))
          .run();
        broadcastToAll({ type: 'apk:diff-update', versionId: newVersionId, reportId, status: 'failed', error: err.message });
      })
      .finally(() => {
        this.activeRuns.delete(newVersionId);
      });
  }
}
