CREATE TABLE IF NOT EXISTS `notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true,
	`events` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notification_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer REFERENCES `notification_channels`(`id`),
	`channel_name` text NOT NULL,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`source_type` text,
	`source_id` text,
	`success` integer DEFAULT true,
	`error` text,
	`created_at` integer NOT NULL
);