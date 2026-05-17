CREATE TABLE IF NOT EXISTS plugin_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_token TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
--> statement-breakpoint
INSERT INTO plugin_sources (name, type, url, enabled, is_default, priority, created_at, updated_at)
VALUES ('DarkRide Official', 'registry', 'https://darkride.app/plugins.json', 1, 1, 0, strftime('%s', 'now'), strftime('%s', 'now'));
