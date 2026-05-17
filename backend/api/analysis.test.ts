import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import AdmZip from 'adm-zip';
import zlib from 'zlib';
import path from 'path';
import os from 'os';
import fs from 'fs';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAnalysisEndpoints } from './analysis';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const mockBroadcastToAll = vi.fn();
vi.mock('../websocket/index', () => ({
  broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
}));

const { trackedApps, apkVersions } = schema;

function createMainDb() {
  return createTestDb([schema.trackedApps, schema.apkVersions, schema.apkContents, schema.apkNotes]);
}

/**
 * Create a per-APK analysis DB on disk (since we need a real file path).
 * Returns the DB path.
 */
function createAnalysisDb(basePath: string): string {
  fs.mkdirSync(basePath, { recursive: true });
  const dbPath = path.join(basePath, 'source.db');
  const sqlite = new Database(dbPath);

  sqlite.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      size INTEGER NOT NULL,
      content BLOB NOT NULL,
      language TEXT NOT NULL
    );

    CREATE TABLE findings (
      id INTEGER PRIMARY KEY,
      file_id INTEGER REFERENCES files(id),
      rule_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      line_number INTEGER,
      matched_text TEXT,
      category TEXT NOT NULL
    );

    CREATE TABLE manifest (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed manifest data
  const insertManifest = sqlite.prepare('INSERT INTO manifest (key, value) VALUES (?, ?)');
  insertManifest.run('package', JSON.stringify('com.example.app'));
  insertManifest.run('versionCode', JSON.stringify(100));
  insertManifest.run('permissions', JSON.stringify(['android.permission.INTERNET', 'android.permission.CAMERA']));
  insertManifest.run('minSdk', JSON.stringify(21));
  insertManifest.run('targetSdk', JSON.stringify(34));

  // Seed files
  const insertFile = sqlite.prepare(
    'INSERT INTO files (id, path, source, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const mainActivity = `package com.example.app;

import android.app.Activity;
import android.os.Bundle;

public class MainActivity extends Activity {
    private static final String API_KEY = "sk-1234567890abcdef1234567890abcdef";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = "https://api.example.com/v1/data";
        String url2 = "https://cdn.example.com/assets/image.png";
        String serverIp = "10.0.1.50";
        String email = "admin@example.com";
    }
}`;
  const mainActivityCompressed = zlib.zstdCompressSync(Buffer.from(mainActivity, 'utf-8'));
  insertFile.run(1, 'com/example/app/MainActivity.java', 'jadx', mainActivity.length, mainActivityCompressed, 'java');

  const utilsClass = `package com.example.app.utils;

public class NetworkUtils {
    public static final String BASE_URL = "https://api.example.com/v2/users";
    public static final String BACKUP_URL = "http://backup.example.com/api";

    public static void doRequest() {
        // network logic
    }
}`;
  const utilsCompressed = zlib.zstdCompressSync(Buffer.from(utilsClass, 'utf-8'));
  insertFile.run(2, 'com/example/app/utils/NetworkUtils.java', 'jadx', utilsClass.length, utilsCompressed, 'java');

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.app">
    <uses-permission android:name="android.permission.INTERNET"/>
</manifest>`;
  const manifestCompressed = zlib.zstdCompressSync(Buffer.from(manifest, 'utf-8'));
  insertFile.run(3, 'AndroidManifest.xml', 'apktool', manifest.length, manifestCompressed, 'xml');

  // Seed findings
  const insertFinding = sqlite.prepare(
    `INSERT INTO findings (id, file_id, rule_id, severity, title, description, line_number, matched_text, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertFinding.run(1, 1, 'hardcoded-secret', 'high', 'Hardcoded API Key', 'API key found in source code', 7, 'sk-1234567890abcdef1234567890abcdef', 'secret');
  insertFinding.run(2, 1, 'http-url', 'medium', 'HTTP URL Found', 'Insecure HTTP URL detected', null, null, 'network');
  insertFinding.run(3, 2, 'http-url', 'medium', 'HTTP URL in NetworkUtils', 'Insecure HTTP URL', 4, 'http://backup.example.com/api', 'network');
  insertFinding.run(4, 1, 'logging-data', 'low', 'Debug logging', 'Potential data leak in logs', 10, null, 'privacy');

  sqlite.close();
  return dbPath;
}

let tmpDir: string;
let mainDb: BetterSQLite3Database<typeof schema>;
let app: express.Express;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-analysis-test-'));

  mainDb = createMainDb();

  // Insert tracked app and version
  mainDb.insert(trackedApps).values({
    packageName: 'com.example.app',
    appName: 'Example App',
    createdAt: new Date(),
  }).run();

  mainDb.insert(apkVersions).values({
    trackedAppId: 1,
    versionCode: 100,
    versionName: '1.0.0',
    filename: '100_1.0.0.apk',
    fileSize: 5000,
    downloadedAt: new Date(),
  }).run();

  // Create analysis DB at the path that resolveDbPath will construct
  // The function uses path.resolve(`data/apks/${packageName}/analysis/${versionCode}/source.db`)
  // We need to override this by patching the path resolution
  const analysisDir = path.join(tmpDir, 'com.example.app', 'analysis', '100');
  createAnalysisDb(analysisDir);

  clearEndpoints();
  registerAnalysisEndpoints(mainDb as any);
  app = express();
  app.use(express.json());
  app.use(getApiRouter());
}

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// We need to make resolveDbPath point to our temp dir.
// The cleanest way is to mock path.resolve for the specific pattern.
// Instead, let's use a different approach: patch the module's resolveDbPath via
// intercepting the fs.existsSync and Database constructor.
// Actually, the simplest: mock the data/apks directory to point to tmpDir.

// We'll use vi.mock to intercept the path.resolve call inside analysis.ts
// Actually let's just set the CWD to tmpDir so that path.resolve('data/apks/...') resolves there.
// Better approach: create the analysis DB at the actual resolved path relative to CWD.

describe('Analysis API Endpoints', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // Change cwd to tmpDir so path.resolve('data/apks/...') resolves within tmpDir
    setup();
    // Create the analysis DB in the path that path.resolve would produce
    // from the tmpDir context
    const analysisDir = path.join(tmpDir, 'data', 'apks', 'com.example.app', 'analysis', '100');
    createAnalysisDb(analysisDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup();
  });

  describe('GET /v1/apps/analysis/:versionId/overview', () => {
    it('returns manifest data, permissions, finding counts', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/overview');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.manifest.package).toBe('com.example.app');
      expect(data.manifest.permissions).toEqual(['android.permission.INTERNET', 'android.permission.CAMERA']);
      expect(data.manifest.minSdk).toBe(21);
      expect(data.manifest.targetSdk).toBe(34);

      // Finding counts by severity
      expect(data.findingCounts.high).toBe(1);
      expect(data.findingCounts.medium).toBe(2);
      expect(data.findingCounts.low).toBe(1);

      // Finding counts by category
      expect(data.findingsByCategory.secret).toBe(1);
      expect(data.findingsByCategory.network).toBe(2);
      expect(data.findingsByCategory.privacy).toBe(1);

      // File stats
      expect(data.fileCount).toBe(3);
      expect(data.totalSize).toBeGreaterThan(0);

      // Source counts
      expect(data.sourceCounts.jadx).toBe(2);
      expect(data.sourceCounts.apktool).toBe(1);
    });

    it('returns 404 if version does not exist', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/overview');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 404 if analysis DB does not exist', async () => {
      // Insert version with no analysis DB
      mainDb.insert(apkVersions).values({
        trackedAppId: 1,
        versionCode: 200,
        versionName: '2.0.0',
        filename: '200_2.0.0.apk',
        fileSize: 1000,
        downloadedAt: new Date(),
      }).run();

      const res = await request(app).get('/v1/apps/analysis/2/overview');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Analysis database not found');
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app).get('/v1/apps/analysis/abc/overview');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/apps/analysis/:versionId/tree', () => {
    it('returns flat file paths for all sources', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/tree');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.sources).toContain('jadx');
      expect(data.sources).toContain('apktool');
      expect(data.tree).toBeInstanceOf(Array);

      // Tree is flat path strings — frontend builds its own nested tree
      expect(data.tree).toContain('com/example/app/MainActivity.java');
      expect(data.tree).toContain('com/example/app/utils/NetworkUtils.java');
      expect(data.tree).toContain('AndroidManifest.xml');
    });

    it('supports ?source=jadx filter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/tree?source=jadx');

      expect(res.status).toBe(200);
      const data = res.body.data;
      // sources always returns ALL available sources regardless of filter
      expect(data.sources).toContain('jadx');

      // Should NOT include AndroidManifest.xml (that's apktool source)
      expect(data.tree).not.toContain('AndroidManifest.xml');

      // Should include jadx files
      expect(data.tree).toContain('com/example/app/MainActivity.java');
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/tree');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/apps/analysis/:versionId/file', () => {
    it('returns decompressed file content as JSON', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/file?path=com/example/app/MainActivity.java&source=jadx');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toContain('package com.example.app');
      expect(res.body.data).toContain('class MainActivity');
      expect(res.body.data).toContain('API_KEY');
    });

    it('requires path and source query params', async () => {
      // Missing both
      const res1 = await request(app).get('/v1/apps/analysis/1/file');
      expect(res1.status).toBe(400);
      expect(res1.body.error).toContain('path and source');

      // Missing source
      const res2 = await request(app).get('/v1/apps/analysis/1/file?path=foo.java');
      expect(res2.status).toBe(400);

      // Missing path
      const res3 = await request(app).get('/v1/apps/analysis/1/file?source=jadx');
      expect(res3.status).toBe(400);
    });

    it('returns 404 for nonexistent file', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/file?path=nonexistent/File.java&source=jadx');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('File not found');
    });

    it('falls back to another source when requested source has no match', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/file?path=com/example/app/MainActivity.java&source=apktool');

      // File exists in jadx — endpoint falls back to it
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('jadx');
    });
  });

  describe('GET /v1/apps/analysis/:versionId/search', () => {
    it('searches across all files, returns matches with context', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search?q=API_KEY');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.total).toBeGreaterThan(0);
      expect(data.limited).toBe(false);

      const match = data.results[0];
      expect(match.file).toBe('com/example/app/MainActivity.java');
      expect(match.source).toBe('jadx');
      expect(match.line).toBeGreaterThan(0);
      expect(match.content).toContain('API_KEY');
      expect(match.context).toBeInstanceOf(Array);
      expect(match.context.length).toBeGreaterThanOrEqual(1);
      expect(match.context.length).toBeLessThanOrEqual(3);
    });

    it('supports source filter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search?q=example&source=apktool');

      expect(res.status).toBe(200);
      const data = res.body.data;
      // Should only find results in apktool files (AndroidManifest.xml)
      for (const result of data.results) {
        expect(result.source).toBe('apktool');
      }
    });

    it('limits results to 100 matches', async () => {
      // Create a large file with many matches to test the limit
      const analysisDir = path.join(tmpDir, 'data', 'apks', 'com.example.app', 'analysis', '100');
      const dbPath = path.join(analysisDir, 'source.db');
      const sqlite = new Database(dbPath);

      // Generate a file with 150+ matching lines
      const lines: string[] = [];
      for (let i = 0; i < 150; i++) {
        lines.push(`MATCHME line ${i} with some content`);
      }
      const bigContent = lines.join('\n');
      const compressed = zlib.zstdCompressSync(Buffer.from(bigContent, 'utf-8'));
      sqlite.prepare(
        'INSERT INTO files (id, path, source, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(100, 'big/File.java', 'jadx', bigContent.length, compressed, 'java');
      sqlite.close();

      const res = await request(app).get('/v1/apps/analysis/1/search?q=MATCHME');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(100);
      expect(res.body.data.limited).toBe(true);
      expect(res.body.data.results.length).toBe(100);
    });

    it('requires q query parameter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('q query parameter');
    });

    it('handles regex special characters gracefully', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search?q=[invalid');
      expect(res.status).toBe(200);
      // Should not crash, falls back to literal string matching
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/search?q=test');
      expect(res.status).toBe(404);
    });

    it('supports case-insensitive search with caseSensitive=false', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search?q=api_key&caseSensitive=false');

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.results.length).toBeGreaterThan(0);
      // Should match API_KEY even though query is lowercase
      expect(data.results[0].content).toContain('API_KEY');
    });

    it('is case-sensitive by default', async () => {
      // lowercase "api_key" should NOT match "API_KEY" with default case-sensitive
      const res = await request(app).get('/v1/apps/analysis/1/search?q=api_key');

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.results.length).toBe(0);
    });

    it('supports regex mode with regex=true', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search?q=API_KEY.*abcdef&regex=true');

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].content).toContain('API_KEY');
    });

    it('treats special chars as literal when regex=false', async () => {
      // Dot should be literal, not "any char"
      const res = await request(app).get('/v1/apps/analysis/1/search?q=api.example.com');

      expect(res.status).toBe(200);
      const data = res.body.data;
      // Should match literal "api.example.com"
      expect(data.results.length).toBeGreaterThan(0);
    });

    it('falls back to literal on invalid regex with regex=true', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/search?q=[invalid&regex=true');
      expect(res.status).toBe(200);
      // Should not crash
    });

    it('combines caseSensitive=false and regex=true', async () => {
      const q = encodeURIComponent('class\\s+mainactivity');
      const res = await request(app).get(`/v1/apps/analysis/1/search?q=${q}&caseSensitive=false&regex=true`);

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].content).toContain('MainActivity');
    });
  });

  describe('GET /v1/apps/analysis/:versionId/download', () => {
    it('downloads a ZIP file with all sources', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/download')
        .buffer(true)
        .parse((res: any, cb: any) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('com.example.app.zip');
      // Verify we got actual ZIP data (PK magic bytes)
      expect(res.body[0]).toBe(0x50); // P
      expect(res.body[1]).toBe(0x4B); // K
    });

    it('downloads ZIP with source filter', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/download?source=jadx')
        .buffer(true)
        .parse((res: any, cb: any) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('com.example.app-jadx.zip');
      expect(res.body[0]).toBe(0x50);
      expect(res.body[1]).toBe(0x4B);
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/download');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app).get('/v1/apps/analysis/abc/download');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/apps/analysis/:versionId/findings', () => {
    it('returns all findings', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/findings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(4);
      expect(res.body.total).toBe(4);

      // Check structure of a finding (camelCase)
      const finding = res.body.data[0];
      expect(finding).toHaveProperty('id');
      expect(finding).toHaveProperty('ruleId');
      expect(finding).toHaveProperty('severity');
      expect(finding).toHaveProperty('title');
      expect(finding).toHaveProperty('description');
      expect(finding).toHaveProperty('category');
      expect(finding).toHaveProperty('filePath');
      expect(finding).toHaveProperty('fileSource');
    });

    it('supports severity filter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/findings?severity=high');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].severity).toBe('high');
      expect(res.body.data[0].title).toBe('Hardcoded API Key');
    });

    it('supports category filter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/findings?category=network');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      for (const finding of res.body.data) {
        expect(finding.category).toBe('network');
      }
    });

    it('supports combined severity and category filter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/findings?severity=medium&category=network');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      for (const finding of res.body.data) {
        expect(finding.severity).toBe('medium');
        expect(finding.category).toBe('network');
      }
    });

    it('returns empty array for no matches', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/findings?severity=critical');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/findings');
      expect(res.status).toBe(404);
    });

    it('supports excludePaths filter', async () => {
      // Exclude com.example.app.utils — should remove finding 3 (NetworkUtils) but keep 1, 2, 4 (MainActivity)
      const res = await request(app).get('/v1/apps/analysis/1/findings?excludePaths=com.example.app.utils');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.data).toHaveLength(3);
      // Finding 3 is in com/example/app/utils/NetworkUtils.java, should be excluded
      const ids = res.body.data.map((f: any) => f.id);
      expect(ids).not.toContain(3);
    });

    it('includes file path and source in findings', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/findings?severity=high');

      expect(res.status).toBe(200);
      const finding = res.body.data[0];
      expect(finding.filePath).toBe('com/example/app/MainActivity.java');
      expect(finding.fileSource).toBe('jadx');
    });
  });

  describe('GET /v1/apps/analysis/:versionId/strings', () => {
    it('returns URLs from network findings', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/strings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      // URLs come from findings with category 'network'
      // Finding #3 has matched_text 'http://backup.example.com/api'
      expect(Array.isArray(data.urls)).toBe(true);
      const urlTexts = data.urls.map((u: any) => u.url);
      expect(urlTexts).toContain('http://backup.example.com/api');

      // Each entry should have file context
      const entry = data.urls.find((u: any) => u.url === 'http://backup.example.com/api');
      expect(entry.filePath).toBe('com/example/app/utils/NetworkUtils.java');
      expect(entry.fileSource).toBe('jadx');
      expect(entry.lineNumber).toBe(4);
    });

    it('returns interesting strings from secret findings', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/strings');

      expect(res.status).toBe(200);
      const data = res.body.data;

      // Strings come from findings with category 'secret'
      expect(Array.isArray(data.strings)).toBe(true);
      const values = data.strings.map((s: any) => s.value);
      expect(values).toContain('sk-1234567890abcdef1234567890abcdef');

      // Each entry should have file context
      const entry = data.strings.find((s: any) => s.value === 'sk-1234567890abcdef1234567890abcdef');
      expect(entry.filePath).toBe('com/example/app/MainActivity.java');
      expect(entry.lineNumber).toBe(7);
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/strings');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/apps/analysis/:versionId/notes', () => {
    it('returns empty string when no notes file exists', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/notes');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.notes).toBe('');
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/notes');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app).get('/v1/apps/analysis/abc/notes');
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /v1/apps/analysis/:versionId/notes', () => {
    beforeEach(() => {
      mockBroadcastToAll.mockClear();
    });

    it('creates notes file and GET returns it back', async () => {
      const putRes = await request(app)
        .put('/v1/apps/analysis/1/notes')
        .send({ notes: '# Analysis Notes\n\nSome findings here.' });

      expect(putRes.status).toBe(200);
      expect(putRes.body.success).toBe(true);
      expect(putRes.body.ok).toBe(true);

      const getRes = await request(app).get('/v1/apps/analysis/1/notes');
      expect(getRes.status).toBe(200);
      expect(getRes.body.notes).toBe('# Analysis Notes\n\nSome findings here.');
    });

    it('broadcasts apk:notes-updated after successful save', async () => {
      await request(app)
        .put('/v1/apps/analysis/1/notes')
        .send({ notes: 'broadcast test' });

      expect(mockBroadcastToAll).toHaveBeenCalledWith({
        type: 'apk:notes-updated',
        versionId: 1,
        notes: 'broadcast test',
      });
    });

    it('overwrites existing notes content', async () => {
      await request(app)
        .put('/v1/apps/analysis/1/notes')
        .send({ notes: 'First version' });

      await request(app)
        .put('/v1/apps/analysis/1/notes')
        .send({ notes: 'Second version' });

      const getRes = await request(app).get('/v1/apps/analysis/1/notes');
      expect(getRes.body.notes).toBe('Second version');
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app)
        .put('/v1/apps/analysis/999/notes')
        .send({ notes: 'test' });
      expect(res.status).toBe(404);
    });

    it('returns 400 when notes is not a string', async () => {
      const res = await request(app)
        .put('/v1/apps/analysis/1/notes')
        .send({ notes: 123 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('notes must be a string');
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app)
        .put('/v1/apps/analysis/abc/notes')
        .send({ notes: 'test' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/apps/analysis/:versionId/ai-review', () => {
    it('returns 503 when apkAnalyzer not available', async () => {
      // The test setup does not pass an apkAnalyzer to registerAnalysisEndpoints,
      // so the endpoint should return 503.
      const res = await request(app).post('/v1/apps/analysis/1/ai-review');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('APK analyzer not available');
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app).post('/v1/apps/analysis/abc/ai-review');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid versionId');
    });

    it('forwards req.authUser.userId to triggerAiAgentManual', async () => {
      const triggerSpy = vi.fn().mockReturnValue({ started: true });
      const fakeAnalyzer = { triggerAiAgentManual: triggerSpy } as any;

      clearEndpoints();
      registerAnalysisEndpoints(mainDb as any, fakeAnalyzer);
      const localApp = express();
      localApp.use(express.json());
      // Inject authUser middleware before the router
      localApp.use((req: any, _res: any, next: any) => {
        req.authUser = { userId: 99, effectiveScopes: ['core.apk:manage'], via: 'session' };
        next();
      });
      localApp.use(getApiRouter());

      const res = await request(localApp).post('/v1/apps/analysis/1/ai-review');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(triggerSpy).toHaveBeenCalledOnce();
      expect(triggerSpy).toHaveBeenCalledWith(1, 99);
    });
  });

  describe('POST /v1/apps/analysis/:versionId/capture-launch', () => {
    it('returns 503 when services not available', async () => {
      const res = await request(app).post('/v1/apps/analysis/1/capture-launch');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app).post('/v1/apps/analysis/abc/capture-launch');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/apps/analysis/:versionId/assets/tree', () => {
    beforeEach(() => {
      // Create a test APK (ZIP) file at data/apks/com.example.app/100_1.0.0.apk
      const apkDir = path.join(tmpDir, 'data', 'apks', 'com.example.app');
      fs.mkdirSync(apkDir, { recursive: true });
      const zip = new AdmZip();
      zip.addFile('AndroidManifest.xml', Buffer.from('<manifest/>'));
      zip.addFile('classes.dex', Buffer.from([0xDE, 0xCA, 0xFE, 0xBA]));
      zip.addFile('assets/config.json', Buffer.from('{"key":"value"}'));
      zip.addFile('res/layout/main.xml', Buffer.from('<LinearLayout/>'));
      zip.addFile('lib/arm64-v8a/libnative.so', Buffer.from([0x7F, 0x45, 0x4C, 0x46]));
      zip.writeZip(path.join(apkDir, '100_1.0.0.apk'));
    });

    it('returns entries from the APK file with lazy generation', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/assets/tree');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isSplit).toBe(false);
      expect(res.body.data.apkNames).toHaveLength(1);
      expect(res.body.data.apkNames[0]).toBe('100_1.0.0.apk');

      const paths = res.body.data.tree.map((e: any) => e.path);
      expect(paths).toContain('AndroidManifest.xml');
      expect(paths).toContain('classes.dex');
      expect(paths).toContain('assets/config.json');
      expect(paths).toContain('res/layout/main.xml');
      expect(paths).toContain('lib/arm64-v8a/libnative.so');
    });

    it('returns cached entries on second request (no re-read)', async () => {
      // First request generates
      const res1 = await request(app).get('/v1/apps/analysis/1/assets/tree');
      expect(res1.status).toBe(200);

      // Delete APK to prove second request uses DB cache
      const apkPath = path.join(tmpDir, 'data', 'apks', 'com.example.app', '100_1.0.0.apk');
      fs.unlinkSync(apkPath);

      const res2 = await request(app).get('/v1/apps/analysis/1/assets/tree');
      expect(res2.status).toBe(200);
      expect(res2.body.data.tree.length).toBe(res1.body.data.tree.length);
    });

    it('includes entry sizes', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/assets/tree');
      expect(res.status).toBe(200);

      const configEntry = res.body.data.tree.find((e: any) => e.path === 'assets/config.json');
      expect(configEntry).toBeDefined();
      expect(configEntry.size).toBe(Buffer.from('{"key":"value"}').length);
    });

    it('handles split APKs with multiple .apk files', async () => {
      // Insert a split APK version
      mainDb.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 200,
        versionName: '2.0.0',
        filename: '200_2.0.0',
        fileSize: 10000,
        downloadedAt: new Date(),
      }).run();

      // Create split APK directory with two .apk files
      const splitDir = path.join(tmpDir, 'data', 'apks', 'com.example.app', '200_2.0.0');
      fs.mkdirSync(splitDir, { recursive: true });

      const base = new AdmZip();
      base.addFile('AndroidManifest.xml', Buffer.from('<manifest/>'));
      base.addFile('classes.dex', Buffer.from([0xDE, 0xCA]));
      base.writeZip(path.join(splitDir, 'base.apk'));

      const config = new AdmZip();
      config.addFile('assets/split_config.json', Buffer.from('{}'));
      config.writeZip(path.join(splitDir, 'config.xxhdpi.apk'));

      const res = await request(app).get('/v1/apps/analysis/2/assets/tree');

      expect(res.status).toBe(200);
      expect(res.body.data.isSplit).toBe(true);
      expect(res.body.data.apkNames).toHaveLength(2);

      // Paths should be prefixed with apkName
      const paths = res.body.data.tree.map((e: any) => e.path);
      expect(paths.some((p: string) => p.startsWith('base.apk/'))).toBe(true);
      expect(paths.some((p: string) => p.startsWith('config.xxhdpi.apk/'))).toBe(true);
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app).get('/v1/apps/analysis/999/assets/tree');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid versionId', async () => {
      const res = await request(app).get('/v1/apps/analysis/abc/assets/tree');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/apps/analysis/:versionId/assets/file', () => {
    beforeEach(() => {
      const apkDir = path.join(tmpDir, 'data', 'apks', 'com.example.app');
      fs.mkdirSync(apkDir, { recursive: true });
      const zip = new AdmZip();
      zip.addFile('assets/config.json', Buffer.from('{"key":"value"}'));
      zip.addFile('assets/image.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
      zip.addFile('classes.dex', Buffer.from([0xDE, 0xCA, 0xFE, 0x00, 0xBA, 0xBE]));
      zip.addFile('res/values/strings.xml', Buffer.from('<resources><string name="app_name">Test</string></resources>'));
      zip.writeZip(path.join(apkDir, '100_1.0.0.apk'));
    });

    it('returns text content for text files', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/assets/file?path=assets/config.json');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isText).toBe(true);
      expect(res.body.data.content).toBe('{"key":"value"}');
      expect(res.body.data.size).toBe(Buffer.from('{"key":"value"}').length);
    });

    it('returns image with HTTP URLs', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/assets/file?path=assets/image.png');

      expect(res.status).toBe(200);
      expect(res.body.data.isImage).toBe(true);
      expect(res.body.data.imageUrl).toContain('/assets/file?path=');
      expect(res.body.data.imageUrl).toContain('raw=true');
      expect(res.body.data.imageUrl).toContain('inline=true');
      expect(res.body.data.downloadUrl).toContain('raw=true');
      expect(res.body.data.downloadUrl).not.toContain('inline=true');
    });

    it('returns binary info for binary files', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/assets/file?path=classes.dex');

      expect(res.status).toBe(200);
      expect(res.body.data.isText).toBe(false);
      expect(res.body.data.isImage).toBe(false);
      expect(res.body.data.downloadUrl).toContain('raw=true');
      expect(res.body.data.extension).toBe('.dex');
    });

    it('returns raw download when raw=true', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/assets/file?path=assets/config.json&raw=true')
        .buffer(true)
        .parse((res: any, cb: any) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('config.json');
      expect(res.body.toString()).toBe('{"key":"value"}');
    });

    it('requires path query parameter', async () => {
      const res = await request(app).get('/v1/apps/analysis/1/assets/file');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('path');
    });

    it('returns 404 for nonexistent entry in APK', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/assets/file?path=nonexistent/file.txt');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('File not found');
    });

    it('returns 404 for nonexistent version', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/999/assets/file?path=test');
      expect(res.status).toBe(404);
    });

    it('returns text content for XML files', async () => {
      const res = await request(app)
        .get('/v1/apps/analysis/1/assets/file?path=res/values/strings.xml');

      expect(res.status).toBe(200);
      expect(res.body.data.isText).toBe(true);
      expect(res.body.data.content).toContain('<resources>');
    });

    it('works with split APK apkName parameter', async () => {
      // Insert a split APK version
      mainDb.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 300,
        versionName: '3.0.0',
        filename: '300_3.0.0',
        fileSize: 10000,
        downloadedAt: new Date(),
      }).run();

      const splitDir = path.join(tmpDir, 'data', 'apks', 'com.example.app', '300_3.0.0');
      fs.mkdirSync(splitDir, { recursive: true });

      const base = new AdmZip();
      base.addFile('assets/data.json', Buffer.from('{"split":"base"}'));
      base.writeZip(path.join(splitDir, 'base.apk'));

      // Get the version ID (it should be 2 since 1 is the first version)
      const versions = mainDb.select().from(schema.apkVersions).all();
      const splitVersion = versions.find(v => v.versionCode === 300);

      const res = await request(app)
        .get(`/v1/apps/analysis/${splitVersion!.id}/assets/file?path=assets/data.json&apkName=base.apk`);

      expect(res.status).toBe(200);
      expect(res.body.data.isText).toBe(true);
      expect(res.body.data.content).toBe('{"split":"base"}');
    });
  });
});
