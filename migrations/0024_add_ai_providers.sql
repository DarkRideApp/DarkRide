CREATE TABLE IF NOT EXISTS `ai_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`api_key` text,
	`base_url` text,
	`oauth_access_token` text,
	`oauth_refresh_token` text,
	`oauth_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_models` ADD COLUMN `provider_id` integer REFERENCES ai_providers(id);
