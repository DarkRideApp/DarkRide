-- Normalized per-app fetch sources. Replaces the single `auto_fetch_play_store`
-- boolean on `tracked_apps`: each remote store an app can be fetched from
-- (Play Store, QQ / 应用宝, future Amazon, …) gets its own row with an
-- independent `enabled` flag + dedup state, so one app can live on several
-- stores at once. Device pulls are NOT modelled here — they happen
-- automatically whenever the package is installed on a connected device.
CREATE TABLE `app_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tracked_app_id` integer NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`last_version` text,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tracked_app_id`) REFERENCES `tracked_apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_sources_app_source` ON `app_sources` (`tracked_app_id`,`source`);
--> statement-breakpoint
-- Backfill: carry each app's existing Play Store enablement + last-seen
-- version into a `playstore` row. COALESCE preserves the old default (true).
-- created_at is epoch SECONDS to match Drizzle's `mode: 'timestamp'`.
INSERT INTO `app_sources` (`tracked_app_id`, `source`, `enabled`, `last_version`, `created_at`)
SELECT `id`, 'playstore', COALESCE(`auto_fetch_play_store`, 1), `last_play_store_version`, strftime('%s','now')
FROM `tracked_apps`;
--> statement-breakpoint
-- Drop the now-redundant single-source columns. SQLite 3.35+ supports
-- DROP COLUMN directly; id / created_at and all FKs are preserved.
ALTER TABLE `tracked_apps` DROP COLUMN `auto_fetch_play_store`;
--> statement-breakpoint
ALTER TABLE `tracked_apps` DROP COLUMN `last_play_store_version`;
