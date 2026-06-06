-- Managed automations framework: plugins can declare automations they own,
-- the host stamps provenance + 3-way merge slots on the automation row, and
-- the runner / scheduler / sessions reuse the existing engine unchanged
-- (managed is just "managed_by IS NOT NULL"). See docs/superpowers/specs/
-- 2026-06-06-managed-automations-framework-design.md.

ALTER TABLE `automations` ADD `managed_by` text;
--> statement-breakpoint
ALTER TABLE `automations` ADD `managed_key` text;
--> statement-breakpoint
ALTER TABLE `automations` ADD `current_default_code` text;
--> statement-breakpoint
ALTER TABLE `automations` ADD `base_default_code` text;
--> statement-breakpoint
ALTER TABLE `automations` ADD `is_overridden` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `automations` ADD `allow_user_override` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Managed runs do NOT fire the standard automation:failure notification
-- event by default — the operator didn't author the script and most
-- plugins surface health in their own UI. Plugins opt in by setting
-- emitFailureNotification: true on the declared entry.
ALTER TABLE `automations` ADD `emit_failure_notification` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Unique per (plugin, script-key). NULL/NULL pairs are distinct in SQLite, so
-- this only constrains managed rows; ordinary automations stay unaffected.
CREATE UNIQUE INDEX `automations_managed_by_managed_key_unique`
  ON `automations` (`managed_by`, `managed_key`)
  WHERE `managed_by` IS NOT NULL;
--> statement-breakpoint
-- Denormalised at session creation from automation.managed_by IS NOT NULL so
-- the session-history filter is a plain column scan with no join — important
-- for the default "managed = 0" view that hides plugin-driven traffic from
-- the operator's session feed.
ALTER TABLE `automation_sessions` ADD `managed` integer DEFAULT 0 NOT NULL;
