CREATE TABLE IF NOT EXISTS ai_pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_pipeline_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  UNIQUE(pipeline_id, version)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_version_id INTEGER NOT NULL REFERENCES ai_pipeline_versions(id) ON DELETE CASCADE,
  trigger_node_id TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  input TEXT,
  reuse_unchanged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_pipeline_node_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES ai_pipeline_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  input_hash TEXT,
  was_memoized INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  error TEXT,
  model_used TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_pipeline_node_runs_run_idx ON ai_pipeline_node_runs(run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_pipeline_node_runs_memo_idx ON ai_pipeline_node_runs(node_id, input_hash);
