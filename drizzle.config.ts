import type { Config } from 'drizzle-kit';

const dbPath = process.env.DATABASE_PATH || './data/darkride.db';

export default {
  schema: './backend/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
} satisfies Config;
