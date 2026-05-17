CREATE TABLE plugin_migrations (
  plugin_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_name, filename)
);
