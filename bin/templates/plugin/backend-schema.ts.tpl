import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Define your plugin's database tables here.
// Use the naming convention: plugin_{{slug_underscore}}__tablename
//
// Example:
// export const items = sqliteTable('plugin_{{slug_underscore}}__items', {
//   id: integer('id').primaryKey({ autoIncrement: true }),
//   title: text('title').notNull(),
//   createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
// });
