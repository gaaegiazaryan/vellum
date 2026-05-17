import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as authSchema from './schema/auth';
import * as credentialsSchema from './schema/credentials';

/**
 * Single Drizzle client for the web app. Lazy-init keeps the connection
 * out of the bundle at build time when DATABASE_URL is intentionally
 * unset.
 */

const schema = { ...authSchema, ...credentialsSchema };
export type WebDb = PostgresJsDatabase<typeof schema>;

let cached: { db: WebDb; close: () => Promise<void> } | null = null;

export function getDb(): WebDb {
  if (cached) return cached.db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required at runtime; set it in the deploy environment');
  }
  const client = postgres(url, { max: 5, idle_timeout: 30, connect_timeout: 10 });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  cached = {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
  return db;
}
