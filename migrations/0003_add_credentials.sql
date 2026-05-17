CREATE TABLE IF NOT EXISTS `credentials` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `app_id` text NOT NULL,
  `username` text NOT NULL,
  `password` text NOT NULL,
  `custom_fields` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_used_at` integer
);
