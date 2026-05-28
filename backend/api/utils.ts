import { statSync, readdirSync } from 'fs';
import path from 'path';
import { gte, desc, sql } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import type { AppDatabase } from '../db/index';
import { dbSizeSnapshots, diskUsageSnapshots } from '../db/schema';

const TABLE_LABELS: Record<string, string> = {
  captured_traffic: 'Traffic',
  screenshots: 'Screenshots',
  websocket_messages: 'WebSocket Messages',
  ai_conversations: 'AI Conversations',
  automation_sessions: 'Automation Sessions',
  automations: 'Automations',
  saved_traffic: 'Saved Traffic',
  apk_versions: 'APK Versions',
  analysis_jobs: 'Analysis Jobs',
  injected_apks: 'Injected APKs',
  tracked_apps: 'Tracked Apps',
  frida_scripts: 'Frida Scripts',
  frida_releases: 'Frida Releases',
  cloud_files: 'Cloud Files',
  cloud_file_locks: 'Cloud Locks',
  db_size_snapshots: 'Size Snapshots',
  credentials: 'Credentials',
  blocked_domains: 'Blocked Domains',
  hidden_domains: 'Hidden Domains',
  settings: 'Settings',
  devices: 'Devices',
  proxies: 'Proxies',
};

function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else {
        try {
          total += statSync(fullPath).size;
        } catch {
          // skip inaccessible files
        }
      }
    }
  } catch {
    // directory doesn't exist or not readable
  }
  return total;
}

export function registerUtilsEndpoints(dbPath: string, db: AppDatabase): void {
  registerEndpoint('GET', '/v1/utils/info', (_req, res) => {
    try {
      const stats = statSync(dbPath);
      res.json({ success: true, data: { dbSizeBytes: stats.size } });
    } catch {
      res.json({ success: true, data: { dbSizeBytes: 0 } });
    }
  });

  registerEndpoint('GET', '/v1/utils/db-size-history', (_req, res) => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const rows = db
      .select({
        sizeBytes: dbSizeSnapshots.sizeBytes,
        capturedAt: dbSizeSnapshots.capturedAt,
      })
      .from(dbSizeSnapshots)
      .where(gte(dbSizeSnapshots.capturedAt, sixtyDaysAgo))
      .orderBy(dbSizeSnapshots.capturedAt)
      .all();

    res.json({ success: true, data: rows });
  });

  registerEndpoint('GET', '/v1/utils/table-sizes', (_req, res) => {
    try {
      // Get per-table sizes via dbstat virtual table
      const sizes = db.all<{ name: string; size: number }>(
        sql`SELECT name, SUM(pgsize) as size FROM dbstat WHERE name NOT LIKE 'sqlite_%' GROUP BY name ORDER BY size DESC`,
      );

      // Get row counts for each table
      const tables = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%'`,
      );
      const rowCounts = new Map<string, number>();
      // Identifier regex: SQLite table names, allowlist to defend against any
      // edge case where sqlite_master returns an unusual identifier. In practice
      // the outer query filters system tables, but raw SQL with interpolation
      // warrants a guard.
      const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
      for (const t of tables) {
        if (!SAFE_IDENT.test(t.name)) continue;
        try {
          // Name is from sqlite_master (not user input) AND matches SAFE_IDENT.
          // sql.raw is used because drizzle doesn't expose a dynamic-table helper.
          const row = db.get<{ count: number }>(sql.raw(`SELECT COUNT(*) as count FROM "${t.name}"`));
          if (row) rowCounts.set(t.name, row.count);
        } catch {
          // skip tables that can't be queried
        }
      }

      const totalSize = sizes.reduce((sum, s) => sum + s.size, 0);

      const data = sizes
        .filter(s => !s.name.startsWith('__drizzle'))
        .map(s => ({
          name: TABLE_LABELS[s.name] || s.name,
          tableName: s.name,
          sizeBytes: s.size,
          rowCount: rowCounts.get(s.name) ?? 0,
          percentage: totalSize > 0 ? Number(((s.size / totalSize) * 100).toFixed(1)) : 0,
        }));

      res.json({ success: true, data });
    } catch (err: any) {
      res.json({ success: false, error: err.message });
    }
  });

  registerEndpoint('GET', '/v1/utils/map-tile-size', (_req, res) => {
    const mapTileDir = path.resolve('./data/plugins/maps');
    const sizeBytes = getDirSize(mapTileDir);
    res.json({ success: true, data: { sizeBytes } });
  });

  registerEndpoint('GET', '/v1/utils/disk-usage', (_req, res) => {
    const row = db
      .select()
      .from(diskUsageSnapshots)
      .orderBy(desc(diskUsageSnapshots.capturedAt))
      .limit(1)
      .all()[0];

    if (!row) {
      res.json({ success: true, data: null });
      return;
    }

    // dirSizes is a notNull json column (Record<string, number>); ?? {} guards
    // only against malformed legacy rows, no cast needed.
    const dirSizes = row.dirSizes ?? {};
    const dirs = Object.entries(dirSizes)
      .map(([name, sizeBytes]) => ({ name, sizeBytes }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    res.json({
      success: true,
      data: {
        capturedAt: row.capturedAt,
        volumeTotalBytes: row.volumeTotalBytes,
        volumeFreeBytes: row.volumeFreeBytes,
        volumeUsedBytes: row.volumeTotalBytes - row.volumeFreeBytes,
        dirs,
      },
    });
  });

  registerEndpoint('GET', '/v1/utils/disk-usage-history', (_req, res) => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const rows = db
      .select({
        volumeTotalBytes: diskUsageSnapshots.volumeTotalBytes,
        volumeFreeBytes: diskUsageSnapshots.volumeFreeBytes,
        capturedAt: diskUsageSnapshots.capturedAt,
      })
      .from(diskUsageSnapshots)
      .where(gte(diskUsageSnapshots.capturedAt, sixtyDaysAgo))
      .orderBy(diskUsageSnapshots.capturedAt)
      .all();

    const data = rows.map(r => ({
      usedBytes: r.volumeTotalBytes - r.volumeFreeBytes,
      capturedAt: r.capturedAt,
    }));

    res.json({ success: true, data });
  });

  registerEndpoint('GET', '/v1/utils/backup', (_req, res) => {
    res.download(dbPath, 'darkride.db');
  }, { requires: ['core.system:backup'] });
}
