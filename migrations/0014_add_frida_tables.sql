CREATE TABLE IF NOT EXISTS `frida_scripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`target_app` text,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `frida_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`download_url` text NOT NULL,
	`release_date` integer,
	`is_downloaded` integer DEFAULT false,
	`file_size` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `frida_releases_version_unique` ON `frida_releases` (`version`);
--> statement-breakpoint
ALTER TABLE `devices` ADD COLUMN `frida_version` text;
