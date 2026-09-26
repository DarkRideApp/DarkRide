-- Stored classification for the Traffic table's deep filters, so
-- GET /v1/traffic/list can filter content type, response size and the
-- GQL/PROTO method pills in SQL instead of loading every row into memory.
-- Values come from shared/lib/traffic-classify.ts (the same code the frontend
-- uses), written at insert time. Existing rows start NULL and are filled by
-- the startup backfill in backend/services/traffic-filter-backfill.ts.
ALTER TABLE captured_traffic ADD COLUMN response_category text;
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN response_size_bytes integer;
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN is_graphql integer;
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN is_protobuf integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_captured_traffic_response_category ON captured_traffic(response_category);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_captured_traffic_response_size_bytes ON captured_traffic(response_size_bytes);
