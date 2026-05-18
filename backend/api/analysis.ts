import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { isAxmlBuffer, decodeAxml } from '../utils/axml-parser';
import { isArscBuffer, parseArsc, type ArscResource } from '../utils/arsc-parser';
import Database from 'better-sqlite3';
import { registerEndpoint } from './api-service';
import { apkVersions, trackedApps, apkContents } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { ApkAnalyzerService } from '../services/apk-analyzer';
import type { DeviceManager } from '../services/device-manager';
import type { CaptureSessionManager } from '../services/capture-session-manager';
import type { FileStorageService } from '../services/file-storage';
import { adbShell } from '../services/device-manager';
import { safeJoinInside } from '../utils/safe-path';
import { createLoggers } from '../logs';
import { broadcastToAll } from '../websocket/index';
import {
  lookupVersionMeta,
  analysisDbPath,
  apkFilePath,
  apkCloudKey,
  resolveApkLocal,
  type VersionMeta,
} from '../utils/apk-paths';
import { getNote, setNote } from '../services/apk-notes';

/** Decompress file content — detects zstd (magic 0x28B52FFD) vs zlib */
function decompressContent(buf: Buffer): Buffer {
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xB5 && buf[2] === 0x2F && buf[3] === 0xFD) {
    return zlib.zstdDecompressSync(buf);
  }
  return zlib.inflateSync(buf);
}

const { error } = createLoggers('analysis-api');

/** Resolve version metadata + analysis DB path from a versionId. */
function resolveVersion(db: AppDatabase, versionId: number): (VersionMeta & { dbPath: string }) | null {
  const meta = lookupVersionMeta(db, versionId);
  if (!meta) return null;
  return { ...meta, dbPath: analysisDbPath(meta.packageName, meta.versionCode) };
}

function resolveDbPath(db: AppDatabase, versionId: number): string | null {
  const meta = lookupVersionMeta(db, versionId);
  if (!meta) return null;
  return analysisDbPath(meta.packageName, meta.versionCode);
}


/**
 * Open a per-APK analysis DB in read-only mode.
 * Returns null if the DB file doesn't exist.
 */
function openAnalysisDb(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: any) {
    error(`Failed to open analysis DB at ${dbPath}: ${err.message}`);
    return null;
  }
}

/** Text-viewable file extensions */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.xml', '.json', '.yml', '.yaml', '.properties', '.cfg', '.ini',
  '.html', '.htm', '.css', '.js', '.ts', '.java', '.kt', '.smali', '.pro',
  '.gradle', '.md', '.csv', '.tsv', '.log', '.sh', '.bat', '.py', '.rb',
  '.c', '.h', '.cpp', '.hpp', '.swift', '.m', '.plist', '.xib', '.storyboard',
  '.toml', '.conf', '.env', '.gitignore', '.version', '.MF', '.SF', '.RSA',
]);

/** Image extensions that can be rendered inline */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);

/** Detect MIME type from extension */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.xml': 'text/xml', '.json': 'application/json', '.js': 'text/javascript',
    '.html': 'text/html', '.css': 'text/css', '.txt': 'text/plain',
    '.apk': 'application/vnd.android.package-archive',
    '.dex': 'application/octet-stream', '.so': 'application/octet-stream',
    '.arsc': 'application/octet-stream',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

