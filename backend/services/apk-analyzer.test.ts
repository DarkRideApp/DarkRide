import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';

// Mock child_process.spawn
const mockStdin = { write: vi.fn(), end: vi.fn() };
const mockStdout = { on: vi.fn() };
const mockStderr = { on: vi.fn() };
const mockChildProcess = {
  stdin: mockStdin,
  stdout: mockStdout,
  stderr: mockStderr,
  on: vi.fn(),
  kill: vi.fn(),
  pid: 12345,
};

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockChildProcess),
  exec: vi.fn(),
  execFile: vi.fn(),
  execSync: vi.fn(),
}));

const { existsSyncImpl } = vi.hoisted(() => ({
  existsSyncImpl: vi.fn((p: string) => String(p).endsWith('source.db')),
}));
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: existsSyncImpl,
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
      rm: vi.fn(),
    },
    existsSync: existsSyncImpl,
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    rm: vi.fn(),
  };
});

vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

import { ApkAnalyzerService } from './apk-analyzer';
import { broadcastToAll } from '../websocket/index';
import { createTestDb } from '../test-utils/create-test-db';

function insertTrackedApp(db: BetterSQLite3Database<typeof schema>, packageName: string): number {
  const result = db.insert(schema.trackedApps).values({
    packageName,
    createdAt: new Date(),
  }).run();
  return Number(result.lastInsertRowid);
}

function insertApkVersion(db: BetterSQLite3Database<typeof schema>, trackedAppId: number): number {
  const result = db.insert(schema.apkVersions).values({
    trackedAppId,
    versionCode: 100,
    versionName: '1.0.0',
    filename: '100_1.0.0.apk',
    downloadedAt: new Date(),
  }).run();
  return Number(result.lastInsertRowid);
}

