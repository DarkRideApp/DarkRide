CREATE TABLE IF NOT EXISTS `cloud_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cloud_key` text NOT NULL,
	`local_path` text NOT NULL,
	`file_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`sync_state` text NOT NULL,
	`sync_error` text,
	`last_accessed` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `cloud_files_cloud_key_unique` ON `cloud_files` (`cloud_key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cloud_file_locks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cloud_file_id` integer NOT NULL REFERENCES `cloud_files`(`id`),
	`holder` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