/** Check if buffer content looks like text (no null bytes in first 8KB) */
function looksLikeText(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

export function registerAnalysisEndpoints(
  db: AppDatabase,
  apkAnalyzer?: ApkAnalyzerService,
  deviceManager?: DeviceManager,
  captureManager?: CaptureSessionManager,
  fileSync?: FileStorageService,
): void {
  /**
   * Open the analysis DB if available. If the file is missing, fire-and-forget
   * a regeneration job (skipping AI review — original notes are preserved in
   * apk_notes). The endpoint still returns 404; UI should poll analysis-jobs
   * to detect completion.
   */
  function tryOpenAnalysis(versionId: number, dbPath: string): Database.Database | null {
    const analysisDb = openAnalysisDb(dbPath);
    if (!analysisDb && apkAnalyzer) {
      apkAnalyzer.enqueue(versionId, { skipAiReview: true }).catch(err => {
        error(`Failed to enqueue regeneration for version ${versionId}: ${err.message}`);
      });
    }
    return analysisDb;
  }

  // GET /v1/apps/analysis/:versionId/overview
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/overview', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const resolved = resolveVersion(db, versionId);
    if (!resolved) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, resolved.dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      // Get manifest entries
      const manifestRows = analysisDb.prepare('SELECT key, value FROM manifest').all() as Array<{ key: string; value: string }>;
      const manifest: Record<string, any> = {};
      for (const row of manifestRows) {
        try {
          manifest[row.key] = JSON.parse(row.value);
        } catch {
          manifest[row.key] = row.value;
        }
      }

      // Get finding counts by severity
      const findingCounts = analysisDb.prepare(
        'SELECT severity, COUNT(*) as count FROM findings GROUP BY severity',
      ).all() as Array<{ severity: string; count: number }>;

      const findingsByCategory = analysisDb.prepare(
        'SELECT category, COUNT(*) as count FROM findings GROUP BY category',
      ).all() as Array<{ category: string; count: number }>;

      // Get file count and total size
      const fileStats = analysisDb.prepare(
        'SELECT COUNT(*) as fileCount, COALESCE(SUM(size), 0) as totalSize FROM files',
      ).get() as { fileCount: number; totalSize: number };

      // Get source counts
      const sourceCounts = analysisDb.prepare(
        'SELECT source, COUNT(*) as count FROM files GROUP BY source',
      ).all() as Array<{ source: string; count: number }>;

      res.json({
        success: true,
        data: {
          appName: resolved.appName,
          packageName: resolved.packageName,
          versionCode: resolved.versionCode,
          versionName: resolved.versionName,
          manifest,
          findingCounts: Object.fromEntries(findingCounts.map(r => [r.severity, r.count])),
          findingsByCategory: Object.fromEntries(findingsByCategory.map(r => [r.category, r.count])),
          fileCount: fileStats.fileCount,
          totalSize: fileStats.totalSize,
          sourceCounts: Object.fromEntries(sourceCounts.map(r => [r.source, r.count])),
        },
      });
    } catch (err: any) {
      error(`Overview query failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/tree
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/tree', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const sourceFilter = req.query.source as string | undefined;

    const dbPath = resolveDbPath(db, versionId);
    if (!dbPath) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      // Always return all available sources
      const sourceRows = analysisDb.prepare('SELECT DISTINCT source FROM files').all() as Array<{ source: string }>;
      const sources = sourceRows.map(r => r.source);

      // Get files
      let files: Array<{ path: string; size: number; language: string }>;
      if (sourceFilter) {
        files = analysisDb.prepare(
          'SELECT path, size, language FROM files WHERE source = ?',
        ).all(sourceFilter) as Array<{ path: string; size: number; language: string }>;
      } else {
        files = analysisDb.prepare(
          'SELECT path, size, language FROM files',
        ).all() as Array<{ path: string; size: number; language: string }>;
      }

      // Return flat paths with normalized separators — frontend builds its own tree
      const tree = files.map(f => f.path.replaceAll('\\', '/'));

      res.json({
        success: true,
        data: {
          sources,
          tree,
        },
      });
    } catch (err: any) {
      error(`Tree query failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/file
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/file', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const filePath = req.query.path as string | undefined;
    const source = req.query.source as string | undefined;

    if (!filePath || !source) {
      res.status(400).json({ success: false, error: 'path and source query parameters are required' });
      return;
    }

    const dbPath = resolveDbPath(db, versionId);
    if (!dbPath) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      // Normalize path separators for cross-platform compatibility
      const normalizedPath = filePath.replaceAll('\\', '/');
      const backslashPath = filePath.replaceAll('/', '\\');

      // Try exact source first, then fall back to any source with this path
      let row = analysisDb.prepare(
        'SELECT content, language, source FROM files WHERE (path = ? OR path = ?) AND source = ?',
      ).get(normalizedPath, backslashPath, source) as { content: Buffer; language: string; source: string } | undefined;

      if (!row) {
        row = analysisDb.prepare(
          'SELECT content, language, source FROM files WHERE (path = ? OR path = ?) LIMIT 1',
        ).get(normalizedPath, backslashPath) as { content: Buffer; language: string; source: string } | undefined;
      }

      if (!row) {
        res.status(404).json({ success: false, error: 'File not found' });
        return;
      }

      const decompressed = decompressContent(row.content);
      const text = decompressed.toString('utf-8');

      res.json({ success: true, data: text, source: row.source });
    } catch (err: any) {
      error(`File query failed for version ${versionId}, path=${filePath}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/search
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/search', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const query = req.query.q as string | undefined;
    const sourceFilter = req.query.source as string | undefined;
    const caseSensitive = req.query.caseSensitive !== 'false';
    const useRegex = req.query.regex === 'true';

    if (!query) {
      res.status(400).json({ success: false, error: 'q query parameter is required' });
      return;
    }

    const dbPath = resolveDbPath(db, versionId);
    if (!dbPath) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      const MAX_RESULTS = 100;

      // Fetch files to search through
      let files: Array<{ path: string; source: string; content: Buffer }>;
      if (sourceFilter) {
        files = analysisDb.prepare(
          'SELECT path, source, content FROM files WHERE source = ?',
        ).all(sourceFilter) as Array<{ path: string; source: string; content: Buffer }>;
      } else {
        files = analysisDb.prepare(
          'SELECT path, source, content FROM files',
        ).all() as Array<{ path: string; source: string; content: Buffer }>;
      }

      const results: Array<{
        file: string;
        source: string;
        line: number;
        content: string;
        context: string[];
      }> = [];
      let total = 0;

      const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = (caseSensitive ? '' : 'i') + 'g';
      let regex: RegExp;
      if (useRegex) {
        try {
          regex = new RegExp(query, flags);
        } catch {
          regex = new RegExp(escapeRegex(query), flags);
        }
      } else {
        regex = new RegExp(escapeRegex(query), flags);
      }

      for (const file of files) {
        if (total >= MAX_RESULTS) break;

        let text: string;
        try {
          const decompressed = decompressContent(file.content);
          text = decompressed.toString('utf-8');
        } catch {
          continue;
        }

        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (total >= MAX_RESULTS) break;

          // Reset regex lastIndex for each line
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            const contextStart = Math.max(0, i - 1);
            const contextEnd = Math.min(lines.length - 1, i + 1);
            const context: string[] = [];
            for (let j = contextStart; j <= contextEnd; j++) {
              context.push(lines[j]);
            }

            results.push({
              file: file.path,
              source: file.source,
              line: i + 1, // 1-indexed
              content: lines[i],
              context,
            });
            total++;
          }
        }
      }

      res.json({
        success: true,
        data: {
          results,
          total,
          limited: total >= MAX_RESULTS,
        },
      });
    } catch (err: any) {
      error(`Search failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/download
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/download', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const sourceFilter = req.query.source as string | undefined;

    const resolved = resolveVersion(db, versionId);
    if (!resolved) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, resolved.dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      let files: Array<{ path: string; source: string; content: Buffer }>;
      if (sourceFilter) {
        files = analysisDb.prepare(
          'SELECT path, source, content FROM files WHERE source = ?',
        ).all(sourceFilter) as Array<{ path: string; source: string; content: Buffer }>;
      } else {
        files = analysisDb.prepare(
          'SELECT path, source, content FROM files',
        ).all() as Array<{ path: string; source: string; content: Buffer }>;
      }

      const suffix = sourceFilter ? `-${sourceFilter}` : '';
      const zipFilename = `${resolved.packageName}${suffix}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err: Error) => {
        error(`Archive error for version ${versionId}: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: err.message });
        }
      });
      archive.pipe(res);

      for (const file of files) {
        try {
          const decompressed = decompressContent(file.content);
          const normalizedPath = file.path.replaceAll('\\', '/');
          const entryPath = sourceFilter ? normalizedPath : `${file.source}/${normalizedPath}`;
          archive.append(decompressed, { name: entryPath });
        } catch {
          // Skip files that can't be decompressed
        }
      }

      archive.finalize();
    } catch (err: any) {
      error(`Download failed for version ${versionId}: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/findings
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/findings', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const severity = req.query.severity as string | undefined;
    const category = req.query.category as string | undefined;
    const source = req.query.source as string | undefined;
    const excludePaths = req.query.excludePaths as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 1000);
    const offset = parseInt(req.query.offset as string) || 0;

    const dbPath = resolveDbPath(db, versionId);
    if (!dbPath) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      const conditions: string[] = [];
      const params: any[] = [];

      if (severity) {
        conditions.push('f.severity = ?');
        params.push(severity);
      }
      if (category) {
        conditions.push('f.category = ?');
        params.push(category);
      }

      // Filter by file source (e.g., 'hermes-dec', 'jadx', 'apktool')
      if (source) {
        conditions.push('fi.source = ?');
        params.push(source);
      }

      // Exclude library paths: dot-separated package prefixes → SQL LIKE patterns
      if (excludePaths) {
        const prefixes = excludePaths.split(',').filter(Boolean);
        for (const prefix of prefixes) {
          // Convert "com.google.firebase" → "%/com/google/firebase/%"
          // Prepend '/' to fi.path so paths like "com/google/..." match the pattern
          const slashPath = prefix.replace(/\./g, '/');
          conditions.push("('/' || fi.path) NOT LIKE ?");
          params.push(`%/${slashPath}/%`);
        }
      }

      const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

      // Get total count (join files when source or excludePaths is used)
      const countJoin = (source || excludePaths) ? ' LEFT JOIN files fi ON f.file_id = fi.id' : '';
      const countRow = analysisDb.prepare(
        `SELECT COUNT(*) as total FROM findings f${countJoin}${whereClause}`,
      ).get(...params) as { total: number };

      // Get paginated results
      const sql = `
        SELECT f.id, f.file_id, f.rule_id, f.severity, f.title, f.description,
               f.line_number, f.matched_text, f.category,
               fi.path as file_path, fi.source as file_source
        FROM findings f
        LEFT JOIN files fi ON f.file_id = fi.id
        ${whereClause}
        ORDER BY CASE f.severity
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          WHEN 'info' THEN 4
          ELSE 5
        END, f.id
        LIMIT ? OFFSET ?
      `;

      const rows = analysisDb.prepare(sql).all(...params, limit, offset) as any[];

      // Map snake_case to camelCase
      const findings = rows.map((r: any) => ({
        id: r.id,
        ruleId: r.rule_id,
        severity: r.severity,
        title: r.title,
        description: r.description,
        lineNumber: r.line_number,
        matchedText: r.matched_text,
        category: r.category,
        filePath: r.file_path ?? '',
        fileSource: r.file_source ?? '',
      }));

      res.json({
        success: true,
        data: findings,
        total: countRow.total,
        limit,
        offset,
      });
    } catch (err: any) {
      error(`Findings query failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/strings
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/strings', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const dbPath = resolveDbPath(db, versionId);
    if (!dbPath) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    const analysisDb = tryOpenAnalysis(versionId, dbPath);
    if (!analysisDb) {
      res.status(404).json({ success: false, error: 'Analysis database not found' });
      return;
    }

    try {
      // URLs from findings (network/url categories)
      const urlRows = analysisDb.prepare(`
        SELECT f.matched_text, f.line_number, f.rule_id,
               fi.path as file_path, fi.source as file_source
        FROM findings f
        LEFT JOIN files fi ON f.file_id = fi.id
        WHERE f.category IN ('network', 'url')
        ORDER BY f.id
        LIMIT 5000
      `).all() as Array<{
        matched_text: string; line_number: number; rule_id: string;
        file_path: string | null; file_source: string | null;
      }>;

      const urls = urlRows
        .filter(r => r.matched_text)
        .map(r => {
          const url = r.matched_text;
          let domain = url;
          try { domain = new URL(url).hostname; } catch {
            // Extract domain-like portion for non-URL entries (IPs etc)
            const m = url.match(/^https?:\/\/([^/]+)/);
            if (m) domain = m[1];
          }
          return {
            url,
            domain,
            filePath: r.file_path ?? '',
            fileSource: r.file_source ?? '',
            lineNumber: r.line_number ?? 0,
          };
        });

      // Interesting strings from findings (secret/certificate categories)
      const stringRows = analysisDb.prepare(`
        SELECT f.matched_text, f.line_number, f.rule_id, f.category,
               fi.path as file_path, fi.source as file_source
        FROM findings f
        LEFT JOIN files fi ON f.file_id = fi.id
        WHERE f.category IN ('secret', 'certificate')
        ORDER BY f.id
        LIMIT 5000
      `).all() as Array<{
        matched_text: string; line_number: number; rule_id: string; category: string;
        file_path: string | null; file_source: string | null;
      }>;

      const strings = stringRows
        .filter(r => r.matched_text)
        .map(r => ({
          value: r.matched_text,
          type: r.rule_id ?? r.category,
          filePath: r.file_path ?? '',
          fileSource: r.file_source ?? '',
          lineNumber: r.line_number ?? 0,
        }));

      res.json({
        success: true,
        data: { urls, strings },
      });
    } catch (err: any) {
      error(`Strings query failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      analysisDb.close();
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/notes
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/notes', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const meta = lookupVersionMeta(db, versionId);
    if (!meta) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    res.json({ success: true, notes: getNote(db, versionId) });
  }, { requires: ['core.apk:read'] });

  // PUT /v1/apps/analysis/:versionId/notes
  registerEndpoint('PUT', '/v1/apps/analysis/:versionId/notes', (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const { notes } = req.body;
    if (typeof notes !== 'string') {
      res.status(400).json({ success: false, error: 'notes must be a string' });
      return;
    }

    const meta = lookupVersionMeta(db, versionId);
    if (!meta) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    try {
      setNote(db, versionId, notes);
      broadcastToAll({ type: 'apk:notes-updated', versionId, notes });
      res.json({ success: true, ok: true });
    } catch (err: any) {
      error(`Failed to write notes for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/analysis/:versionId/capture-launch — Find device, start capture, launch app
  registerEndpoint('POST', '/v1/apps/analysis/:versionId/capture-launch', async (req, res) => {
    const versionId = parseInt(req.params.versionId, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }
    if (!deviceManager || !captureManager) {
      res.status(503).json({ success: false, error: 'Service not available' });
      return;
    }

    // 1. Look up package name and version code
    const version = db.select().from(apkVersions).where(eq(apkVersions.id, versionId)).all()[0];
    if (!version) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }
    const app = db.select().from(trackedApps).where(eq(trackedApps.id, version.trackedAppId)).all()[0];
    if (!app) {
      res.status(404).json({ success: false, error: 'Tracked app not found' });
      return;
    }

    const { packageName } = app;
    const targetVersionCode = version.versionCode;

    // 2. Get all online, non-busy devices
    const allStatuses = await deviceManager.getAllDeviceStatuses();
    const onlineDevices = allStatuses.filter(d => d.isOnline);
    if (onlineDevices.length === 0) {
      res.status(409).json({ success: false, error: 'No devices are online' });
      return;
    }

    const availableDevices = onlineDevices.filter(d => !d.isBusy);
    if (availableDevices.length === 0) {
      res.status(409).json({
        success: false,
        error: `All devices are busy (${onlineDevices.length} device(s) online but occupied)`,
      });
      return;
    }

    // 3. Find a device with the correct app version installed
    let matchedDevice: string | null = null;
    let versionMismatchInfo: string | null = null;

    for (const device of availableDevices) {
      try {
        const dumpsys = await adbShell(device.id, `dumpsys package ${packageName}`, 10000);
        const vcMatch = dumpsys.match(/versionCode=(\d+)/);
        const vnMatch = dumpsys.match(/versionName=([^\s]+)/);
        const installedVersionCode = vcMatch ? parseInt(vcMatch[1], 10) : null;
        const installedVersionName = vnMatch ? vnMatch[1] : null;

        if (installedVersionCode === null) continue;

        if (installedVersionCode === targetVersionCode) {
          matchedDevice = device.id;
          break;
        } else {
          versionMismatchInfo = `device has v${installedVersionName || installedVersionCode} (code ${installedVersionCode}) but analysis is for v${version.versionName || targetVersionCode} (code ${targetVersionCode})`;
        }
      } catch {
        // ADB error, skip device
      }
    }

    if (!matchedDevice) {
      if (versionMismatchInfo) {
        res.status(409).json({
          success: false,
          error: `App version mismatch — ${versionMismatchInfo}`,
        });
      } else {
        res.status(409).json({
          success: false,
          error: `App not installed on any available device (checked ${availableDevices.length} device(s))`,
        });
      }
      return;
    }

    // 4. Start capture and launch app
    try {
      const captureResult = await captureManager.startCapture(matchedDevice);
      await adbShell(matchedDevice, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, 10000);

      res.json({
        success: true,
        data: {
          deviceId: matchedDevice,
          sessionId: captureResult.sessionId,
        },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: `Failed to start capture: ${err.message}`,
      });
    }
  }, { requires: ['core.apk:manage'] });

  // POST /v1/apps/analysis/:versionId/ai-review — Trigger AI agent review
  registerEndpoint('POST', '/v1/apps/analysis/:versionId/ai-review', (req, res) => {
    const versionId = parseInt(req.params.versionId, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }
    if (!apkAnalyzer) {
      res.status(503).json({ success: false, error: 'APK analyzer not available' });
      return;
    }
    const authUser = (req as any).authUser;
    if (!authUser) { res.status(401).json({ error: 'unauthorized' }); return; }
    const result = apkAnalyzer.triggerAiAgentManual(versionId, authUser.userId);
    if (!result.started) {
      res.status(409).json({ success: false, error: result.reason });
      return;
    }
    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  // ─── Assets Browser Endpoints ───────────────────────────────────

  /**
   * Resolve the APK file/directory path for a given version.
   * Returns { apkPath, packageName, isSplit, filename }.
   */
  function resolveApkPath(versionId: number): {
    apkPath: string;
    packageName: string;
    filename: string;
    isSplit: boolean;
  } | null {
    const meta = lookupVersionMeta(db, versionId);
    if (!meta) return null;
    const local = resolveApkLocal(meta.packageName, meta.filename);
    const apkPath = apkFilePath(meta.packageName, meta.filename);
    return {
      apkPath,
      packageName: meta.packageName,
      filename: meta.filename,
      isSplit: local?.isSplit ?? false,
    };
  }

  /**
   * Lazily generate apk_contents rows for a version by reading ZIP central directories.
   * Returns the rows after generation.
   */
  async function generateApkContents(
    versionId: number,
    apkInfo: { apkPath: string; packageName: string; filename: string; isSplit: boolean },
  ): Promise<Array<{ apkName: string; entries: Array<{ path: string; size: number }> }>> {
    const { apkPath, packageName, filename, isSplit } = apkInfo;
    const results: Array<{ apkName: string; entries: Array<{ path: string; size: number }> }> = [];

    // Ensure the APK is available locally
    if (!fs.existsSync(apkPath)) {
      if (!fileSync) return [];
      const cloudKey = apkCloudKey(packageName, filename);
      const acquired = await fileSync.acquireLocal(cloudKey, `assets-tree-${versionId}`, apkPath);
      if (acquired.error) return [];
    }

    if (isSplit) {
      // Split APK: directory containing multiple .apk files
      const apkFiles = fs.readdirSync(apkPath).filter(f => f.endsWith('.apk'));
      for (const apkFile of apkFiles) {
        const zip = new AdmZip(path.join(apkPath, apkFile));
        const entries = zip.getEntries()
          .filter(e => !e.isDirectory)
          .map(e => ({ path: e.entryName, size: e.header.size }));
        results.push({ apkName: apkFile, entries });
      }
    } else {
      // Single APK file
      const zip = new AdmZip(apkPath);
      const apkName = path.basename(apkPath);
      const entries = zip.getEntries()
        .filter(e => !e.isDirectory)
        .map(e => ({ path: e.entryName, size: e.header.size }));
      results.push({ apkName, entries });
    }

    // Store in DB
    const now = new Date();
    for (const { apkName, entries } of results) {
      db.insert(apkContents).values({
        apkVersionId: versionId,
        apkName,
        entriesJson: JSON.stringify(entries),
        createdAt: now,
      }).run();
    }

    return results;
  }

  // GET /v1/apps/analysis/:versionId/assets/tree
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/assets/tree', async (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const apkInfo = resolveApkPath(versionId);
    if (!apkInfo) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    try {
      // Check if we already have cached entries
      const existing = db.select().from(apkContents)
        .where(eq(apkContents.apkVersionId, versionId))
        .all();

      let contentRows: Array<{ apkName: string; entries: Array<{ path: string; size: number }> }>;

      if (existing.length > 0) {
        contentRows = existing.map(row => ({
          apkName: row.apkName,
          entries: JSON.parse(row.entriesJson) as Array<{ path: string; size: number }>,
        }));
      } else {
        // Lazy-generate
        contentRows = await generateApkContents(versionId, apkInfo);
        if (contentRows.length === 0) {
          res.status(404).json({ success: false, error: 'APK file not found' });
          return;
        }
      }

      const isSplit = contentRows.length > 1;
      const apkNames = contentRows.map(r => r.apkName);

      // Build flat tree entries — for split APKs, prefix with apkName
      const tree: Array<{ path: string; size: number }> = [];
      for (const row of contentRows) {
        for (const entry of row.entries) {
          tree.push({
            path: apkInfo.isSplit ? `${row.apkName}/${entry.path}` : entry.path,
            size: entry.size,
          });
        }
      }

      res.json({
        success: true,
        data: { tree, apkNames, isSplit },
      });
    } catch (err: any) {
      error(`Assets tree failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/assets/file
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/assets/file', async (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const filePath = req.query.path as string | undefined;
    if (!filePath) {
      res.status(400).json({ success: false, error: 'path query parameter is required' });
      return;
    }

    const apkName = req.query.apkName as string | undefined;
    const raw = req.query.raw === 'true';

    const apkInfo = resolveApkPath(versionId);
    if (!apkInfo) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    try {
      // Ensure APK is available locally
      if (!fs.existsSync(apkInfo.apkPath)) {
        if (!fileSync) {
          res.status(404).json({ success: false, error: 'APK file not found' });
          return;
        }
        const cloudKey = apkCloudKey(apkInfo.packageName, apkInfo.filename);
        const acquired = await fileSync.acquireLocal(cloudKey, `assets-file-${versionId}`, apkInfo.apkPath);
        if (acquired.error) {
          res.status(404).json({ success: false, error: 'APK file not found' });
          return;
        }
      }

      // Determine which .apk file to open
      let zipPath: string;
      if (apkInfo.isSplit) {
        const targetApk = apkName || fs.readdirSync(apkInfo.apkPath).find(f => f.endsWith('.apk'));
        if (!targetApk) {
          res.status(404).json({ success: false, error: 'No APK files in split directory' });
          return;
        }
        zipPath = safeJoinInside(apkInfo.apkPath, targetApk);
      } else {
        zipPath = apkInfo.apkPath;
      }

      if (!fs.existsSync(zipPath)) {
        res.status(404).json({ success: false, error: 'APK file not found on disk' });
        return;
      }

      const zip = new AdmZip(zipPath);
      const entry = zip.getEntry(filePath);
      if (!entry) {
        res.status(404).json({ success: false, error: 'File not found in APK' });
        return;
      }

      const data = entry.getData();
      const ext = path.extname(filePath).toLowerCase();

      // Decode Android Binary XML (.xml files with AXML magic bytes)
      if (!raw && ext === '.xml' && isAxmlBuffer(data)) {
        try {
          const decoded = decodeAxml(data);
          res.json({ success: true, data: { isText: true, isImage: false, size: data.length, content: decoded } });
          return;
        } catch { /* fall through to normal handling */ }
      }

      // Parse resources.arsc
      if (!raw && (ext === '.arsc' || filePath.endsWith('resources.arsc')) && isArscBuffer(data)) {
        try {
          const resources = parseArsc(data);
          const grouped: Record<string, ArscResource[]> = {};
          for (const r of resources) {
            if (!grouped[r.type]) grouped[r.type] = [];
            grouped[r.type].push(r);
          }
          const resourceTypes = Object.keys(grouped).sort();
          res.json({
            success: true,
            data: { isResourceTable: true, isText: false, isImage: false, size: data.length, resourceTypes, resources: grouped, totalCount: resources.length },
          });
          return;
        } catch { /* fall through to binary handler */ }
      }

      if (raw) {
        const basename = path.basename(filePath);
        const mime = mimeFromExt(ext);
        res.setHeader('Content-Type', mime);
        // If inline=true, serve for display (no Content-Disposition); otherwise force download
        if (req.query.inline !== 'true') {
          res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
        }
        if (IMAGE_EXTENSIONS.has(ext)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
        res.send(data);
        return;
      }

      // Detect text vs binary
      const isText = TEXT_EXTENSIONS.has(ext) || (ext === '' && looksLikeText(data));
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const MAX_TEXT_SIZE = 2 * 1024 * 1024; // 2MB

      if (isImage) {
        const imageUrl = `/v1/apps/analysis/${versionId}/assets/file?path=${encodeURIComponent(filePath)}${apkName ? `&apkName=${encodeURIComponent(apkName)}` : ''}&raw=true&inline=true`;
        const downloadUrl = `/v1/apps/analysis/${versionId}/assets/file?path=${encodeURIComponent(filePath)}${apkName ? `&apkName=${encodeURIComponent(apkName)}` : ''}&raw=true`;
        res.json({
          success: true,
          data: { isText: false, isImage: true, size: data.length, extension: ext, imageUrl, downloadUrl },
        });
      } else if (isText && data.length <= MAX_TEXT_SIZE) {
        res.json({
          success: true,
          data: { isText: true, isImage: false, size: data.length, content: data.toString('utf-8') },
        });
      } else {
        // Binary or too-large text
        const downloadUrl = `/v1/apps/analysis/${versionId}/assets/file?path=${encodeURIComponent(filePath)}${apkName ? `&apkName=${encodeURIComponent(apkName)}` : ''}&raw=true`;
        res.json({
          success: true,
          data: { isText: false, isImage: false, size: data.length, extension: ext, downloadUrl },
        });
      }
    } catch (err: any) {
      error(`Assets file failed for version ${versionId}, path=${filePath}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:read'] });

  // GET /v1/apps/analysis/:versionId/assets/search
  registerEndpoint('GET', '/v1/apps/analysis/:versionId/assets/search', async (req, res) => {
    const versionId = parseInt(req.params.versionId as string, 10);
    if (isNaN(versionId)) {
      res.status(400).json({ success: false, error: 'Invalid versionId' });
      return;
    }

    const query = req.query.q as string | undefined;
    if (!query) {
      res.status(400).json({ success: false, error: 'q query parameter is required' });
      return;
    }

    const caseSensitive = req.query.caseSensitive !== 'false';
    const useRegex = req.query.regex === 'true';

    const apkInfo = resolveApkPath(versionId);
    if (!apkInfo) {
      res.status(404).json({ success: false, error: 'APK version not found' });
      return;
    }

    try {
      // Load cached apk_contents entries (or generate them)
      const existing = db.select().from(apkContents)
        .where(eq(apkContents.apkVersionId, versionId))
        .all();

      let contentRows: Array<{ apkName: string; entries: Array<{ path: string; size: number }> }>;
      if (existing.length > 0) {
        contentRows = existing.map(row => ({
          apkName: row.apkName,
          entries: JSON.parse(row.entriesJson) as Array<{ path: string; size: number }>,
        }));
      } else {
        contentRows = await generateApkContents(versionId, apkInfo);
        if (contentRows.length === 0) {
          res.status(404).json({ success: false, error: 'APK file not found' });
          return;
        }
      }

      // Build regex
      const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = caseSensitive ? '' : 'i';
      let regex: RegExp;
      if (useRegex) {
        try {
          regex = new RegExp(query, flags);
        } catch {
          regex = new RegExp(escapeRegex(query), flags);
        }
      } else {
        regex = new RegExp(escapeRegex(query), flags);
      }

      const MAX_RESULTS = 200;
      const results: Array<{
        path: string;
        apkName: string;
        matchType: 'filename' | 'content';
        size: number;
        line?: number;
        content?: string;
        context?: string[];
      }> = [];
      let limited = false;

      // Ensure APK is on disk before opening ZIPs
      if (!fs.existsSync(apkInfo.apkPath)) {
        if (!fileSync) {
          res.status(404).json({ success: false, error: 'APK file not found' });
          return;
        }
        const cloudKey = apkCloudKey(apkInfo.packageName, apkInfo.filename);
        const acquired = await fileSync.acquireLocal(cloudKey, `assets-search-${versionId}`, apkInfo.apkPath);
        if (acquired.error) {
          res.status(404).json({ success: false, error: 'APK file not found' });
          return;
        }
      }

      // Cache open ZIP instances per apkName
      const zipCache = new Map<string, import('adm-zip')>();

      const getZip = (apkName: string): import('adm-zip') | null => {
        if (zipCache.has(apkName)) return zipCache.get(apkName)!;
        let zipPath: string;
        if (apkInfo.isSplit) {
          zipPath = path.join(apkInfo.apkPath, apkName);
        } else {
          zipPath = apkInfo.apkPath;
        }
        if (!fs.existsSync(zipPath)) return null;
        const zip = new AdmZip(zipPath);
        zipCache.set(apkName, zip);
        return zip;
      };

      // Phase 1 — filename match
      const filenameMatchedPaths = new Set<string>(); // key: `${apkName}::${entryPath}`

      for (const row of contentRows) {
        if (results.length >= MAX_RESULTS) {
          limited = true;
          break;
        }
        for (const entry of row.entries) {
          if (results.length >= MAX_RESULTS) {
            limited = true;
            break;
          }
          regex.lastIndex = 0;
          if (regex.test(entry.path)) {
            filenameMatchedPaths.add(`${row.apkName}::${entry.path}`);
            results.push({
              path: apkInfo.isSplit ? `${row.apkName}/${entry.path}` : entry.path,
              apkName: row.apkName,
              matchType: 'filename',
              size: entry.size,
            });
          }
        }
      }

      // Phase 2 — content search for non-filename-matched entries
      if (!limited) {
        const MAX_CONTENT_SIZE = 2 * 1024 * 1024; // 2MB

        outer: for (const row of contentRows) {
          for (const entry of row.entries) {
            if (results.length >= MAX_RESULTS) {
              limited = true;
              break outer;
            }

            // Skip already filename-matched
            if (filenameMatchedPaths.has(`${row.apkName}::${entry.path}`)) continue;

            // Skip empty or over-size files
            if (entry.size === 0 || entry.size > MAX_CONTENT_SIZE) continue;

            const zip = getZip(row.apkName);
            if (!zip) continue;

            const zipEntry = zip.getEntry(entry.path);
            if (!zipEntry) continue;

            let data: Buffer;
            try {
              data = zipEntry.getData();
            } catch {
              continue;
            }

            const ext = path.extname(entry.path).toLowerCase();

            let text: string;
            if (ext === '.xml' && isAxmlBuffer(data)) {
              // Binary XML — decode it
              try {
                text = decodeAxml(data);
              } catch {
                continue;
              }
            } else {
              // Check first 8KB for null bytes (binary detection)
              const probe = data.slice(0, 8192);
              if (probe.indexOf(0x00) !== -1) continue;
              text = data.toString('utf-8');
            }

            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0;
              if (regex.test(lines[i])) {
                const contextStart = Math.max(0, i - 1);
                const contextEnd = Math.min(lines.length - 1, i + 1);
                const context: string[] = [];
                for (let c = contextStart; c <= contextEnd; c++) {
                  context.push(lines[c]);
                }
                results.push({
                  path: apkInfo.isSplit ? `${row.apkName}/${entry.path}` : entry.path,
                  apkName: row.apkName,
                  matchType: 'content',
                  size: entry.size,
                  line: i + 1,
                  content: lines[i],
                  context,
                });
                break; // one match per file
              }
            }
          }
        }
      }

      res.json({
        success: true,
        data: {
          results,
          total: results.length,
          limited,
        },
      });
    } catch (err: any) {
      error(`Assets search failed for version ${versionId}: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.apk:read'] });
}
