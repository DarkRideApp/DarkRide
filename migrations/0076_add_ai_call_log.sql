CREATE TABLE ai_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  identity_type TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  on_behalf_of_plugin TEXT,
  on_behalf_of_service TEXT,
  acting_for_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  effective_scopes TEXT NOT NULL DEFAULT '[]',
  page_context TEXT,
  context_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  turns INTEGER,
  cost_usd REAL,
  outcome TEXT,
  error TEXT
);
--> statement-breakpoint
CREATE INDEX ai_call_log_actor_started_idx
  ON ai_call_log(actor_user_id, started_at DESC);
--> statement-breakpoint
CREATE INDEX ai_call_log_plugin_started_idx
  ON ai_call_log(on_behalf_of_plugin, started_at DESC);
