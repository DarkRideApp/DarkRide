-- Managed automations gain a "revert schedule/enabled to plugin default"
-- affordance in the SDK IDE component. To support that, we keep snapshots
-- of what the plugin currently ships alongside the operator-owned values.
-- Both are refreshed by the reconciler on every plugin load; neither
-- column ever touches the actual `schedule` / `enabled` columns that the
-- scheduler reads.

ALTER TABLE `automations` ADD `current_default_schedule` text;
--> statement-breakpoint
ALTER TABLE `automations` ADD `current_default_enabled` integer;
