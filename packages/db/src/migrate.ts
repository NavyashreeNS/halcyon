/**
 * Applies pending SQL migrations, then exits.
 *
 * Run as an init container / release-phase command rather than at service boot: migrating
 * from inside the application means N replicas racing to take the same locks during a
 * rolling deploy, and a failed migration takes the fleet down with it.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDatabase } from './client.js';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../migrations');

const { db, close } = createDatabase({ connectionString, maxConnections: 1 });

try {
  await migrate(db, { migrationsFolder });
  console.log(`Migrations applied from ${migrationsFolder}`);
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await close();
}
