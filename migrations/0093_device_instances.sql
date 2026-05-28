CREATE TABLE `device_instances` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `provider_id` text NOT NULL,
  `runtime_id` text NOT NULL,
  `display_name` text,
  `serial` text,
  `state` text NOT NULL,
  `spawned_by_darkride` integer DEFAULT 0 NOT NULL,
  `spawn_metadata` text,
  `last_error` text,
  `created_at` integer NOT NULL,
  `last_state_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_instance_config` (
  `instance_id` integer NOT NULL,
  `key` text NOT NULL,
  `value` text NOT NULL,
  PRIMARY KEY(`instance_id`, `key`),
  FOREIGN KEY (`instance_id`) REFERENCES `device_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `devices` ADD COLUMN `instance_id` integer REFERENCES `device_instances`(`id`);
