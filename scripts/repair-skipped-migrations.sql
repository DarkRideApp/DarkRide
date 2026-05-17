-- One-time repair for DBs whose Drizzle migrator silently skipped 0068, 0074,
-- 0078, 0079, 0080 due to non-monotonic `when` values in the journal.
-- Run with: sqlite3 /path/to/darkride.db < scripts/repair-skipped-migrations.sql
-- This script is the always-safe portion. If `cloud_files.local_path` still
-- exists on the DB, also run scripts/repair-cloud-files-local-path.sql.

BEGIN;

-- 0079: unwrap double-encoded scope JSON. Safe to re-run — only updates rows
-- where the value is currently a JSON-encoded string (json_type = 'text').
UPDATE users
  SET scopes = json_extract(scopes, '$')
  WHERE json_valid(scopes) AND json_type(scopes) = 'text';

UPDATE api_keys
  SET scopes = json_extract(scopes, '$')
  WHERE json_valid(scopes) AND json_type(scopes) = 'text';

-- Mark the at-risk migrations as applied. Hashes are sha256 of each
-- migration's SQL file contents (matches the new migrator's hash function).
-- INSERT ... SELECT ... WHERE NOT EXISTS so re-running is safe even without
-- a UNIQUE constraint on the hash column (the real table has none).
INSERT INTO __drizzle_migrations (hash, created_at)
  SELECT '9575a69a014c777cf3656a69bf7a6451ca4ee214bb435ee88d711bb6189042a5', strftime('%s','now') * 1000
  WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE hash = '9575a69a014c777cf3656a69bf7a6451ca4ee214bb435ee88d711bb6189042a5');
INSERT INTO __drizzle_migrations (hash, created_at)
  SELECT 'bc80ed3278e160ca5cc11e9efcc002ad320acafcb8997278f463819794be2187', strftime('%s','now') * 1000
  WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE hash = 'bc80ed3278e160ca5cc11e9efcc002ad320acafcb8997278f463819794be2187');
INSERT INTO __drizzle_migrations (hash, created_at)
  SELECT '7b547295aadefa940bfdf82ca1f423873bf2e7711c1f1cbea0d063ac20597a37', strftime('%s','now') * 1000
  WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE hash = '7b547295aadefa940bfdf82ca1f423873bf2e7711c1f1cbea0d063ac20597a37');
INSERT INTO __drizzle_migrations (hash, created_at)
  SELECT '3088ed48e6c301000c60d743d07d544c388c9c389b9389935a6627f6a20143f2', strftime('%s','now') * 1000
  WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE hash = '3088ed48e6c301000c60d743d07d544c388c9c389b9389935a6627f6a20143f2');
INSERT INTO __drizzle_migrations (hash, created_at)
  SELECT '357283637dfaa52cdffb1ce430858889a71eaea9db9a4a97385a1ffe9d521f51', strftime('%s','now') * 1000
  WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE hash = '357283637dfaa52cdffb1ce430858889a71eaea9db9a4a97385a1ffe9d521f51');

COMMIT;
