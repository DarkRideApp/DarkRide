CREATE TABLE IF NOT EXISTS plugin_state (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_via TEXT NOT NULL DEFAULT 'workspace',
  version TEXT,
  description TEXT,
  author TEXT,
  npm_package TEXT,
  installed_at INTEGER,
  updated_at INTEGER
);
