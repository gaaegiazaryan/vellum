import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as authSchema from './schema/auth';

/**
 * Single Drizzle client for the web app. The web side only needs the
 * auth tables today; lazy-init keeps the connection out of the bundle
 * at build time when DATABASE_URL is intentionally unset.
 */

const schema = { ...authSchema };
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
