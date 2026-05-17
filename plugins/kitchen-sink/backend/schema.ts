import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const kitchenSinkItems = sqliteTable('plugin_kitchen_sink__items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
