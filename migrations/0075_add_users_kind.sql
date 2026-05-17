ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN service_owner TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX users_kind_service_owner_idx
  ON users(kind, service_owner)
  WHERE kind != 'human';
--> statement-breakpoint
CREATE INDEX users_kind_idx ON users(kind);
