ALTER TABLE frida_releases ADD COLUMN gadget_download_url TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS injected_apks (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  tracked_app_id INTEGER REFERENCES tracked_apps(id),
  package_name TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  version_name TEXT,
  frida_version TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_size INTEGER,
  created_at INTEGER NOT NULL
);
