import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { eq, and, desc } from 'drizzle-orm';
import { analysisJobs, apkVersions, trackedApps } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { AnalysisJob } from '../../shared/types/api';
import type { ToolManager, ToolPaths } from './tool-manager';
import type { FileStorageService } from './file-storage';
import type { TierConfig } from './ai-agent';
import { AI_ANALYSIS_MAX_TURNS } from './ai-agent';
import type { AiAgentFactory } from './ai-agent-factory';
import { broadcastToAll } from '../websocket/index';
import { createLoggers } from '../logs';
import { APK_DIR, apkFilePath, resolveApkLocal, apkCloudKey, ensureApkLocal, analysisDir as getAnalysisDir } from '../utils/apk-paths';
import { extractIconFromLocalApk } from './apk-tracker';
import { getNote, setNote } from './apk-notes';

const { log, error } = createLoggers('apk-analyzer');
const POLL_INTERVAL_MS = 2000;
const RESTART_DELAY_MS = 2000;
const COMMAND_TIMEOUT_MS = 300000; // 5 minutes per command
const LONG_COMMAND_TIMEOUT_MS = 1800000; // 30 minutes for store/scan

/**
 * Determines the Python executable path for the current platform.
 */
function getPythonPath(): string {
  if (process.platform === 'win32') {
    return path.resolve('.venv/Scripts/python.exe');
  }
  return path.resolve('.venv/bin/python');
}

interface PendingCommand {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Service that manages APK analysis via a long-running Python worker process.
 *
 * - Polls the analysisJobs table for pending jobs
 * - Sends jobs to the Python worker via JSON-over-stdin/stdout
 * - Runs a multi-stage pipeline: metadata -> decompile -> store -> scan
 * - Updates job status in DB and broadcasts WebSocket updates
 * - Auto-restarts the worker on crash
 */
export class ApkAnalyzerService {
  private worker: ChildProcess | null = null;
  private workerReady = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private currentJobId: number | null = null;
  private stdoutBuffer = '';
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCommands = new Map<string, PendingCommand>();
  private toolManager: ToolManager | null = null;
  private fileSync: FileStorageService | null = null;
  private toolsEnsured = false;
  private currentJobContext: { apkVersionId: number; packageName: string; stage: string } | null = null;
  private aiFactory: AiAgentFactory | null = null;
  private getAiPrompt: (() => string) | null = null;
  private getAiAutorun: (() => boolean) | undefined = undefined;
  private getTierConfig: (() => TierConfig | null) | null = null;
  private activeAiAgentRuns = new Set<number>();
  private diffEngine: import('./apk-diff-engine').ApkDiffEngine | null = null;
  private hookBus: import('@darkrideapp/plugin-sdk').HookBus | null = null;

  constructor(private db: AppDatabase) {}

  setHookBus(bus: import('@darkrideapp/plugin-sdk').HookBus): void {
    this.hookBus = bus;
  }

  setAiFactory(factory: AiAgentFactory): void {
    this.aiFactory = factory;
  }

  setAiConfig(getPrompt: () => string, getAutorun?: () => boolean, getTierConfig?: () => TierConfig | null): void {
    this.getAiPrompt = getPrompt;
    this.getAiAutorun = getAutorun;
    this.getTierConfig = getTierConfig ?? null;
  }

  /**
   * Set the ToolManager instance for decompile/store/scan stages.
   */
  setToolManager(tm: ToolManager): void {
    this.toolManager = tm;
  }

  setFileSync(sync: FileStorageService): void {
    this.fileSync = sync;
  }

  setDiffEngine(engine: import('./apk-diff-engine').ApkDiffEngine): void {
    this.diffEngine = engine;
  }

