CREATE TABLE IF NOT EXISTS `apk_notes` (
  `version_id` integer PRIMARY KEY NOT NULL,
  `content` text NOT NULL DEFAULT '',
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`version_id`) REFERENCES `apk_versions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD COLUMN `skip_ai_review` integer NOT NULL DEFAULT 0;
