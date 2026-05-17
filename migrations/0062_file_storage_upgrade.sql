ALTER TABLE `cloud_files` ADD COLUMN `namespace` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `cloud_files` ADD COLUMN `relative_path` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `cloud_files` ADD COLUMN `retain` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cloud_files_namespace` ON `cloud_files` (`namespace`);
--> statement-breakpoint
DROP TABLE IF EXISTS `cloud_file_locks`;
