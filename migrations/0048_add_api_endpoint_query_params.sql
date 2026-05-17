CREATE TABLE IF NOT EXISTS `api_endpoint_query_params` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL REFERENCES `api_endpoints`(`id`) ON DELETE CASCADE,
	`param_name` text NOT NULL,
	`sample_values` text NOT NULL DEFAULT '[]',
	`occurrence_count` integer NOT NULL DEFAULT 1,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_endpoint_query_params_unique` ON `api_endpoint_query_params` (`endpoint_id`, `param_name`);
