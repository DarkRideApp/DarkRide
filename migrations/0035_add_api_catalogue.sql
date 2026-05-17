CREATE TABLE IF NOT EXISTS `api_endpoint_groups` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_endpoint_groups_name_unique` ON `api_endpoint_groups` (`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_endpoints` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `method` text NOT NULL,
  `hostname` text NOT NULL,
  `path_pattern` text NOT NULL,
  `first_seen` integer NOT NULL,
  `last_seen` integer NOT NULL,
  `request_count` integer DEFAULT 1,
  `sample_request_headers` text,
  `sample_request_body` text,
  `sample_response_status` integer,
  `sample_response_headers` text,
  `sample_response_body` text,
  `group_id` integer REFERENCES `api_endpoint_groups`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_endpoints_method_hostname_path_pattern_unique` ON `api_endpoints` (`method`, `hostname`, `path_pattern`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_endpoints_hostname_idx` ON `api_endpoints` (`hostname`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_endpoints_group_id_idx` ON `api_endpoints` (`group_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_endpoints_last_seen_idx` ON `api_endpoints` (`last_seen`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_endpoint_sessions` (
  `endpoint_id` integer NOT NULL REFERENCES `api_endpoints`(`id`),
  `session_id` integer NOT NULL REFERENCES `automation_sessions`(`id`),
  PRIMARY KEY (`endpoint_id`, `session_id`)
);
