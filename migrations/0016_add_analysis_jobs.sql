CREATE TABLE IF NOT EXISTS `analysis_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`apk_version_id` integer NOT NULL REFERENCES `apk_versions`(`id`),
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
