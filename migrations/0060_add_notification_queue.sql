CREATE TABLE IF NOT EXISTS `notification_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
