CREATE TABLE plugin_installs (
  name TEXT PRIMARY KEY NOT NULL,
  npm_package TEXT NOT NULL,
  source_url TEXT NOT NULL,
  resolved_ref TEXT,
  source_id INTEGER,
  installed_at INTEGER NOT NULL
);
