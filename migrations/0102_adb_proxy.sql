CREATE TABLE IF NOT EXISTS adb_proxy_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved', 'denied', 'revoked')),
  device_ids TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_seen_ip TEXT,
  last_device_id TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS adb_proxy_devices (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  port INTEGER NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
