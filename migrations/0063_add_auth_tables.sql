CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`display_name` text,
	`password_hash` text,
	`password_updated_at` integer,
	`password_must_change` integer NOT NULL DEFAULT false,
	`provider_id` text NOT NULL,
	`external_id` text,
	`scopes` text NOT NULL DEFAULT '[]',
	`enabled` integer NOT NULL DEFAULT true,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer,
	`failed_login_attempts` integer NOT NULL DEFAULT 0,
	`locked_until` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_provider_external` ON `users` (`provider_id`, `external_id`) WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`provider_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	`ip_hash` text,
	`csrf_token` text NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`token_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `password_reset_tokens_token_hash_unique` ON `password_reset_tokens` (`token_hash`);
