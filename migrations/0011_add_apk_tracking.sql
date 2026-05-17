CREATE TABLE IF NOT EXISTS `tracked_apps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_name` text NOT NULL,
	`app_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tracked_apps_package_name_unique` ON `tracked_apps` (`package_name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `apk_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tracked_app_id` integer NOT NULL REFERENCES `tracked_apps`(`id`),
	`version_code` integer NOT NULL,
	`version_name` text,
	`filename` text NOT NULL,
	`file_size` integer,
	`device_id` text,
	`downloaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `apk_versions_tracked_app_id_idx` ON `apk_versions` (`tracked_app_id`);
