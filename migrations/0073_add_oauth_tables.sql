CREATE TABLE `oauth_clients` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `client_id` text NOT NULL,
  `client_name` text NOT NULL,
  `redirect_uris` text NOT NULL,
  `grant_types` text NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  `response_types` text NOT NULL DEFAULT '["code"]',
  `token_endpoint_auth_method` text NOT NULL DEFAULT 'none',
  `software_id` text,
  `software_version` text,
  `created_at` integer NOT NULL,
  `last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_clients_client_id` ON `oauth_clients` (`client_id`);
--> statement-breakpoint
CREATE TABLE `oauth_authorization_codes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code_hash` text NOT NULL,
  `client_id` text NOT NULL,
  `user_id` integer NOT NULL,
  `scopes` text NOT NULL,
  `redirect_uri` text NOT NULL,
  `code_challenge` text NOT NULL,
  `code_challenge_method` text NOT NULL,
  `expires_at` integer NOT NULL,
  `redeemed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_auth_codes_code_hash` ON `oauth_authorization_codes` (`code_hash`);
--> statement-breakpoint
CREATE TABLE `oauth_access_tokens` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `token_hash` text NOT NULL,
  `token_prefix` text NOT NULL,
  `client_id` text NOT NULL,
  `user_id` integer NOT NULL,
  `scopes` text NOT NULL,
  `refresh_token_id` integer,
  `issued_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `last_used_at` integer,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_at_token_hash` ON `oauth_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_at_user_client` ON `oauth_access_tokens` (`user_id`, `client_id`);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `token_hash` text NOT NULL,
  `client_id` text NOT NULL,
  `user_id` integer NOT NULL,
  `scopes` text NOT NULL,
  `expires_at` integer NOT NULL,
  `issued_at` integer NOT NULL,
  `rotated_from_id` integer,
  `revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_rt_token_hash` ON `oauth_refresh_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_oauth_rt_user_client` ON `oauth_refresh_tokens` (`user_id`, `client_id`);
