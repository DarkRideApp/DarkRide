CREATE TABLE IF NOT EXISTS apk_contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apk_version_id INTEGER NOT NULL REFERENCES apk_versions(id),
  apk_name TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_apk_contents_version ON apk_contents(apk_version_id);