describe('ApkAnalyzerService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let service: ApkAnalyzerService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    service = new ApkAnalyzerService(db as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('enqueue()', () => {
    it('should create a pending job and return its ID', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);

      const jobId = await service.enqueue(versionId);

      expect(jobId).toBeGreaterThan(0);

      const job = service.getJobStatus(jobId);
      expect(job).not.toBeNull();
      expect(job!.status).toBe('pending');
      expect(job!.apkVersionId).toBe(versionId);
    });

    it('should return existing pending job ID (no duplicate)', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);

      const jobId1 = await service.enqueue(versionId);
      const jobId2 = await service.enqueue(versionId);

      expect(jobId1).toBe(jobId2);
    });

    it('should return existing running job ID (no duplicate)', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);

      const jobId1 = await service.enqueue(versionId);

      // Manually mark job as running
      db.update(schema.analysisJobs)
        .set({ status: 'running', startedAt: new Date() })
        .run();

      const jobId2 = await service.enqueue(versionId);

      expect(jobId1).toBe(jobId2);
    });
  });

  describe('getJobStatus()', () => {
    it('should return null for nonexistent job', () => {
      const job = service.getJobStatus(999);
      expect(job).toBeNull();
    });

    it('should return job details for existing job', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);

      const jobId = await service.enqueue(versionId);
      const job = service.getJobStatus(jobId);

      expect(job).not.toBeNull();
      expect(job!.id).toBe(jobId);
      expect(job!.apkVersionId).toBe(versionId);
      expect(job!.status).toBe('pending');
      expect(job!.error).toBeNull();
    });
  });

  describe('getJobStatusForVersion()', () => {
    it('should return null when no jobs exist for version', () => {
      const job = service.getJobStatusForVersion(999);
      expect(job).toBeNull();
    });

    it('should return latest job for a version', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);

      // Create first job, mark it failed
      const jobId1 = await service.enqueue(versionId);
      db.update(schema.analysisJobs)
        .set({ status: 'failed', error: 'old failure', completedAt: new Date() })
        .run();

      // Create second job (new one since old is failed)
      const jobId2 = await service.enqueue(versionId);

      expect(jobId2).not.toBe(jobId1);

      const job = service.getJobStatusForVersion(versionId);
      expect(job).not.toBeNull();
      expect(job!.id).toBe(jobId2);
      expect(job!.status).toBe('pending');
    });
  });

  describe('resetRunningJobs()', () => {
    it('should reset running jobs to pending', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);

      const jobId = await service.enqueue(versionId);

      // Mark as running
      db.update(schema.analysisJobs)
        .set({ status: 'running', startedAt: new Date() })
        .run();

      let job = service.getJobStatus(jobId);
      expect(job!.status).toBe('running');

      service.resetRunningJobs();

      job = service.getJobStatus(jobId);
      expect(job!.status).toBe('pending');
    });

    it('should not affect pending or completed jobs', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId1 = insertApkVersion(db, appId);

      // Insert a second version
      const result2 = db.insert(schema.apkVersions).values({
        trackedAppId: appId,
        versionCode: 200,
        versionName: '2.0.0',
        filename: '200_2.0.0.apk',
        downloadedAt: new Date(),
      }).run();
      const versionId2 = Number(result2.lastInsertRowid);

      const pendingJobId = await service.enqueue(versionId1);
      const completedJobId = await service.enqueue(versionId2);

      // Mark second job as completed
      db.update(schema.analysisJobs)
        .set({ status: 'completed', completedAt: new Date() })
        .where(require('drizzle-orm').eq(schema.analysisJobs.id, completedJobId))
        .run();

      service.resetRunningJobs();

      const pendingJob = service.getJobStatus(pendingJobId);
      const completedJob = service.getJobStatus(completedJobId);
      expect(pendingJob!.status).toBe('pending');
      expect(completedJob!.status).toBe('completed');
    });
  });

  describe('setToolManager()', () => {
    it('should accept a ToolManager instance', () => {
      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: null, java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      // Should not throw
      service.setToolManager(mockToolManager as any);
    });
  });

  describe('pipeline orchestration', () => {
    /**
     * Helper to set up the service with the worker marked as ready so that
     * processNextJob() will pick up pending jobs without needing real timers.
     */
    function setupReadyWorker() {
      // Simulate spawnWorker by calling start() which registers the handler
      service.start();

      // Find the stdout data handler registered by spawnWorker
      const stdoutOnCalls = mockStdout.on.mock.calls;
      const dataHandler = stdoutOnCalls.find((c: any) => c[0] === 'data')?.[1];

      // Simulate the 'ready' message from the worker
      if (dataHandler) {
        dataHandler(Buffer.from(JSON.stringify({ status: 'ready' }) + '\n'));
      }
    }

    /**
     * Simulate the worker responding to a command via stdout.
     */
    function simulateWorkerResponse(response: any) {
      const stdoutOnCalls = mockStdout.on.mock.calls;
      const dataHandler = stdoutOnCalls.find((c: any) => c[0] === 'data')?.[1];
      if (dataHandler) {
        dataHandler(Buffer.from(JSON.stringify(response) + '\n'));
      }
    }

    /**
     * Get JSON commands sent to the worker via stdin.write.
     */
    function getSentCommands(): any[] {
      return mockStdin.write.mock.calls
        .map((call: any[]) => {
          try { return JSON.parse(call[0]); } catch { return null; }
        })
        .filter((cmd: any) => cmd !== null);
    }

    /**
     * Trigger a poll cycle by calling processNextJob directly.
     */
    function triggerPoll() {
      (service as any).processNextJob();
    }

    /**
     * Let microtasks run (for async pipeline steps).
     * Uses 50ms to allow dynamic imports (e.g. better-sqlite3 in writeStageTimings)
     * to resolve before assertions.
     */
    async function flush() {
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    /** Poll until a condition is met or timeout expires. */
    async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    }

    it('should run full pipeline with all 4 stages when tools are available', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();

      // Trigger a poll to pick up the pending job
      triggerPoll();
      await flush();

      // Stage 1: metadata command should have been sent
      let cmds = getSentCommands();
      expect(cmds.some((c: any) => c.command === 'analyze')).toBe(true);

      // Respond to metadata
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Example App', icon: false },
      });
      await flush();

      // Stage 2: decompile command should be sent
      cmds = getSentCommands();
      expect(cmds.some((c: any) => c.command === 'decompile')).toBe(true);

      // Respond to decompile (jadx succeeded)
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { jadx: { success: true, outputDir: '/out/jadx' } },
      });
      await flush();

      // Stage 3: store command
      cmds = getSentCommands();
      expect(cmds.some((c: any) => c.command === 'store_source')).toBe(true);

      // Respond to store
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { filesStored: 100 },
      });
      await flush();

      // Stage 4: scan command
      cmds = getSentCommands();
      expect(cmds.some((c: any) => c.command === 'scan_secrets')).toBe(true);

      // Respond to scan — pipeline then runs writeStageTimings (async import) + handleJobCompleted
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { findings: [] },
      });
      await waitFor(() => service.getJobStatus(jobId)?.stage === 'done');

      // Verify all 4 commands were sent
      cmds = getSentCommands();
      expect(cmds.filter((c: any) => c.command === 'analyze')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'decompile')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'store_source')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'scan_secrets')).toHaveLength(1);

      // Verify final job status
      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');
      expect(job!.stage).toBe('done');

      // Verify WebSocket broadcasts included all stage transitions
      const broadcasts = (broadcastToAll as any).mock.calls.map((c: any) => c[0]);
      const stageUpdates = broadcasts
        .filter((b: any) => b.type === 'apk:analysis-update' && b.status === 'running')
        .map((b: any) => b.stage);
      expect(stageUpdates).toContain('metadata');
      expect(stageUpdates).toContain('decompiling');
      expect(stageUpdates).toContain('storing');
      expect(stageUpdates).toContain('scanning');

      await service.stop();
    });

    it('should skip decompile/store/scan when no tools available', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: null, apktool: null, mobsfscan: null, java: null,
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Respond to metadata — pipeline then runs writeStageTimings + handleJobCompleted
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Example App', icon: false },
      });
      await waitFor(() => service.getJobStatus(jobId)?.stage === 'done');

      // Only analyze command should have been sent
      const cmds = getSentCommands();
      expect(cmds.filter((c: any) => c.command === 'analyze')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'decompile')).toHaveLength(0);
      expect(cmds.filter((c: any) => c.command === 'store_source')).toHaveLength(0);
      expect(cmds.filter((c: any) => c.command === 'scan_secrets')).toHaveLength(0);

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');
      expect(job!.stage).toBe('done');

      await service.stop();
    });

    it('should skip store/scan when decompile fails', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Respond to metadata with success
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Test', icon: false },
      });
      await flush();

      // Decompile fails
      simulateWorkerResponse({
        id: String(jobId),
        status: 'failed',
        error: 'Decompile failed: jadx crashed',
      });
      await flush();

      // Only analyze + decompile sent, no store/scan
      const cmds = getSentCommands();
      expect(cmds.filter((c: any) => c.command === 'analyze')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'decompile')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'store_source')).toHaveLength(0);
      expect(cmds.filter((c: any) => c.command === 'scan_secrets')).toHaveLength(0);

      // Job still completes (decompile failure doesn't fail the whole pipeline)
      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should skip store/scan when decompile returns no successes', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Metadata success
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Test', icon: false },
      });
      await flush();

      // Decompile "completed" but all tools failed
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { jadx: { success: false, error: 'Out of memory' } },
      });
      await flush();

      // No store/scan
      const cmds = getSentCommands();
      expect(cmds.filter((c: any) => c.command === 'store_source')).toHaveLength(0);
      expect(cmds.filter((c: any) => c.command === 'scan_secrets')).toHaveLength(0);

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should skip scan when store fails', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Metadata success
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Test', icon: false },
      });
      await flush();

      // Decompile success
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { jadx: { success: true, outputDir: '/out/jadx' } },
      });
      await flush();

      // Store fails
      simulateWorkerResponse({
        id: String(jobId),
        status: 'failed',
        error: 'Store failed: disk full',
      });
      await flush();

      // No scan command
      const cmds = getSentCommands();
      expect(cmds.filter((c: any) => c.command === 'scan_secrets')).toHaveLength(0);

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should continue to decompile even when metadata fails', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: null, java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Metadata FAILS
      simulateWorkerResponse({
        id: String(jobId),
        status: 'failed',
        error: 'Invalid APK',
      });
      await flush();

      // Decompile command should still be sent
      const cmds = getSentCommands();
      expect(cmds.some((c: any) => c.command === 'decompile')).toBe(true);

      // Decompile also fails
      simulateWorkerResponse({
        id: String(jobId),
        status: 'failed',
        error: 'Decompile failed',
      });
      await flush();

      // Job completes despite all failures
      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should send correct decompile command with tool paths', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const toolPaths = {
        jadx: '/tools/jadx/bin/jadx',
        apktool: '/tools/apktool/apktool.jar',
        mobsfscan: '/tools/mobsfscan',
        java: 'java',
      };
      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue(toolPaths),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Metadata success
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Test', icon: false },
      });
      await flush();

      const decompileCmd = getSentCommands().find((c: any) => c.command === 'decompile');
      expect(decompileCmd).toBeDefined();
      expect(decompileCmd.tools).toEqual(toolPaths);
      expect(decompileCmd.apkPath).toContain('com.example.app');
      expect(decompileCmd.outputDir).toContain('decompiled');

      // Clean up — respond to decompile so pipeline can finish
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { jadx: { success: false } },
      });
      await flush();

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should send correct store_source command with dbPath and decompileDir', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: null, java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Metadata success
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      // Decompile success
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { jadx: { success: true, outputDir: '/out' } },
      });
      await flush();

      const storeCmd = getSentCommands().find((c: any) => c.command === 'store_source');
      expect(storeCmd).toBeDefined();
      expect(storeCmd.decompileDir).toContain('decompiled');
      expect(storeCmd.dbPath).toContain('source.db');

      // Clean up
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      // scan_secrets should also be sent (store succeeded)
      expect(getSentCommands().some((c: any) => c.command === 'scan_secrets')).toBe(true);

      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should send correct scan_secrets command with mobsfscanPath and dbPath', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Metadata -> Decompile -> Store -> Scan
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      simulateWorkerResponse({
        id: String(jobId), status: 'completed',
        result: { jadx: { success: true, outputDir: '/out' } },
      });
      await flush();

      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      const scanCmd = getSentCommands().find((c: any) => c.command === 'scan_secrets');
      expect(scanCmd).toBeDefined();
      expect(scanCmd.dbPath).toContain('source.db');
      expect(scanCmd.mobsfscanPath).toBe('/tools/mobsfscan');

      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should call ensureTools on first pipeline run', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: null, apktool: null, mobsfscan: null, java: null,
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      expect(mockToolManager.ensureTools).toHaveBeenCalledTimes(1);

      // Let the metadata command complete
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      await service.stop();
    });

    it('should work without ToolManager (metadata only, no decompile)', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      // No ToolManager set
      setupReadyWorker();
      triggerPoll();
      await flush();

      // Respond to metadata
      simulateWorkerResponse({
        id: String(jobId),
        status: 'completed',
        result: { appName: 'Test App', icon: false },
      });
      await flush();

      // Only metadata command
      const cmds = getSentCommands();
      expect(cmds.filter((c: any) => c.command === 'analyze')).toHaveLength(1);
      expect(cmds.filter((c: any) => c.command === 'decompile')).toHaveLength(0);

      const job = service.getJobStatus(jobId);
      expect(job!.status).toBe('completed');

      await service.stop();
    });

    it('should update stage in DB at each pipeline step', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // After processNextJob, stage should be 'metadata'
      let job = service.getJobStatus(jobId);
      expect(job!.stage).toBe('metadata');

      // Metadata success
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      // Stage should update to 'decompiling'
      job = service.getJobStatus(jobId);
      expect(job!.stage).toBe('decompiling');

      // Decompile success
      simulateWorkerResponse({
        id: String(jobId), status: 'completed',
        result: { jadx: { success: true, outputDir: '/out' } },
      });
      await flush();

      // Stage should update to 'storing'
      job = service.getJobStatus(jobId);
      expect(job!.stage).toBe('storing');

      // Store success
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();

      // Stage should update to 'scanning'
      job = service.getJobStatus(jobId);
      expect(job!.stage).toBe('scanning');

      // Scan success — after this, pipeline calls writeStageTimings (async import)
      // then handleJobCompleted. Use waitFor to handle the async chain.
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await waitFor(() => service.getJobStatus(jobId)?.stage === 'done');

      // Final stage should be 'done'
      job = service.getJobStatus(jobId);
      expect(job!.stage).toBe('done');

      await service.stop();
    });

    it('should broadcast WebSocket updates for each stage', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: '/tools/jadx', apktool: null, mobsfscan: '/tools/mobsfscan', java: 'java',
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Run through full pipeline
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();
      simulateWorkerResponse({
        id: String(jobId), status: 'completed',
        result: { jadx: { success: true } },
      });
      await flush();
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await flush();
      simulateWorkerResponse({ id: String(jobId), status: 'completed', result: {} });
      await waitFor(() => service.getJobStatus(jobId)?.stage === 'done');

      // Check all stage broadcasts
      const broadcasts = (broadcastToAll as any).mock.calls.map((c: any) => c[0]);
      const runningBroadcasts = broadcasts.filter(
        (b: any) => b.type === 'apk:analysis-update' && b.status === 'running',
      );

      const stages = runningBroadcasts.map((b: any) => b.stage);
      expect(stages).toContain('metadata');
      expect(stages).toContain('decompiling');
      expect(stages).toContain('storing');
      expect(stages).toContain('scanning');

      // Should also have a completed broadcast
      const completedBroadcasts = broadcasts.filter(
        (b: any) => b.type === 'apk:analysis-update' && b.status === 'completed',
      );
      expect(completedBroadcasts).toHaveLength(1);
      expect(completedBroadcasts[0].stage).toBe('done');

      await service.stop();
    });

    it('should not run ensureTools on second pipeline run', async () => {
      const appId = insertTrackedApp(db, 'com.example.app');
      const versionId = insertApkVersion(db, appId);
      const jobId1 = await service.enqueue(versionId);

      const mockToolManager = {
        getToolPaths: vi.fn().mockReturnValue({
          jadx: null, apktool: null, mobsfscan: null, java: null,
        }),
        ensureTools: vi.fn().mockResolvedValue({}),
      };
      service.setToolManager(mockToolManager as any);

      setupReadyWorker();
      triggerPoll();
      await flush();

      // Complete first job
      simulateWorkerResponse({ id: String(jobId1), status: 'completed', result: {} });
      await flush();
      expect(mockToolManager.ensureTools).toHaveBeenCalledTimes(1);

      // Enqueue a second job (mark first as failed so we can create a new one)
      // Actually just create another version
      const vResult = db.insert(schema.apkVersions).values({
        trackedAppId: appId,
        versionCode: 200,
        versionName: '2.0.0',
        filename: '200_2.0.0.apk',
        downloadedAt: new Date(),
      }).run();
      const versionId2 = Number(vResult.lastInsertRowid);
      const jobId2 = await service.enqueue(versionId2);

      triggerPoll();
      await flush();

      // Complete second job
      simulateWorkerResponse({ id: String(jobId2), status: 'completed', result: {} });
      await flush();

      // ensureTools should still only be called once
      expect(mockToolManager.ensureTools).toHaveBeenCalledTimes(1);

      await service.stop();
    });
  });

  describe('triggerAiAgentManual — uses aiFactory.forUser', () => {
    let versionId: number;

    beforeEach(() => {
      const appId = insertTrackedApp(db, 'com.example.userId-test');
      versionId = insertApkVersion(db, appId);
    });

    it('manual trigger uses aiFactory.forUser', async () => {
      const handleMessage = vi.fn().mockResolvedValue({ usage: {}, conversationId: 1 });
      const forUser = vi.fn().mockReturnValue({
        identity: { identityType: 'user', actorUserId: 42, effectiveScopes: ['core.apk:read'] },
        handleMessage,
      });

      service.setAiConfig(() => 'test prompt', () => true);
      service.setAiFactory({ forUser, forCoreService: vi.fn() } as any);

      const result = service.triggerAiAgentManual(versionId, 42);
      expect(result.started).toBe(true);

      // Let the microtask queue flush so handleMessage is called
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(forUser).toHaveBeenCalledWith(42);
      expect(handleMessage).toHaveBeenCalledOnce();
      const callArg = handleMessage.mock.calls[0][0];
      // New API: no userId field, uses mode: 'silent' instead of unattended
      expect(callArg).toMatchObject({ mode: 'silent', pageContext: 'apk-analysis' });
      expect(callArg.userId).toBeUndefined();
    });

    it('returns not-started when aiFactory is not set', () => {
      service.setAiConfig(() => 'test prompt', () => true);
      // No setAiFactory call

      const result = service.triggerAiAgentManual(versionId, 42);
      expect(result.started).toBe(false);
      expect(result.reason).toMatch(/not configured/i);
    });

    it('returns not-started when forUser throws (no AI provider)', () => {
      const forUser = vi.fn().mockImplementation(() => { throw new Error('No provider'); });

      service.setAiConfig(() => 'test prompt', () => true);
      service.setAiFactory({ forUser, forCoreService: vi.fn() } as any);

      const result = service.triggerAiAgentManual(versionId, 42);
      expect(result.started).toBe(false);
      expect(result.reason).toMatch(/no ai provider/i);
    });

    it('isAiAgentRunning is true while a manual trigger is in flight, false after', async () => {
      // Use a promise we control so we can assert mid-flight.
      let resolveAi!: () => void;
      const aiPromise = new Promise<void>(r => { resolveAi = r; });
      const handleMessage = vi.fn().mockReturnValue(aiPromise.then(() => ({ usage: {}, conversationId: 1 })));
      const forUser = vi.fn().mockReturnValue({
        identity: { identityType: 'user', actorUserId: 42, effectiveScopes: ['core.apk:read'] },
        handleMessage,
      });

      service.setAiConfig(() => 'test prompt', () => true);
      service.setAiFactory({ forUser, forCoreService: vi.fn() } as any);

      expect(service.isAiAgentRunning(versionId)).toBe(false);
      service.triggerAiAgentManual(versionId, 42);
      // Micro-task: handleMessage is called but hasn't resolved yet.
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(service.isAiAgentRunning(versionId)).toBe(true);

      resolveAi();
      // Flush the resolution chain
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(service.isAiAgentRunning(versionId)).toBe(false);
    });
  });

  describe('triggerAiAgentAuto — uses aiFactory.forCoreService', () => {
    let versionId: number;

    beforeEach(() => {
      const appId = insertTrackedApp(db, 'com.example.autorun-system-user');
      versionId = insertApkVersion(db, appId);
    });

    it('auto trigger uses aiFactory.forCoreService("apk-analyzer")', async () => {
      const handleMessage = vi.fn().mockResolvedValue({ usage: {}, conversationId: 1 });
      const forCoreService = vi.fn().mockReturnValue({
        identity: { identityType: 'core-service', actorUserId: 99, effectiveScopes: ['core.apk:read'] },
        handleMessage,
      });

      service.setAiConfig(() => 'test prompt', () => true);
      service.setAiFactory({ forUser: vi.fn(), forCoreService } as any);

      // Invoke the private auto-run path directly (called after APK analysis completes)
      (service as any).triggerAiAgentAuto(versionId);

      // Let the microtask queue flush so handleMessage is called
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(forCoreService).toHaveBeenCalledWith('apk-analyzer');
      expect(handleMessage).toHaveBeenCalledOnce();
      const callArg = handleMessage.mock.calls[0][0];
      expect(callArg).toMatchObject({ mode: 'silent', pageContext: 'apk-analysis' });
    });

    it('auto trigger skips when aiFactory is not set', () => {
      service.setAiConfig(() => 'test prompt', () => true);
      // No setAiFactory call

      // Should not throw
      expect(() => (service as any).triggerAiAgentAuto(versionId)).not.toThrow();
    });

    it('auto trigger skips when autorun is disabled', async () => {
      const handleMessage = vi.fn().mockResolvedValue({ usage: {}, conversationId: 1 });
      const forCoreService = vi.fn().mockReturnValue({ identity: {}, handleMessage });

      service.setAiConfig(() => 'test prompt', () => false /* autorun disabled */);
      service.setAiFactory({ forUser: vi.fn(), forCoreService } as any);

      (service as any).triggerAiAgentAuto(versionId);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(forCoreService).not.toHaveBeenCalled();
      expect(handleMessage).not.toHaveBeenCalled();
    });
  });
});
