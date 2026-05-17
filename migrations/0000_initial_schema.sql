CREATE TABLE IF NOT EXISTS `proxies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`username` text,
	`password` text,
	`failure_count` integer DEFAULT 0,
	`enabled` integer DEFAULT true,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`is_rooted` integer DEFAULT false,
	`setup_version` integer DEFAULT 0,
	`bridge_port` integer,
	`last_seen` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`passcode` text NOT NULL,
	`requires_https_capture` integer DEFAULT false,
	`timeout_ms` integer DEFAULT 300000,
	`is_rule` integer DEFAULT false,
	`priority` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `automation_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` integer REFERENCES `automations`(`id`),
	`device_id` text REFERENCES `devices`(`id`),
	`status` text NOT NULL,
	`trigger_type` text NOT NULL,
	`logs` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `screenshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer REFERENCES `automation_sessions`(`id`),
	`filename` text NOT NULL,
	`name` text,
	`dom_snapshot` text,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `captured_traffic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer REFERENCES `automation_sessions`(`id`),
	`device_id` text REFERENCES `devices`(`id`),
	`request_method` text NOT NULL,
	`request_url` text NOT NULL,
	`request_headers` text,
	`request_body` text,
	`response_status` integer,
	`response_body` text,
	`captured_at` integer NOT NULL
);
