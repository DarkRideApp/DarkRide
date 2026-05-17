ALTER TABLE job_config ADD COLUMN last_run_at INTEGER;
--> statement-breakpoint
ALTER TABLE job_config ADD COLUMN last_error TEXT;
