ALTER TABLE tracked_apps ADD COLUMN auto_fetch_play_store INTEGER DEFAULT 1;
--> statement-breakpoint
ALTER TABLE apk_versions ADD COLUMN source TEXT DEFAULT 'device';
