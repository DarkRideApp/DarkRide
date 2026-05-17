ALTER TABLE captured_traffic ADD COLUMN type TEXT DEFAULT 'http';
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN ws_close_code INTEGER;
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN ws_close_reason TEXT;
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN ws_message_count INTEGER DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS websocket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  traffic_id INTEGER REFERENCES captured_traffic(id),
  session_id INTEGER REFERENCES automation_sessions(id),
  device_id TEXT REFERENCES devices(id),
  direction TEXT NOT NULL,
  opcode TEXT NOT NULL,
  payload TEXT,
  is_binary INTEGER DEFAULT 0,
  payload_size INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ws_messages_traffic_id ON websocket_messages(traffic_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ws_messages_session_id ON websocket_messages(session_id);
