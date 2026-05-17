CREATE TABLE IF NOT EXISTS `api_endpoint_group_patterns` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `group_id` integer NOT NULL REFERENCES `api_endpoint_groups`(`id`),
  `pattern` text NOT NULL,
  `pattern_type` text NOT NULL DEFAULT 'exact',
  `created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_endpoint_group_patterns_group_id_pattern_unique` ON `api_endpoint_group_patterns` (`group_id`, `pattern`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_endpoint_group_patterns_group_id_idx` ON `api_endpoint_group_patterns` (`group_id`);
