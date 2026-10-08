CREATE TABLE IF NOT EXISTS ai_call_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES ai_call_log(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  model TEXT,
  provider_type TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  fallbacks TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_call_request_call_seq_idx
  ON ai_call_request(call_id, seq);
--> statement-breakpoint
ALTER TABLE ai_call_log ADD COLUMN tool_calls INTEGER;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_call_log_started_idx
  ON ai_call_log(started_at DESC);
