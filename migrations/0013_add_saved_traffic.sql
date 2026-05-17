CREATE TABLE IF NOT EXISTS `saved_traffic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`method` text NOT NULL,
	`request_headers` text,
	`request_body` text,
	`response_status` integer,
	`response_headers` text,
	`response_body` text,
	`device_id` text,
	`saved_at` integer NOT NULL
);
