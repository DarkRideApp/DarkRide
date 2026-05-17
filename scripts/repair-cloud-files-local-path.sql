-- Run ONLY if cloud_files.local_path still exists.
-- Check with: sqlite3 /path/to/darkride.db "SELECT name FROM pragma_table_info('cloud_files') WHERE name = 'local_path'"
-- If output is empty, this script is unnecessary.
-- If output is `local_path`, run with:
--   sqlite3 /path/to/darkride.db < scripts/repair-cloud-files-local-path.sql

BEGIN;

-- 0078: strip absolute path prefix from cloud_files.local_path so it becomes
-- DATA_ROOT-relative. No-op on rows that are already relative.
UPDATE cloud_files
  SET local_path = substr(local_path, instr(local_path, '/data/') + 6)
  WHERE local_path LIKE '%/data/%' AND substr(local_path, 1, 1) = '/';

-- 0080: copy local_path into relative_path for any rows that haven't been
-- migrated yet (relative_path empty), then drop the local_path column.
UPDATE cloud_files
  SET relative_path = local_path
  WHERE relative_path = '' OR relative_path IS NULL;

ALTER TABLE cloud_files DROP COLUMN local_path;

COMMIT;
