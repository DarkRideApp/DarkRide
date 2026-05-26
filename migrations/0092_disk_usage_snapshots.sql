CREATE TABLE disk_usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  captured_at INTEGER NOT NULL,
  volume_total_bytes INTEGER NOT NULL,
  volume_free_bytes INTEGER NOT NULL,
  dir_sizes TEXT NOT NULL
);
