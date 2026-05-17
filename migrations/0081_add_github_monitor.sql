CREATE TABLE github_monitor_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  display_name TEXT,
  preset TEXT NOT NULL,
  watch_commits INTEGER NOT NULL DEFAULT 0,
  watch_releases INTEGER NOT NULL DEFAULT 0,
  watch_prs INTEGER NOT NULL DEFAULT 0,
  watch_issues INTEGER NOT NULL DEFAULT 0,
  branches TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT 'daily',
  prompt TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  last_success_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX github_monitor_repos_owner_repo_unique ON github_monitor_repos (owner, repo);
--> statement-breakpoint
CREATE TABLE github_monitor_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES github_monitor_repos(id) ON DELETE CASCADE,
  generated_at INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  headline TEXT NOT NULL,
  summary_markdown TEXT NOT NULL,
  render_style TEXT NOT NULL,
  raw_items TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  token_usage TEXT
);
--> statement-breakpoint
CREATE INDEX github_monitor_reports_repo_generated ON github_monitor_reports (repo_id, generated_at);
--> statement-breakpoint
CREATE INDEX github_monitor_reports_read_at ON github_monitor_reports (read_at);
