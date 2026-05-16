import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadEnv } from '../config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = postgres(env.DATABASE_URL, { max: 1 });
  try {
    const db = drizzle(client);
    process.stdout.write(`applying migrations to ${redact(env.DATABASE_URL)}\n`);
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    process.stdout.write('migrations applied\n');
  } finally {
    await client.end({ timeout: 5 });
  }
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`migration failed: ${message}\n`);
  process.exit(1);
});
