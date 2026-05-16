import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as authSchema from './schema/auth.js';
import * as ledgerSchema from './schema/ledger.js';

const schema = { ...authSchema, ...ledgerSchema };

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