  /**
   * Enqueue an APK version for analysis. Returns the job ID.
   * If a pending or running job already exists for this version, returns its ID.
   *
   * @param opts.skipAiReview - When true, the AI review step at the end of the
   *   pipeline is skipped. Used for regeneration after cloud re-download, since
   *   the original AI notes are preserved in apk_notes.
   */
  async enqueue(apkVersionId: number, opts: { skipAiReview?: boolean } = {}): Promise<number> {
    // Check for existing pending or running job
    const existing = this.db
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.apkVersionId, apkVersionId),
          // Check for pending or running status
        ),
      )
      .all()
      .filter((j) => j.status === 'pending' || j.status === 'running');

    if (existing.length > 0) {
      return existing[0].id;
    }

    const result = this.db
      .insert(analysisJobs)
      .values({
        apkVersionId,
        status: 'pending',
        skipAiReview: opts.skipAiReview ?? false,
        createdAt: new Date(),
      })
      .run();

    return Number(result.lastInsertRowid);
  }

  /**
   * Get the status of a specific job by ID.
   */
  getJobStatus(jobId: number): AnalysisJob | null {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.id, jobId))
      .all();

    if (rows.length === 0) return null;
    return this.toAnalysisJob(rows[0]);
  }

  /**
   * Get the latest job for a specific APK version.
   */
  getJobStatusForVersion(apkVersionId: number): AnalysisJob | null {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.apkVersionId, apkVersionId))
      .orderBy(desc(analysisJobs.id))
      .all();

    if (rows.length === 0) return null;
    return this.toAnalysisJob(rows[0]);
  }

  /**
   * True while an AI agent (auto or manual) is actively running for this
   * version. Consumed by the UI so the analysis badge can read "AI Analysing"
   * instead of "Ready" during the post-analysis review phase.
   */
  isAiAgentRunning(apkVersionId: number): boolean {
    return this.activeAiAgentRuns.has(apkVersionId);
  }

  /**
   * Cancel a pending or running analysis job.
   * Pending jobs are marked as failed immediately.
   * Running jobs kill the worker and mark as failed.
   * Returns true if cancelled, false if job was not cancellable.
   */
  cancelJob(jobId: number): boolean {
    const rows = this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.id, jobId))
      .all();

    if (rows.length === 0) return false;
    const job = rows[0];

    if (job.status === 'completed' || job.status === 'failed') {
      return false;
    }

    if (job.status === 'running' && this.currentJobId === jobId) {
      // Kill the worker to abort the in-progress pipeline
      this.killWorkerTree();
      this.currentJobId = null;
      this.currentJobContext = null;
    }

    // Mark as failed with cancellation message
    const now = new Date();
    this.db
      .update(analysisJobs)
      .set({ status: 'failed', stage: null, error: 'Cancelled by user', completedAt: now })
      .where(eq(analysisJobs.id, jobId))
      .run();

    // Get context for broadcast
    const version = this.db.select().from(apkVersions).where(eq(apkVersions.id, job.apkVersionId)).all()[0];
    const app = version
      ? this.db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0]
      : null;

    broadcastToAll({
      type: 'apk:analysis-update',
      jobId,
      apkVersionId: job.apkVersionId,
      packageName: app?.packageName ?? 'unknown',
      status: 'failed',
      stage: null,
      progress: null,
      error: 'Cancelled by user',
      result: null,
    });

    log(`Analysis job ${jobId} cancelled by user`);
    return true;
  }

  /**
   * Reset all running jobs to pending. Called on server boot for crash recovery.
   */
  resetRunningJobs(): void {
    this.db
      .update(analysisJobs)
      .set({ status: 'pending', stage: null, startedAt: null })
      .where(eq(analysisJobs.status, 'running'))
      .run();
    log('Reset all running analysis jobs to pending');
  }

  /**
   * Start the service: spawn the worker and begin polling.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawnWorker();
    this.pollTimer = setInterval(() => this.processNextJob(), POLL_INTERVAL_MS);
    log('APK analyzer service started');
  }

  /**
   * Stop the service: stop polling, shut down worker.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reject all pending commands
    for (const [key, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Service stopped'));
      this.pendingCommands.delete(key);
    }

    if (this.worker) {
      await this.shutdownWorker();
    }

    log('APK analyzer service stopped');
  }

  // ---- Private methods ----

  private spawnWorker(): void {
    const pythonPath = getPythonPath();
    const scriptPath = path.resolve('python/apk_analyzer.py');

    log(`Spawning worker: ${pythonPath} ${scriptPath}`);

    this.workerReady = false;
    this.stdoutBuffer = '';

    const child = spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Linux, create a new process group so we can kill jadx and other
      // child processes when the worker is killed on timeout
      detached: process.platform !== 'win32',
    });

    this.worker = child;

    child.stdout!.on('data', (data: Buffer) => {
      this.stdoutBuffer += data.toString();
      this.processStdoutBuffer(child);
    });

    child.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      // Only log lines tagged with [DarkRide] to suppress noisy library output (e.g. androguard)
      for (const line of text.split('\n')) {
        if (line.includes('[DarkRide]')) {
          error(`Worker stderr: ${line.trim()}`);
        }
      }
    });

    child.on('exit', (code, signal) => {
      // Guard: only handle if this is still the current worker
      if (this.worker !== child) return;

      log(`Worker exited (code=${code}, signal=${signal})`);
      this.worker = null;
      this.workerReady = false;

      // Reject all pending commands (worker died)
      for (const [key, pending] of this.pendingCommands) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Worker exited unexpectedly'));
        this.pendingCommands.delete(key);
      }

      // Reset current running job back to pending
      if (this.currentJobId !== null) {
        this.resetJobToPending(this.currentJobId);
        this.currentJobId = null;
      }

      // Auto-restart if service is still running
      if (this.running) {
        log(`Restarting worker in ${RESTART_DELAY_MS}ms...`);
        this.restartTimer = setTimeout(() => {
          if (this.running) this.spawnWorker();
        }, RESTART_DELAY_MS);
      }
    });

    child.on('error', (err) => {
      if (this.worker !== child) return;
      error(`Worker error: ${err.message}`);
    });
  }

  private processStdoutBuffer(child: ChildProcess): void {
    const lines = this.stdoutBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        this.handleWorkerMessage(msg, child);
      } catch {
        error(`Invalid JSON from worker: ${trimmed}`);
      }
    }
  }

  private handleWorkerMessage(msg: any, _child: ChildProcess): void {
    if (msg.status === 'ready') {
      this.workerReady = true;
      log('Worker ready');
      return;
    }

    if (msg.status === 'shutdown') {
      log('Worker acknowledged shutdown');
      return;
    }

    // Forward progress messages via WebSocket (don't resolve command)
    if (msg.status === 'progress' && msg.id && this.currentJobContext) {
      broadcastToAll({
        type: 'apk:analysis-update',
        jobId: Number(msg.id),
        apkVersionId: this.currentJobContext.apkVersionId,
        packageName: this.currentJobContext.packageName,
        status: 'running',
        stage: this.currentJobContext.stage,
        progress: msg.progress ?? null,
        error: null,
        result: null,
      });
      return;
    }

    // Resolve pending command promise
    const cmdKey = msg.id ? String(msg.id) : null;
    if (cmdKey === null) return;

    const pending = this.pendingCommands.get(cmdKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(cmdKey);

      if (msg.status === 'completed') {
        pending.resolve(msg);
      } else if (msg.status === 'failed') {
        pending.reject(new Error(msg.error ?? 'Unknown error'));
      }
    }
  }

  /**
   * Send a command to the worker and wait for its response.
   * Returns the full response message on success, throws on failure.
   */
  private sendCommand(msg: any, timeoutMs = COMMAND_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const cmdKey = String(msg.id);

      const timer = setTimeout(() => {
        this.pendingCommands.delete(cmdKey);
        // Kill the worker on timeout — it (and its subprocesses like jadx) are
        // stuck and will be auto-restarted for the next job
        log(`Command timed out after ${timeoutMs}ms — killing worker`);
        this.killWorkerTree();
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCommands.set(cmdKey, { resolve, reject, timer });
      this.sendToWorker(msg);
    });
  }

  /**
   * Run the multi-stage analysis pipeline for a job.
   *
   * Stages:
   * 1. metadata (analyze) - Always runs
   * 2. decompile - Only if tools available; metadata failure doesn't block this
   * 2.5. hermes_decompile - Only if Hermes engine detected in metadata
   * 3. store_source - Only if decompile produced output
   * 4. scan_secrets - Only if store succeeded
   */
  private async runPipeline(
    job: typeof analysisJobs.$inferSelect,
    app: typeof trackedApps.$inferSelect,
    apkPath: string,
    outputDir: string,
  ): Promise<void> {
    const toolPaths = this.toolManager ? this.toolManager.getToolPaths() : {
      jadx: null, apktool: null, mobsfscan: null, java: null, blutter: null,
    };
    const dbPath = path.join(outputDir, 'source.db');
    const decompileDir = path.join(outputDir, 'decompiled');

    let metadataResult: any = null;
    const pipelineStart = Date.now();
    const stageTimings: Record<string, { start: number; end: number }> = {};

    // Resolve split APK paths for framework supplementation
    // If apkPath points to base.apk inside a directory, the parent is the split dir
    const apkParent = path.dirname(apkPath);
    const isSplitApk = path.basename(apkPath) === 'base.apk' &&
      fs.existsSync(apkParent) && fs.statSync(apkParent).isDirectory();
    let splitApkPaths: string[] | null = null;
    if (isSplitApk) {
      splitApkPaths = fs.readdirSync(apkParent)
        .filter(f => f.endsWith('.apk'))
        .map(f => path.join(apkParent, f));
    }

    // Stage 1: Metadata
    this.updateStage(job.id, 'metadata', job.apkVersionId, app.packageName);
    stageTimings.metadata = { start: Date.now(), end: 0 };
    try {
      const resp = await this.sendCommand({
        id: String(job.id),
        command: 'analyze',
        apkPath,
        outputDir,
        // Pass all split APK paths so Python can merge framework detection
        splitApkPaths: splitApkPaths,
      });
      metadataResult = resp.result;
    } catch (err: any) {
      log(`Metadata stage failed for job ${job.id}: ${err.message} — continuing to decompile`);
    }
    stageTimings.metadata.end = Date.now();

    let decompileSucceeded = false;
    const hasDecompileTools = !!(toolPaths.jadx || toolPaths.apktool);

    log(`Tool paths: jadx=${toolPaths.jadx || 'none'}, apktool=${toolPaths.apktool || 'none'}, java=${toolPaths.java || 'none'}, blutter=${toolPaths.blutter || 'none'}`);

    // Stage 2: Flutter decompile (if Flutter detected, independent of other tools)
    const isFlutter = metadataResult?.frameworks?.detected?.some((f: any) => f.name === 'Flutter');
    if (isFlutter) {
      this.updateStage(job.id, 'flutter', job.apkVersionId, app.packageName);
      stageTimings.flutter = { start: Date.now(), end: 0 };
      try {
        // For split APKs, find which APK contains libapp.so
        let flutterApkPath = apkPath;
        if (isSplitApk && splitApkPaths) {
          for (const splitPath of splitApkPaths) {
            try {
              const { default: AdmZip } = await import('adm-zip');
              const zip = new AdmZip(splitPath);
              const entries = zip.getEntries().map((e: any) => e.entryName);
              if (entries.some((e: string) => e.includes('libapp.so'))) {
                flutterApkPath = splitPath;
                log(`Flutter libs found in split APK: ${path.basename(splitPath)}`);
                break;
              }
            } catch { /* skip bad zips */ }
          }
        }

        const resp = await this.sendCommand({
          id: String(job.id),
          command: 'flutter_decompile',
          apkPath: flutterApkPath,
          outputDir: decompileDir,
          tools: { blutter: toolPaths.blutter ?? null },
        }, LONG_COMMAND_TIMEOUT_MS);
        if (resp.result?.dumpGenerated) {
          decompileSucceeded = true;
          const method = resp.result.stringsFallback ? 'string extraction' : 'blutter';
          log(`flutter_decompile: dump.dart generated via ${method} (arch=${resp.result.arch})`);
        }
        if (resp.result?.blutter) {
          const b = resp.result.blutter;
          if (b.success) {
            log(`blutter: succeeded`);
          } else {
            const isMissingTool = b.error?.includes('FileNotFoundError') || b.error?.includes('cannot find the file');
            log(`blutter: ${isMissingTool ? 'skipped (cmake/ninja not installed)' : `failed — ${b.error}`}`);
          }
        }
        if (metadataResult?.frameworks) {
          metadataResult.frameworks.flutterAnalysis = resp.result;
        }
      } catch (err: any) {
        log(`Flutter decompile stage failed for job ${job.id}: ${err.message} — continuing`);
        if (metadataResult?.frameworks) {
          metadataResult.frameworks.flutterAnalysis = { error: err.message };
        }
      }
      stageTimings.flutter.end = Date.now();
    }

    // Stage 3: Decompile with jadx/apktool (skip if no tools available)
    if (!hasDecompileTools) {
      log(`No decompile tools available — skipping jadx/apktool stages`);
    }

    if (hasDecompileTools) {
      this.updateStage(job.id, 'decompiling', job.apkVersionId, app.packageName);
      stageTimings.decompile = { start: Date.now(), end: 0 };
      try {
        const resp = await this.sendCommand({
          id: String(job.id),
          command: 'decompile',
          apkPath,
          tools: toolPaths,
          outputDir: decompileDir,
        }, LONG_COMMAND_TIMEOUT_MS);
        // Log per-tool results
        if (resp.result) {
          for (const [tool, result] of Object.entries(resp.result)) {
            const r = result as any;
            if (r?.success) {
              log(`${tool}: decompile succeeded`);
            } else if (r?.error) {
              log(`${tool}: decompile failed — ${r.error}`);
            }
          }
        }
        // Check if any tool produced output
        if (resp.result && Object.values(resp.result).some((r: any) => r && r.success)) {
          decompileSucceeded = true;
        }
      } catch (err: any) {
        log(`Decompile stage failed for job ${job.id}: ${err.message}`);
      }
      stageTimings.decompile.end = Date.now();

      // Stage 3.5: Hermes decompile (only if metadata detected Hermes engine with a bundle)
      if (decompileSucceeded && metadataResult?.frameworks?.hermesEngine && metadataResult?.frameworks?.hermesBundlePath) {
        this.updateStage(job.id, 'hermes', job.apkVersionId, app.packageName);
        stageTimings.hermes = { start: Date.now(), end: 0 };
        const venvBin = path.join(process.cwd(), '.venv', 'bin');
        try {
          const resp = await this.sendCommand({
            id: String(job.id),
            command: 'hermes_decompile',
            apkPath,
            outputDir: decompileDir,
            bundlePath: metadataResult.frameworks.hermesBundlePath,
            tools: {
              hbc_decompiler: path.join(venvBin, 'hbc-decompiler'),
              hbc_disassembler: path.join(venvBin, 'hbc-disassembler'),
            },
          }, LONG_COMMAND_TIMEOUT_MS);
          if (resp.result) {
            metadataResult.frameworks.hermesResult = resp.result;
            for (const [tool, result] of Object.entries(resp.result)) {
              const r = result as any;
              if (r?.success) {
                log(`hermes-dec ${tool}: succeeded`);
              } else if (r?.error) {
                log(`hermes-dec ${tool}: failed — ${r.error}`);
              }
            }
          }
        } catch (err: any) {
          log(`Hermes decompile stage failed for job ${job.id}: ${err.message} — continuing to store`);
          if (metadataResult?.frameworks) {
            metadataResult.frameworks.hermesError = err.message;
          }
        }
        stageTimings.hermes.end = Date.now();
      } else if (metadataResult?.frameworks?.reactNative && !metadataResult?.frameworks?.hermesEngine && metadataResult?.frameworks?.jsBundlePath) {
        // Plain JS bundle — beautify and store under hermes-dec/
        this.updateStage(job.id, 'beautifying', job.apkVersionId, app.packageName);
        stageTimings.beautify = { start: Date.now(), end: 0 };
        try {
          await this.sendCommand({
            id: String(job.id),
            command: 'beautify_js_bundle',
            apkPath,
            outputDir: decompileDir,
            bundlePath: metadataResult.frameworks.jsBundlePath,
          }, LONG_COMMAND_TIMEOUT_MS);
          decompileSucceeded = true;
          log(`beautify_js_bundle: succeeded`);
        } catch (err: any) {
          log(`Beautify JS bundle stage failed for job ${job.id}: ${err.message} — continuing to store`);
          metadataResult.frameworks.hermesNote = `Plain JS beautify failed: ${err.message}`;
        }
        stageTimings.beautify.end = Date.now();
      }
    }

    // Stage 4: Store (if any decompile stage produced output)
    if (decompileSucceeded) {
      this.updateStage(job.id, 'storing', job.apkVersionId, app.packageName);
      let storeSucceeded = false;
      stageTimings.store = { start: Date.now(), end: 0 };
      try {
        await this.sendCommand({
          id: String(job.id),
          command: 'store_source',
          decompileDir,
          dbPath,
          metadata: metadataResult || null,
        }, LONG_COMMAND_TIMEOUT_MS);
        storeSucceeded = true;
        // Clean up loose decompiled files — they're now in the DB
        fs.rm(decompileDir, { recursive: true, force: true }, () => {});
      } catch (err: any) {
        log(`Store stage failed for job ${job.id}: ${err.message}`);
      }
      stageTimings.store.end = Date.now();

      // Stage 5: Scan (only if store succeeded)
      if (storeSucceeded) {
        this.updateStage(job.id, 'scanning', job.apkVersionId, app.packageName);
        stageTimings.scan = { start: Date.now(), end: 0 };
        try {
          await this.sendCommand({
            id: String(job.id),
            command: 'scan_secrets',
            dbPath,
            mobsfscanPath: toolPaths.mobsfscan,
          }, LONG_COMMAND_TIMEOUT_MS);
        } catch (err: any) {
          log(`Scan stage failed for job ${job.id}: ${err.message}`);
        }
        stageTimings.scan.end = Date.now();
      }
    }

    // Stage 6: Emit apk:analyzed hook so plugins (e.g. maps) can run their
    // own post-analysis work without core depending on them.
    if (this.hookBus) {
      stageTimings.hooks = { start: Date.now(), end: 0 };
      try {
        const version = this.db.select().from(apkVersions)
          .where(eq(apkVersions.id, job.apkVersionId)).all()[0];
        const versionLabel = version
          ? `v${version.versionCode}${version.versionName ? ` (${version.versionName})` : ''}`
          : `apkVersion#${job.apkVersionId}`;
        this.hookBus.emit('apk:analyzed', {
          apkVersionId: job.apkVersionId,
          packageName: app.packageName,
          apkPath,
          dbPath,
          outputDir,
          versionLabel,
        });
      } catch (err: any) {
        log(`apk:analyzed hook failed for job ${job.id}: ${err.message}`);
      }
      stageTimings.hooks.end = Date.now();
    }

    // Write stage timings to source.db manifest
    await this.writeStageTimings(dbPath, stageTimings, Date.now() - pipelineStart);

    // Pipeline complete — verify source.db was created when we expected to create it
    if (decompileSucceeded && !fs.existsSync(dbPath)) {
      this.handleJobFailed(job.id, 'Analysis pipeline finished but source.db was not created (store step failed)');
      return;
    }

    this.handleJobCompleted(job.id, metadataResult);
  }

  /**
   * Write stage timing data to the source.db manifest table.
   */
  private async writeStageTimings(
    dbPath: string,
    stageTimings: Record<string, { start: number; end: number }>,
    totalDurationMs: number,
  ): Promise<void> {
    try {
      if (!fs.existsSync(dbPath)) return;
      const { default: Database } = await import('better-sqlite3');
      const sourceDb = new Database(dbPath);
      try {
        sourceDb.prepare(
          `INSERT OR REPLACE INTO manifest (key, value) VALUES ('stage_timings', ?)`,
        ).run(JSON.stringify(stageTimings));
        sourceDb.prepare(
          `INSERT OR REPLACE INTO manifest (key, value) VALUES ('total_duration_ms', ?)`,
        ).run(String(totalDurationMs));
      } finally {
        sourceDb.close();
      }
    } catch (err: any) {
      log(`Failed to write stage timings: ${err.message}`);
    }
  }

  /**
   * Update the stage column in DB and broadcast a WebSocket update.
   */
  private updateStage(jobId: number, stage: string, apkVersionId: number, packageName: string): void {
    this.db
      .update(analysisJobs)
      .set({ stage })
      .where(eq(analysisJobs.id, jobId))
      .run();

    // Cache for progress message forwarding
    this.currentJobContext = { apkVersionId, packageName, stage };

    broadcastToAll({
      type: 'apk:analysis-update',
      jobId,
      apkVersionId,
      packageName,
      status: 'running',
      stage,
      progress: null,
      error: null,
      result: null,
    });
  }

  private handleJobCompleted(jobId: number, result: any): void {
    const now = new Date();

    // Update job status
    this.db
      .update(analysisJobs)
      .set({ status: 'completed', stage: 'done', completedAt: now })
      .where(eq(analysisJobs.id, jobId))
      .run();

    this.currentJobId = null;
    this.currentJobContext = null;

    // Get the version + app info for icon copy and name backfill
    const job = this.db.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)).all()[0];
    if (!job) return;

    const version = this.db.select().from(apkVersions).where(eq(apkVersions.id, job.apkVersionId)).all()[0];
    if (!version) return;

    const app = this.db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0];
    if (!app) return;

    // Copy icon if present in analysis output
    if (result?.icon) {
      this.copyIcon(app.packageName, version);
    }

    // Fallback: extract icon from APK if still missing on disk
    const iconOnDisk = fs.existsSync(path.join(APK_DIR, app.packageName, 'icon.png'))
      || fs.existsSync(path.join(APK_DIR, app.packageName, 'icon.webp'));
    if (!iconOnDisk) {
      try {
        extractIconFromLocalApk(app.packageName);
      } catch { /* best-effort */ }
    }

    // Backfill trackedApps.appName if missing
    if (!app.appName && result?.appName) {
      this.db
        .update(trackedApps)
        .set({ appName: result.appName })
        .where(eq(trackedApps.id, app.id))
        .run();
      log(`Backfilled app name for ${app.packageName}: ${result.appName}`);
    }

    // Broadcast WebSocket update
    broadcastToAll({
      type: 'apk:analysis-update',
      jobId,
      apkVersionId: job.apkVersionId,
      packageName: app.packageName,
      status: 'completed',
      stage: 'done',
      progress: null,
      error: null,
      result: {
        appName: result?.appName ?? null,
        icon: result?.icon ?? false,
      },
    });

    log(`Analysis completed for job ${jobId} (${app.packageName})`);

    if (job.skipAiReview) {
      log(`Skipping AI review for job ${jobId} — regeneration preserves existing notes`);
    } else {
      this.triggerAiAgentAuto(job.apkVersionId);
    }
    this.diffEngine?.triggerDiff(job.apkVersionId);
    // Plugins that want to inspect the freshly-analysed APK (e.g. SDK
    // detectors that scan the source.db for a specific BuildConfig) can
    // listen for the `apk:analyzed` hook bus event emitted earlier in the
    // pipeline and do their own detection there. The core doesn't ship
    // SDK-specific detectors.
  }

  /** Auto-run path: triggered after APK analysis completes. Runs under the core service identity. */
  private triggerAiAgentAuto(versionId: number): void {
    if (!this.aiFactory || !this.getAiPrompt) return;

    // Check autorun setting (defaults to true if no getter configured)
    if (this.getAiAutorun && !this.getAiAutorun()) {
      log(`Skipping AI agent for version ${versionId} — autorun disabled`);
      return;
    }

    let agent;
    try {
      agent = this.aiFactory.forCoreService('apk-analyzer');
    } catch (err: any) {
      log(`Skipping AI agent for version ${versionId} — no AI provider configured`);
      return;
    }

    this.runAiAgent(versionId, agent);
  }

  /** Manual trigger: a user clicks "AI Analysis" — runs under that user's identity. */
  triggerAiAgentManual(versionId: number, userId: number): { started: boolean; reason?: string } {
    if (!this.aiFactory || !this.getAiPrompt) {
      return { started: false, reason: 'AI agent not configured' };
    }

    let agent;
    try {
      agent = this.aiFactory.forUser(userId);
    } catch (err: any) {
      return { started: false, reason: 'No AI provider configured' };
    }

    if (this.activeAiAgentRuns.has(versionId)) {
      return { started: false, reason: 'AI agent already running for this version' };
    }

    this.runAiAgent(versionId, agent);
    return { started: true };
  }

  private runAiAgent(versionId: number, agent: import('./ai-agent-factory').BoundAgent): void {
    if (this.activeAiAgentRuns.has(versionId)) {
      log(`AI agent already running for version ${versionId}, skipping`);
      return;
    }

    const prompt = this.getAiPrompt!();
    const tierConfig = this.getTierConfig?.() ?? undefined;
    this.activeAiAgentRuns.add(versionId);

    broadcastToAll({
      type: 'apk:ai-agent-update',
      versionId,
      status: 'running',
    });

    log(`Starting AI agent for version ${versionId}`);

    agent
      .handleMessage({
        conversationId: null,
        message: prompt,
        pageContext: 'apk-analysis',
        contextId: String(versionId),
        mode: 'silent',
        maxTurns: AI_ANALYSIS_MAX_TURNS,
        tierConfig,
        compactInputToolNames: ['patch_analysis_section', 'write_analysis_notes'],
        onToken: () => {},
        onToolStart: (_id, name, input, toolUseCount, turnsRemaining) => {
          const params = Object.entries((input as Record<string, unknown>) || {})
            .filter(([k]) => k !== 'versionId')
            .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : JSON.stringify(v)}`)
            .join(', ');
          log(`AI agent tool #${toolUseCount}: ${name}${params ? ` (${params})` : ''} [${turnsRemaining} turns left] (version ${versionId})`);
        },
        onToolResult: (_id, name, output, durationMs) => {
          const outStr = typeof output === 'string' ? output : JSON.stringify(output);
          log(`AI agent result: ${name} → ${outStr.length} chars, ${durationMs}ms (version ${versionId})`);
        },
        onContextUsage: (percent) => {
          broadcastToAll({
            type: 'apk:ai-agent-update',
            versionId,
            status: 'running',
            contextPercent: percent,
          });
        },
      })
      .then((result) => {
        log(`AI agent completed for version ${versionId} (${result.usage?.inputTokens ?? 0} input, ${result.usage?.outputTokens ?? 0} output tokens)`);
        broadcastToAll({
          type: 'apk:ai-agent-update',
          versionId,
          status: 'completed',
          usage: result.usage,
        });
      })
      .catch((err: any) => {
        error(`AI agent failed for version ${versionId}: ${err.message}`);
        broadcastToAll({
          type: 'apk:ai-agent-update',
          versionId,
          status: 'failed',
          error: err.message || String(err),
        });
        // Append error note so the user can see why AI review is missing
        try {
          const errorNote = `\n## AI Analysis Failed\n\nThe automated AI review could not complete: ${err.message}\n\nPlease review findings manually or re-run AI Review.\n`;
          const existing = getNote(this.db, versionId);
          const updated = existing ? existing + errorNote : errorNote.trimStart();
          setNote(this.db, versionId, updated);
          broadcastToAll({ type: 'apk:notes-updated', versionId, notes: updated });
        } catch (noteErr: any) {
          error(`Failed to write AI error note for version ${versionId}: ${noteErr.message}`);
        }
      })
      .finally(() => {
        this.activeAiAgentRuns.delete(versionId);
      });
  }

  private handleJobFailed(jobId: number, errorMsg: string): void {
    const now = new Date();

    this.db
      .update(analysisJobs)
      .set({ status: 'failed', stage: null, error: errorMsg, completedAt: now })
      .where(eq(analysisJobs.id, jobId))
      .run();

    this.currentJobId = null;
    this.currentJobContext = null;

    // Get context for broadcast
    const job = this.db.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)).all()[0];
    if (!job) return;

    const version = this.db.select().from(apkVersions).where(eq(apkVersions.id, job.apkVersionId)).all()[0];
    const app = version
      ? this.db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0]
      : null;

    broadcastToAll({
      type: 'apk:analysis-update',
      jobId,
      apkVersionId: job.apkVersionId,
      packageName: app?.packageName ?? 'unknown',
      status: 'failed',
      stage: null,
      progress: null,
      error: errorMsg,
      result: null,
    });

    error(`Analysis failed for job ${jobId}: ${errorMsg}`);
  }

  private copyIcon(packageName: string, version: typeof apkVersions.$inferSelect): void {
    const outputDir = getAnalysisDir(packageName, version.versionCode);
    const destDir = path.join(APK_DIR, packageName);

    for (const iconFile of ['icon.png', 'icon.webp']) {
      const srcPath = path.join(outputDir, iconFile);
      if (fs.existsSync(srcPath)) {
        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcPath, path.join(destDir, iconFile));
          log(`Copied ${iconFile} for ${packageName}`);
        } catch (err: any) {
          error(`Failed to copy icon: ${err.message}`);
        }
        break;
      }
    }
  }

  private processNextJob(): void {
    if (!this.workerReady || this.currentJobId !== null) return;

    // Find first pending job
    const pendingJobs = this.db
      .select()
      .from(analysisJobs)
      .where(eq(analysisJobs.status, 'pending'))
      .orderBy(analysisJobs.id)
      .limit(1)
      .all();

    if (pendingJobs.length === 0) return;

    const job = pendingJobs[0];

    // Get the APK version info to build the file path
    const version = this.db
      .select()
      .from(apkVersions)
      .where(eq(apkVersions.id, job.apkVersionId))
      .all()[0];

    if (!version) {
      // Mark as failed — version no longer exists
      this.db
        .update(analysisJobs)
        .set({ status: 'failed', error: 'APK version not found', completedAt: new Date() })
        .where(eq(analysisJobs.id, job.id))
        .run();
      return;
    }

    const app = this.db
      .select()
      .from(trackedApps)
      .where(eq(trackedApps.id, version.trackedAppId))
      .all()[0];

    if (!app) {
      this.db
        .update(analysisJobs)
        .set({ status: 'failed', error: 'Tracked app not found', completedAt: new Date() })
        .where(eq(analysisJobs.id, job.id))
        .run();
      return;
    }

    // Mark as running
    const now = new Date();
    this.db
      .update(analysisJobs)
      .set({ status: 'running', stage: 'metadata', startedAt: now })
      .where(eq(analysisJobs.id, job.id))
      .run();

    this.currentJobId = job.id;

    const localResolution = resolveApkLocal(app.packageName, version.filename);
    let apkPath = localResolution ? localResolution.baseApkPath : apkFilePath(app.packageName, version.filename);
    const outputDir = getAnalysisDir(app.packageName, version.versionCode);

    // Broadcast running status
    this.currentJobContext = { apkVersionId: job.apkVersionId, packageName: app.packageName, stage: 'metadata' };
    broadcastToAll({
      type: 'apk:analysis-update',
      jobId: job.id,
      apkVersionId: job.apkVersionId,
      packageName: app.packageName,
      status: 'running',
      stage: 'metadata',
      progress: null,
      error: null,
      result: null,
    });

    // Ensure tools are downloaded on first pipeline run
    const ensureAndRun = async () => {
      // If APK not resolved locally (missing file, or empty split-APK dir), try cloud storage
      let cloudRelease: (() => void) | undefined;
      if (!localResolution && this.fileSync) {
        const handle = await ensureApkLocal(app.packageName, version.filename, this.fileSync, `analysis-job-${job.id}`);
        if ('error' in handle) {
          this.handleJobFailed(job.id, `APK not available: ${handle.error}`);
          return;
        }
        apkPath = handle.resolution.baseApkPath;
        cloudRelease = () => handle.release();
      } else if (!localResolution) {
        // No resolution from resolveApkLocal — check if the raw path is a directory
        // (split APK dir with no .apk files) and fail fast instead of passing dir to Python
        try {
          if (fs.existsSync(apkPath) && fs.statSync(apkPath).isDirectory()) {
            this.handleJobFailed(job.id, `APK directory has no .apk files: ${version.filename}`);
            return;
          }
        } catch { /* statSync failure — proceed with raw path, pipeline will report its own errors */ }
      }

      if (this.toolManager && !this.toolsEnsured) {
        try {
          await this.toolManager.ensureTools();
          this.toolsEnsured = true;
        } catch (err: any) {
          log(`Tool download had errors: ${err.message}`);
          this.toolsEnsured = true; // Don't retry every job
        }
      }

      try {
        await this.runPipeline(job, app, apkPath, outputDir);
      } finally {
        if (cloudRelease) cloudRelease();
      }
    };

    ensureAndRun().catch((err) => {
      // Pipeline-level failure (e.g., worker crash during pipeline)
      this.handleJobFailed(job.id, err.message ?? 'Pipeline failed');
    });

    log(`Sent job ${job.id} to worker (${app.packageName} v${version.versionCode})`);
  }

  private sendToWorker(msg: any): void {
    if (!this.worker || !this.worker.stdin) {
      error('Cannot send to worker: no active worker');
      return;
    }
    this.worker.stdin.write(JSON.stringify(msg) + '\n');
  }

  private resetJobToPending(jobId: number): void {
    this.db
      .update(analysisJobs)
      .set({ status: 'pending', stage: null, startedAt: null })
      .where(eq(analysisJobs.id, jobId))
      .run();
    log(`Reset job ${jobId} to pending after worker crash`);
  }

  private async shutdownWorker(): Promise<void> {
    if (!this.worker) return;

    const child = this.worker;

    // Try graceful shutdown
    try {
      this.sendToWorker({ command: 'shutdown' });
    } catch { /* may already be dead */ }

    // Wait for exit with timeout
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.killWorkerTree();
        resolve();
      }, 3000);

      child.on('exit', () => {
        clearTimeout(timeout);
        this.worker = null;
        this.workerReady = false;
        resolve();
      });
    });
  }

  /**
   * Force-kill the worker and all its child processes (e.g. jadx).
   * On Linux, kills the process group; on Windows, uses taskkill /T.
   */
  private killWorkerTree(): void {
    if (!this.worker || !this.worker.pid) return;
    const pid = this.worker.pid;
    this.worker = null;
    this.workerReady = false;

    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        // Kill process group (negative PID)
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      // Process may already be dead
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }

    // Schedule worker restart so future jobs can still run
    if (this.running && !this.restartTimer) {
      log(`Restarting worker in ${RESTART_DELAY_MS}ms...`);
      this.restartTimer = setTimeout(() => {
        if (this.running) this.spawnWorker();
      }, RESTART_DELAY_MS);
    }
  }

  private toAnalysisJob(row: typeof analysisJobs.$inferSelect): AnalysisJob {
    return {
      id: row.id,
      apkVersionId: row.apkVersionId,
      status: row.status as AnalysisJob['status'],
      stage: row.stage ?? null,
      error: row.error,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt ? String(row.startedAt) : null,
      completedAt: row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt ? String(row.completedAt) : null,
    };
  }
}
