ALTER TABLE captured_traffic ADD COLUMN hostname TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_captured_traffic_hostname ON captured_traffic(hostname);