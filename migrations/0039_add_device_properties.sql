ALTER TABLE devices ADD COLUMN manufacturer TEXT;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN model TEXT;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN android_version TEXT;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN api_level INTEGER;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN cpu_abi TEXT;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN serial_number TEXT;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN bootloader_locked INTEGER;
