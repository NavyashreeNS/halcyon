import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseOptions {
  connectionString: string;
  /**
   * Pool size. The right value is bounded by Postgres, not by the app: every connection is
   * a backend process, so a fleet of ten gateways at 20 connections each will exhaust a
   * default `max_connections` of 100 long before the application is the bottleneck.
   */
  maxConnections?: number;
  /** Fail fast rather than letting a request hang on a saturated pool. */
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
}

export function createDatabase(options: DatabaseOptions): {
  db: Database;
  close: () => Promise<void>;
} {
  const sql = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    // The control plane serialises its own JSON payloads; letting the driver transform
    // column names as well would mean two naming conventions in one round trip.
    transform: { undefined: null },
    onnotice: () => {},
  });

  return {
    db: drizzle(sql, { schema }),
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export * as schema from './schema.js';
