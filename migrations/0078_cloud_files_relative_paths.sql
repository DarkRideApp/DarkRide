-- Make cloud_files.local_path relative to DATA_ROOT by stripping any
-- absolute prefix up to and including the `/data/` segment. This normalises
-- rows written before the relative-paths refactor, including pre-rename
-- /opt/phonehub/data/... values.
UPDATE cloud_files
SET local_path = substr(local_path, instr(local_path, '/data/') + 6)
WHERE local_path LIKE '%/data/%' AND substr(local_path, 1, 1) = '/';
