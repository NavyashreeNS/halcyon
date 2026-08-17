import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://halcyon:halcyon@localhost:5432/halcyon',
  },
  strict: true,
  verbose: true,
} satisfies Config;
