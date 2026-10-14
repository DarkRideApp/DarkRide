CREATE TABLE IF NOT EXISTS automation_authors (
  automation_id INTEGER PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
