-- Per-request timing for captured traffic. `duration_ms` is the end-to-end
-- latency (request start → response end) forwarded from the mitmproxy flow;
-- `timings` holds a JSON breakdown {dns,connect,tls,ttfb,download} in ms with
-- each segment nullable. Both are null for existing rows and for synthetic
-- entries (DNS lookups, TLS_FAIL) that carry no real response timing.
ALTER TABLE captured_traffic ADD COLUMN duration_ms integer;
--> statement-breakpoint
ALTER TABLE captured_traffic ADD COLUMN timings text;
