CREATE TABLE IF NOT EXISTS `intercept_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`match_hostname` text NOT NULL,
	`match_path` text,
	`match_method` text,
	`phase` text NOT NULL,
	`actions` text NOT NULL,
	`device_filter` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`session_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `client_certs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`hostnames` text NOT NULL,
	`cert_pem` text NOT NULL,
	`key_pem` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`session_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `captured_traffic` ADD COLUMN `matched_rules` text;
