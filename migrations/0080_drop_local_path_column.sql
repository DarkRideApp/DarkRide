-- Drop cloud_files.local_path and use relative_path as the sole
-- DATA_ROOT-relative path column.
--
-- Context:
--   Migration 0078 made local_path a DATA_ROOT-relative path for all rows.
--   The relative_path column (added earlier for plugin namespaced storage)
--   was redundant — populated only for namespaced rows and storing a
--   namespace-relative subpath rather than a DATA_ROOT-relative one.
--
-- Here we:
--   1. Redefine relative_path as "DATA_ROOT-relative" for ALL rows by
--      copying local_path into it wholesale.
--   2. Drop local_path.
--
-- After this migration, resolving an absolute on-disk path is:
--   join(DATA_ROOT, row.relative_path)
-- regardless of whether the row is namespaced or legacy.
UPDATE cloud_files SET relative_path = local_path;
--> statement-breakpoint
ALTER TABLE cloud_files DROP COLUMN local_path;
