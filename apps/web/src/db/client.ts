import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import postgres from 'postgres';
import * as authSchema from './schema/auth';
import * as credentialsSchema from './schema/credentials';

/**
 * Single Drizzle client for the web app. Lazy: a real client is only
 * constructed on first call. During next build's page-data collection
 * DrizzleAdapter(getDb(), ...) runs at module top level and inspects
 * the returned db's shape, so an env-missing throw there would crash
 * the build. Instead, in the build phase we hand back a real Drizzle
 * wrapping a postgres-js client that never connects (postgres-js is
 * itself lazy). Runtime keeps the loud "DATABASE_URL is required"
 * error when the env is actually missing.
 */

const schema = { ...authSchema, ...credentialsSchema };
export type WebDb = PostgresJsDatabase<typeof schema>;

let cached: { db: WebDb; close: () => Promise<void> } | null = null;

export function getDb(): WebDb {
  if (cached) return cached.db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
      return drizzle(postgres('postgres://placeholder@127.0.0.1:1/placeholder'), {
        schema,
        casing: 'snake_case',
      });
    }
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
