CREATE TABLE IF NOT EXISTS trusted_signing_keys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  label TEXT NOT NULL,
  built_in INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER,
  created_at INTEGER
);
--> statement-breakpoint
INSERT INTO trusted_signing_keys (id, public_key, label, built_in, created_at)
VALUES ('darkride-official', 'MCowBQYDK2VwAyEAhYfjgsV0gzpQbh/Jxr22CvOb01svQdbmdZ39zDze0qM=', 'DarkRide Official', 1, strftime('%s', 'now'));
--> statement-breakpoint
ALTER TABLE plugin_state ADD COLUMN signature TEXT;
--> statement-breakpoint
ALTER TABLE plugin_state ADD COLUMN signed_by TEXT;
