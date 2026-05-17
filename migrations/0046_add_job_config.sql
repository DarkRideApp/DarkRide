CREATE TABLE IF NOT EXISTS `job_config` (
	`job_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true,
	`schedule` text,
	`updated_at` integer NOT NULL
);