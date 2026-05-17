CREATE TABLE IF NOT EXISTS apk_diff_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apk_version_id INTEGER NOT NULL REFERENCES apk_versions(id),
  compare_version_id INTEGER NOT NULL REFERENCES apk_versions(id),
  status TEXT NOT NULL DEFAULT 'pending',
  diff_json TEXT,
  ai_summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_apk_diff_reports_version ON apk_diff_reports(apk_version_id);
